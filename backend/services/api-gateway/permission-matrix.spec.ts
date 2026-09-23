import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";

// Resolve relative to this compiled spec's own location (backend/dist/services/api-gateway/),
// not process.cwd(), which differs depending on whether the test runner was invoked from the repo
// root or with --prefix backend (cwd becomes backend/, which would double the "backend" segment).
const BACKEND_ROOT = path.join(__dirname, "..", "..", "..");
const TEST_DB_FILE = path.join(BACKEND_ROOT, "data", "db.permission-matrix.test.json");

process.env.NODE_ENV = "test";
process.env.JSON_DB_FILE = TEST_DB_FILE;
delete process.env.MONGO_URL;
delete process.env.MONGODB_URI;

const leadService = require("../lead-service/server") as typeof import("../lead-service/server");
const leadStore = require("../common/leadStore") as typeof import("../common/leadStore");

function resetDb() {
  fs.mkdirSync(path.dirname(TEST_DB_FILE), { recursive: true });
  fs.writeFileSync(
    TEST_DB_FILE,
    JSON.stringify({ leads: [], activities: [], tasks: [], callLogs: [], customers: [], purchases: [] }, null, 2),
    "utf8"
  );
}

function cleanupDb() {
  if (fs.existsSync(TEST_DB_FILE)) fs.unlinkSync(TEST_DB_FILE);
}

function listenEphemeral(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", (error?: Error) => {
      if (error) return reject(error);
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Server test non disponibile."));
      resolve(address.port);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error?: Error) => (error ? reject(error) : resolve())));
}

async function apiRequest(baseUrl: string, method: string, requestPath: string, options: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  let bodyPayload: string | undefined;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    bodyPayload = JSON.stringify(options.body);
  }
  const response = await fetch(`${baseUrl}${requestPath}`, { method, headers, body: bodyPayload });
  const raw = await response.text();
  let parsed: any = {};
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { raw };
    }
  }
  return { status: response.status, body: parsed };
}

async function createLead(leadUrl: string, overrides: Record<string, unknown> = {}) {
  const created = await apiRequest(leadUrl, "POST", "/leads", {
    body: {
      fullName: "Cliente Test",
      phone: `+39 3${Math.floor(Math.random() * 900000000 + 100000000)}`,
      ...overrides
    }
  });
  assert.equal(created.status, 201, `creazione lead fallita: ${JSON.stringify(created.body)}`);
  return created.body as any;
}

async function seedLeadWithStatus(status: string) {
  const now = new Date().toISOString();
  const lead = {
    id: leadStore.newId("lead"),
    fullName: "Cliente Test",
    phone: `+39 3${Math.floor(Math.random() * 900000000 + 100000000)}`,
    status,
    closingOutcome: "won",
    notes: "",
    documents: { items: [] },
    payments: { items: [] },
    callAttempts: 0,
    nextActionAt: null,
    createdAt: now,
    updatedAt: now
  };
  return leadStore.createLead(lead, []);
}

function makeSession(gateway: any, role: "operatore" | "admin" | "super_admin" = "operatore") {
  const token = `test_${role}_${Math.random().toString(36).slice(2, 10)}`;
  gateway.__setTestSession(token, {
    id: `user_${role}`,
    username: `${role}_user`,
    name: `${role} Test`,
    role
  });
  return token;
}

async function runCase(name: string, fn: () => Promise<void>) {
  resetDb();
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function withServers<T>(fn: (leadUrl: string, gatewayUrl: string, gateway: any) => Promise<T>): Promise<T> {
  const leadPort = await listenEphemeral(leadService.server);
  const leadUrl = `http://127.0.0.1:${leadPort}`;
  try {
    // Both analytics-service and api-gateway read LEAD_SERVICE_URL (and api-gateway also
    // ANALYTICS_SERVICE_URL) into top-level consts at require time, so each must be (re-)required
    // fresh, in dependency order, only after the env var it needs is set to this test's actual
    // ephemeral port -- requiring analytics-service once at file scope (before any port is known)
    // was the bug here: it would permanently keep the default LEAD_SERVICE_URL and every export
    // call would fail with "fetch failed" against a port nothing listens on.
    process.env.LEAD_SERVICE_URL = leadUrl;
    delete require.cache[require.resolve("../analytics-service/server")];
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const analyticsService = require("../analytics-service/server");
    const analyticsPort = await listenEphemeral(analyticsService.server);
    try {
      process.env.ANALYTICS_SERVICE_URL = `http://127.0.0.1:${analyticsPort}`;
      delete require.cache[require.resolve("./server")];
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const gateway = require("./server");
      const gatewayPort = await listenEphemeral(gateway.server);
      const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
      try {
        return await fn(leadUrl, gatewayUrl, gateway);
      } finally {
        await closeServer(gateway.server);
      }
    } finally {
      await closeServer(analyticsService.server);
    }
  } finally {
    await closeServer(leadService.server);
  }
}

// Matches the exact ADMIN/OPERATOR split Mauro asked for -- verified against the api-gateway's
// real routes (not hardcoded per-user, per role only) rather than assumed from the spec text.
async function main() {
  await runCase("operatore non puo creare utenti (POST /api/users)", async () => {
    await withServers(async (leadUrl, gatewayUrl, gateway) => {
      const token = makeSession(gateway, "operatore");
      const res = await apiRequest(gatewayUrl, "POST", "/api/users", {
        token,
        body: { username: "nuovo", email: "nuovo@example.com", name: "Nuovo", password: "password123", role: "operatore" }
      });
      assert.equal(res.status, 403);
    });
  });

  await runCase("admin non viene bloccato dal permission gate su POST /api/users (puo gestire utenti)", async () => {
    await withServers(async (leadUrl, gatewayUrl, gateway) => {
      const token = makeSession(gateway, "admin");
      const res = await apiRequest(gatewayUrl, "POST", "/api/users", {
        token,
        body: { username: "nuovo", email: "nuovo@example.com", name: "Nuovo", password: "password123", role: "operatore" }
      });
      assert.notEqual(res.status, 403, "un admin non deve essere bloccato dal permission gate su questa rotta");
    });
  });

  await runCase("operatore non puo modificare utenti (PUT /api/users/:username)", async () => {
    await withServers(async (leadUrl, gatewayUrl, gateway) => {
      const token = makeSession(gateway, "operatore");
      const res = await apiRequest(gatewayUrl, "PUT", "/api/users/qualcuno", { token, body: { name: "X" } });
      assert.equal(res.status, 403);
    });
  });

  await runCase("operatore non puo eliminare utenti (DELETE /api/users/:username)", async () => {
    await withServers(async (leadUrl, gatewayUrl, gateway) => {
      const token = makeSession(gateway, "operatore");
      const res = await apiRequest(gatewayUrl, "DELETE", "/api/users/qualcuno", { token });
      assert.equal(res.status, 403);
    });
  });

  await runCase("operatore non puo usare l'import lead (preview)", async () => {
    await withServers(async (leadUrl, gatewayUrl, gateway) => {
      const token = makeSession(gateway, "operatore");
      const res = await apiRequest(gatewayUrl, "POST", "/api/lead-import/preview", { token, body: { source: "excel", status: "Da contattare", leads: [] } });
      assert.equal(res.status, 403);
    });
  });

  await runCase("admin puo usare l'import lead (preview)", async () => {
    await withServers(async (leadUrl, gatewayUrl, gateway) => {
      const token = makeSession(gateway, "admin");
      const res = await apiRequest(gatewayUrl, "POST", "/api/lead-import/preview", { token, body: { source: "excel", status: "Da contattare", leads: [] } });
      assert.equal(res.status, 200);
      assert.ok(res.body.summary, "un admin deve ricevere una preview valida");
    });
  });

  await runCase("operatore non puo applicare l'import lead", async () => {
    await withServers(async (leadUrl, gatewayUrl, gateway) => {
      const token = makeSession(gateway, "operatore");
      const res = await apiRequest(gatewayUrl, "POST", "/api/lead-import/apply", { token, body: { source: "excel", status: "Da contattare", leads: [] } });
      assert.equal(res.status, 403);
    });
  });

  await runCase("operatore non puo esportare Marketing Export (CSV)", async () => {
    await withServers(async (leadUrl, gatewayUrl, gateway) => {
      const token = makeSession(gateway, "operatore");
      const res = await apiRequest(gatewayUrl, "GET", "/api/analytics/export/marketing/csv?mode=internal", { token });
      assert.equal(res.status, 403);
    });
  });

  await runCase("admin puo esportare Marketing Export (CSV)", async () => {
    await withServers(async (leadUrl, gatewayUrl, gateway) => {
      const token = makeSession(gateway, "admin");
      const res = await apiRequest(gatewayUrl, "GET", "/api/analytics/export/marketing/csv?mode=internal", { token });
      assert.equal(res.status, 200);
    });
  });

  await runCase("operatore non puo chiudere definitivamente una pratica (POST /api/leads/:id/status Chiusa 100%)", async () => {
    await withServers(async (leadUrl, gatewayUrl, gateway) => {
      const lead = await seedLeadWithStatus("Pronta per chiusura");
      const token = makeSession(gateway, "operatore");
      const res = await apiRequest(gatewayUrl, "POST", `/api/leads/${lead.id}/status`, { token, body: { toStatus: "Chiusa 100%" } });
      assert.equal(res.status, 403);
    });
  });

  await runCase("admin puo chiudere definitivamente una pratica", async () => {
    await withServers(async (leadUrl, gatewayUrl, gateway) => {
      const lead = await seedLeadWithStatus("Pronta per chiusura");
      const token = makeSession(gateway, "admin");
      const res = await apiRequest(gatewayUrl, "POST", `/api/leads/${lead.id}/status`, { token, body: { toStatus: "Chiusa 100%" } });
      assert.equal(res.status, 200);
    });
  });

  await runCase("operatore non puo modificare una pratica pronta per la chiusura (PATCH generico)", async () => {
    await withServers(async (leadUrl, gatewayUrl, gateway) => {
      const lead = await seedLeadWithStatus("Pronta per chiusura");
      const token = makeSession(gateway, "operatore");
      const res = await apiRequest(gatewayUrl, "PATCH", `/api/leads/${lead.id}`, { token, body: { notes: "tentativo operatore" } });
      assert.equal(res.status, 403);
    });
  });

  await runCase("operatore puo lavorare normalmente su lead/pratiche non bloccate (creazione, lettura)", async () => {
    await withServers(async (leadUrl, gatewayUrl, gateway) => {
      const token = makeSession(gateway, "operatore");
      const created = await apiRequest(gatewayUrl, "POST", "/api/leads", { token, body: { fullName: "Cliente Operatore", phone: "+39 333 1112233" } });
      assert.equal(created.status, 201, "un operatore deve poter creare un nuovo lead");
      const listed = await apiRequest(gatewayUrl, "GET", "/api/leads", { token });
      assert.equal(listed.status, 200, "un operatore deve poter leggere l'elenco lead");
    });
  });

  await runCase("operatore ha accesso alla inbox WhatsApp condivisa (nessuna restrizione per ruolo sulla lettura)", async () => {
    // This file doesn't stand up a real whatsapp-service instance (that full downstream flow is
    // exercised in identity-association.spec.ts), so a working request may still 502 once past
    // the gateway. What this test asserts is narrower and specific to the permission matrix: the
    // route is never blocked by the role check itself (403) for an authenticated operator.
    await withServers(async (leadUrl, gatewayUrl, gateway) => {
      const token = makeSession(gateway, "operatore");
      const res = await apiRequest(gatewayUrl, "GET", "/api/whatsapp/conversations", { token });
      assert.notEqual(res.status, 403, "la inbox WhatsApp e condivisa per design: nessun operatore autenticato deve essere bloccato dal permission gate");
      assert.notEqual(res.status, 401, "un operatore autenticato non deve risultare non autorizzato");
    });
  });

  await runCase("operatore non puo consultare il report attivita Booking", async () => {
    await withServers(async (leadUrl, gatewayUrl, gateway) => {
      const token = makeSession(gateway, "operatore");
      const res = await apiRequest(gatewayUrl, "GET", "/api/report/booking-activities", { token });
      assert.equal(res.status, 403);
    });
  });

  await runCase("admin puo consultare il report attivita Booking ed esportarlo in CSV con i dati reali collegati", async () => {
    await withServers(async (leadUrl, gatewayUrl, gateway) => {
      const lead = await createLead(leadUrl, { fullName: "Cliente Booking Report", assignedTo: "operatore1", sourceCampaignId: "camp_test" });
      const call = await apiRequest(leadUrl, "POST", `/leads/${lead.id}/calls`, {
        body: { disposition: "interested", actor: "operatore1", idempotencyKey: `report_test_${lead.id}` }
      });
      assert.equal(call.status, 200, JSON.stringify(call.body));

      const token = makeSession(gateway, "admin");
      const preview = await apiRequest(gatewayUrl, "GET", "/api/report/booking-activities", { token });
      assert.equal(preview.status, 200);
      const row = preview.body.rows.find((r: any) => r.leadId === lead.id);
      assert.ok(row, "la riga per la chiamata appena registrata deve comparire nel report");
      assert.equal(row.operatore, "operatore1");
      assert.equal(row.cliente, "Cliente Booking Report");
      assert.equal(row.campagna, "camp_test");

      const csv = await apiRequest(gatewayUrl, "GET", "/api/report/booking-activities/csv", { token });
      assert.equal(csv.status, 200);
      assert.ok(String(csv.body.raw || "").includes("Cliente Booking Report"), "il CSV esportato deve contenere la riga appena creata");
    });
  });

  await runCase("richieste non autenticate sono rifiutate su tutte le rotte amministrative", async () => {
    await withServers(async (leadUrl, gatewayUrl) => {
      const usersRes = await apiRequest(gatewayUrl, "POST", "/api/users", { body: { username: "x", email: "x@example.com", name: "X", password: "password123" } });
      assert.equal(usersRes.status, 401);
      const exportRes = await apiRequest(gatewayUrl, "GET", "/api/analytics/export/marketing/csv?mode=internal");
      assert.equal(exportRes.status, 401);
      const importRes = await apiRequest(gatewayUrl, "POST", "/api/lead-import/preview", { body: { source: "excel", status: "Da contattare", leads: [] } });
      assert.equal(importRes.status, 401);
      const reportRes = await apiRequest(gatewayUrl, "GET", "/api/report/booking-activities");
      assert.equal(reportRes.status, 401);
    });
  });
}

main()
  .then(() => {
    cleanupDb();
    console.log("All permission-matrix checks passed.");
  })
  .catch((error) => {
    cleanupDb();
    console.error(error);
    process.exitCode = 1;
  });
