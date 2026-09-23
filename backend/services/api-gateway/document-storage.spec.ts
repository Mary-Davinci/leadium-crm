import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";

// Resolve relative to this compiled spec's own location (backend/dist/services/api-gateway/),
// not process.cwd(), which differs depending on whether the test runner was invoked from the repo
// root or with --prefix backend (cwd becomes backend/, which would double the "backend" segment).
const BACKEND_ROOT = path.join(__dirname, "..", "..", "..");
const TEST_DB_FILE = path.join(BACKEND_ROOT, "data", "db.document-storage.test.json");

process.env.NODE_ENV = "test";
process.env.JSON_DB_FILE = TEST_DB_FILE;
delete process.env.MONGO_URL;
delete process.env.MONGODB_URI;
process.env.DOCUMENT_UPLOAD_MAX_BYTES = String(1024 * 1024);

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

// Stands in for Backblaze B2 (S3-compatible): accepts the PUT/DELETE the AWS SDK issues so
// createSignedUpload/uploadDocumentBuffer/deleteStoredObject exercise real signing and a real
// HTTP round trip, without ever touching a real bucket or requiring network access.
function createFakeS3Server(): Promise<{ server: http.Server; port: number; requests: Array<{ method: string; url: string; bodyLength: number }> }> {
  const requests: Array<{ method: string; url: string; bodyLength: number }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      requests.push({ method: req.method || "", url: req.url || "", bodyLength: body.length });
      if (req.method === "PUT") {
        res.writeHead(200, { ETag: '"fake-etag"' });
        res.end();
        return;
      }
      if (req.method === "DELETE") {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", (error?: Error) => {
      if (error) return reject(error);
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Fake S3 server non disponibile."));
      resolve({ server, port: address.port, requests });
    });
  });
}

async function apiRequest(
  baseUrl: string,
  method: string,
  requestPath: string,
  options: { token?: string; body?: unknown; rawBody?: Buffer; contentType?: string } = {}
) {
  const headers: Record<string, string> = {};
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  let bodyPayload: Buffer | string | undefined;
  if (options.rawBody !== undefined) {
    bodyPayload = options.rawBody;
    if (options.contentType) headers["Content-Type"] = options.contentType;
  } else if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    bodyPayload = JSON.stringify(options.body);
  }
  const response = await fetch(`${baseUrl}${requestPath}`, { method, headers, body: bodyPayload as BodyInit | undefined });
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
    // api-gateway reads LEAD_SERVICE_URL into a top-level const at require time, so it must be set
    // (to this test's just-assigned ephemeral lead-service port) before this require, and the
    // module cache cleared so it actually re-reads the env var instead of reusing a stale build.
    process.env.LEAD_SERVICE_URL = leadUrl;
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
    await closeServer(leadService.server);
  }
}

async function main() {
  const fakeS3 = await createFakeS3Server();
  process.env.BACKBLAZE_B2_ENDPOINT = `http://127.0.0.1:${fakeS3.port}`;
  process.env.BACKBLAZE_B2_REGION = "us-fake-1";
  process.env.BACKBLAZE_B2_BUCKET = "fake-bucket-test";
  process.env.BACKBLAZE_B2_KEY_ID = "fake-key-id";
  process.env.BACKBLAZE_B2_APPLICATION_KEY = "fake-application-key";
  process.env.BACKBLAZE_B2_PREFIX = "lead-documents-test";

  try {
    await runCase("upload valido genera un allegato coerente (storageKey, mimeType, size) nello storage fake locale", async () => {
      await withServers(async (leadUrl, gatewayUrl, gateway) => {
        const lead = await createLead(leadUrl);
        const token = makeSession(gateway, "operatore");
        const fileBuffer = Buffer.from("contenuto di test");
        const query = new URLSearchParams({ leadId: lead.id, documentKey: "identity_document", fileName: "carta_identita.pdf" });
        const upload = await apiRequest(gatewayUrl, "POST", `/api/document-storage/upload?${query.toString()}`, {
          token,
          rawBody: fileBuffer,
          contentType: "application/pdf"
        });
        assert.equal(upload.status, 200, JSON.stringify(upload.body));
        const attachment = upload.body.attachment;
        assert.equal(attachment.mimeType, "application/pdf");
        assert.equal(attachment.size, fileBuffer.length);
        assert.ok(String(attachment.storageKey).includes(lead.id), "storageKey deve contenere il leadId");
        assert.ok(String(attachment.storageKey).includes("identity_document"), "storageKey deve contenere il documentKey");
        assert.equal(attachment.storageProvider, "backblaze_b2");
        assert.equal(attachment.uploadedBy, "operatore_user");
        assert.equal(fakeS3.requests.some((r) => r.method === "PUT"), true, "l'SDK deve aver effettuato una PUT reale verso lo storage fake");
      });
    });

    await runCase("un file che supera il limite configurato viene rifiutato (413)", async () => {
      await withServers(async (leadUrl, gatewayUrl, gateway) => {
        const lead = await createLead(leadUrl);
        const token = makeSession(gateway, "operatore");
        const oversized = Buffer.alloc(Number(process.env.DOCUMENT_UPLOAD_MAX_BYTES) + 1024, 1);
        const query = new URLSearchParams({ leadId: lead.id, documentKey: "identity_document", fileName: "troppo_grande.pdf" });
        const upload = await apiRequest(gatewayUrl, "POST", `/api/document-storage/upload?${query.toString()}`, {
          token,
          rawBody: oversized,
          contentType: "application/pdf"
        });
        assert.equal(upload.status, 413);
      });
    });

    await runCase("un tipo MIME non consentito viene rifiutato (415)", async () => {
      await withServers(async (leadUrl, gatewayUrl, gateway) => {
        const lead = await createLead(leadUrl);
        const token = makeSession(gateway, "operatore");
        const query = new URLSearchParams({ leadId: lead.id, documentKey: "identity_document", fileName: "script.html" });
        const upload = await apiRequest(gatewayUrl, "POST", `/api/document-storage/upload?${query.toString()}`, {
          token,
          rawBody: Buffer.from("<script>alert(1)</script>"),
          contentType: "text/html"
        });
        assert.equal(upload.status, 415);
      });
    });

    await runCase("un leadId inesistente viene rifiutato quando si salvano i metadati del documento", async () => {
      await withServers(async (leadUrl) => {
        const response = await apiRequest(leadUrl, "PATCH", "/leads/lead_non_esistente_xyz", {
          body: { documents: { items: [{ key: "identity_document", received: true, verified: true, attachments: [] }] } }
        });
        assert.equal(response.status, 404);
      });
    });

    await runCase("due upload sullo stesso lead/documentKey generano storageKey diversi (nessuna collisione)", async () => {
      await withServers(async (leadUrl, gatewayUrl, gateway) => {
        const lead = await createLead(leadUrl);
        const token = makeSession(gateway, "operatore");
        const query = new URLSearchParams({ leadId: lead.id, documentKey: "identity_document", fileName: "doc.pdf" });
        const first = await apiRequest(gatewayUrl, "POST", `/api/document-storage/upload?${query.toString()}`, {
          token,
          rawBody: Buffer.from("uno"),
          contentType: "application/pdf"
        });
        const second = await apiRequest(gatewayUrl, "POST", `/api/document-storage/upload?${query.toString()}`, {
          token,
          rawBody: Buffer.from("due"),
          contentType: "application/pdf"
        });
        assert.equal(first.status, 200);
        assert.equal(second.status, 200);
        assert.notEqual(first.body.attachment.storageKey, second.body.attachment.storageKey);
      });
    });

    await runCase("l'allegato caricato e visibile nella pratica dopo il salvataggio dei metadati", async () => {
      await withServers(async (leadUrl, gatewayUrl, gateway) => {
        const lead = await createLead(leadUrl);
        const token = makeSession(gateway, "operatore");
        const query = new URLSearchParams({ leadId: lead.id, documentKey: "identity_document", fileName: "passaporto.pdf" });
        const upload = await apiRequest(gatewayUrl, "POST", `/api/document-storage/upload?${query.toString()}`, {
          token,
          rawBody: Buffer.from("documento"),
          contentType: "application/pdf"
        });
        assert.equal(upload.status, 200);
        const attachment = upload.body.attachment;
        const patch = await apiRequest(leadUrl, "PATCH", `/leads/${lead.id}`, {
          body: { documents: { items: [{ key: "identity_document", received: true, verified: true, attachments: [attachment] }] } }
        });
        assert.equal(patch.status, 200);
        const fetched = await apiRequest(leadUrl, "GET", `/leads/${lead.id}`);
        const item = fetched.body.lead.documents.items.find((i: any) => i.key === "identity_document");
        assert.ok(item, "documento non trovato nella pratica");
        assert.equal(item.attachments.length, 1);
        assert.equal(item.attachments[0].storageKey, attachment.storageKey);
        assert.equal(item.attachments[0].name, "passaporto.pdf");
      });
    });

    await runCase("la rimozione dell'allegato dai metadati lo elimina dalla pratica", async () => {
      await withServers(async (leadUrl, gatewayUrl, gateway) => {
        const lead = await createLead(leadUrl);
        const token = makeSession(gateway, "operatore");
        const query = new URLSearchParams({ leadId: lead.id, documentKey: "identity_document", fileName: "doc.pdf" });
        const upload = await apiRequest(gatewayUrl, "POST", `/api/document-storage/upload?${query.toString()}`, {
          token,
          rawBody: Buffer.from("x"),
          contentType: "application/pdf"
        });
        const attachment = upload.body.attachment;
        await apiRequest(leadUrl, "PATCH", `/leads/${lead.id}`, {
          body: { documents: { items: [{ key: "identity_document", received: true, verified: true, attachments: [attachment] }] } }
        });
        const patchRemove = await apiRequest(leadUrl, "PATCH", `/leads/${lead.id}`, {
          body: { documents: { items: [{ key: "identity_document", received: false, verified: false, attachments: [] }] } }
        });
        assert.equal(patchRemove.status, 200);
        const fetched = await apiRequest(leadUrl, "GET", `/leads/${lead.id}`);
        const item = fetched.body.lead.documents.items.find((i: any) => i.key === "identity_document");
        assert.equal(item.attachments.length, 0, "l'allegato deve essere stato rimosso dai metadati della pratica");
      });
    });

    await runCase("un allegato legacy con dataUrl (senza storageKey) resta leggibile e il dataUrl non viene rimosso", async () => {
      await withServers(async (leadUrl) => {
        const lead = await createLead(leadUrl);
        const legacyAttachment = {
          id: "doc_legacy_1",
          name: "vecchio.jpg",
          mimeType: "image/jpeg",
          size: 12345,
          dataUrl: "data:image/jpeg;base64,AAAA",
          uploadedAt: new Date().toISOString()
        };
        const patch = await apiRequest(leadUrl, "PATCH", `/leads/${lead.id}`, {
          body: { documents: { items: [{ key: "identity_document", received: true, verified: true, attachments: [legacyAttachment] }] } }
        });
        assert.equal(patch.status, 200);
        const fetched = await apiRequest(leadUrl, "GET", `/leads/${lead.id}`);
        const item = fetched.body.lead.documents.items.find((i: any) => i.key === "identity_document");
        assert.equal(item.attachments.length, 1);
        assert.equal(item.attachments[0].dataUrl, "data:image/jpeg;base64,AAAA", "il dataUrl legacy deve restare leggibile senza uno storageKey");
        assert.equal(item.attachments[0].storageKey, "");
      });
    });

    await runCase("le richieste non autenticate vengono rifiutate su tutte le rotte di document storage", async () => {
      await withServers(async (leadUrl, gatewayUrl) => {
        const lead = await createLead(leadUrl);
        const uploadQuery = new URLSearchParams({ leadId: lead.id, documentKey: "identity_document", fileName: "x.pdf" });
        const upload = await apiRequest(gatewayUrl, "POST", `/api/document-storage/upload?${uploadQuery.toString()}`, {
          rawBody: Buffer.from("x"),
          contentType: "application/pdf"
        });
        assert.equal(upload.status, 401);

        const presignUpload = await apiRequest(gatewayUrl, "POST", "/api/document-storage/presign-upload", {
          body: { leadId: lead.id, documentKey: "identity_document", fileName: "x.pdf", mimeType: "application/pdf", size: 10 }
        });
        assert.equal(presignUpload.status, 401);

        const presignDownload = await apiRequest(gatewayUrl, "POST", "/api/document-storage/presign-download", {
          body: { storageKey: "lead-documents-test/whatever" }
        });
        assert.equal(presignDownload.status, 401);

        const del = await apiRequest(gatewayUrl, "POST", "/api/document-storage/delete", {
          body: { storageKey: "lead-documents-test/whatever" }
        });
        assert.equal(del.status, 401);
      });
    });

    await runCase("un operatore non puo caricare documenti su una pratica pronta per la chiusura o chiusa; un admin puo", async () => {
      await withServers(async (leadUrl, gatewayUrl, gateway) => {
        const lockedLead = await seedLeadWithStatus("Pronta per chiusura");
        const operatoreToken = makeSession(gateway, "operatore");
        const adminToken = makeSession(gateway, "admin");
        const query = new URLSearchParams({ leadId: lockedLead.id, documentKey: "identity_document", fileName: "x.pdf" });

        const asOperatore = await apiRequest(gatewayUrl, "POST", `/api/document-storage/upload?${query.toString()}`, {
          token: operatoreToken,
          rawBody: Buffer.from("x"),
          contentType: "application/pdf"
        });
        assert.equal(asOperatore.status, 403, "un operatore non deve poter caricare documenti su una pratica pronta per la chiusura");

        const asAdmin = await apiRequest(gatewayUrl, "POST", `/api/document-storage/upload?${query.toString()}`, {
          token: adminToken,
          rawBody: Buffer.from("x"),
          contentType: "application/pdf"
        });
        assert.equal(asAdmin.status, 200, "un admin deve poter caricare documenti anche su una pratica pronta per la chiusura");
      });
    });

    await runCase("presign-download restituisce un URL firmato e applica lo stesso authorization gate dell'upload", async () => {
      await withServers(async (leadUrl, gatewayUrl, gateway) => {
        const lead = await createLead(leadUrl);
        const token = makeSession(gateway, "operatore");
        const query = new URLSearchParams({ leadId: lead.id, documentKey: "identity_document", fileName: "doc.pdf" });
        const upload = await apiRequest(gatewayUrl, "POST", `/api/document-storage/upload?${query.toString()}`, {
          token,
          rawBody: Buffer.from("x"),
          contentType: "application/pdf"
        });
        const download = await apiRequest(gatewayUrl, "POST", "/api/document-storage/presign-download", {
          token,
          body: { storageKey: upload.body.attachment.storageKey, fileName: "doc.pdf", leadId: lead.id }
        });
        assert.equal(download.status, 200);
        assert.ok(typeof download.body.url === "string" && download.body.url.length > 0, "deve restituire un URL firmato");
      });
    });

    // P1: authorization for an existing document must be derived from the storageKey itself, not
    // from a client-supplied leadId -- otherwise a caller can borrow ANY open lead's id (or omit
    // it) to read/delete a document that actually belongs to a locked practice.
    await runCase("presign-download: uno storageKey di una pratica bloccata resta bloccato anche dichiarando un leadId diverso e aperto", async () => {
      await withServers(async (leadUrl, gatewayUrl, gateway) => {
        const lockedLead = await seedLeadWithStatus("Pronta per chiusura");
        const openLead = await createLead(leadUrl);
        const adminToken = makeSession(gateway, "admin");
        const query = new URLSearchParams({ leadId: lockedLead.id, documentKey: "identity_document", fileName: "doc.pdf" });
        const upload = await apiRequest(gatewayUrl, "POST", `/api/document-storage/upload?${query.toString()}`, {
          token: adminToken,
          rawBody: Buffer.from("x"),
          contentType: "application/pdf"
        });
        assert.equal(upload.status, 200);
        const storageKey = upload.body.attachment.storageKey;

        const operatoreToken = makeSession(gateway, "operatore");
        const spoofed = await apiRequest(gatewayUrl, "POST", "/api/document-storage/presign-download", {
          token: operatoreToken,
          body: { storageKey, fileName: "doc.pdf", leadId: openLead.id }
        });
        assert.equal(spoofed.status, 403, "un leadId dichiarato diverso da quello reale del documento non deve bypassare il blocco");
      });
    });

    await runCase("presign-download: uno storageKey di una pratica bloccata resta bloccato anche omettendo leadId", async () => {
      await withServers(async (leadUrl, gatewayUrl, gateway) => {
        const lockedLead = await seedLeadWithStatus("Chiusa 100%");
        const adminToken = makeSession(gateway, "admin");
        const query = new URLSearchParams({ leadId: lockedLead.id, documentKey: "identity_document", fileName: "doc.pdf" });
        const upload = await apiRequest(gatewayUrl, "POST", `/api/document-storage/upload?${query.toString()}`, {
          token: adminToken,
          rawBody: Buffer.from("x"),
          contentType: "application/pdf"
        });
        assert.equal(upload.status, 200);
        const storageKey = upload.body.attachment.storageKey;

        const operatoreToken = makeSession(gateway, "operatore");
        const omitted = await apiRequest(gatewayUrl, "POST", "/api/document-storage/presign-download", {
          token: operatoreToken,
          body: { storageKey, fileName: "doc.pdf" }
        });
        assert.equal(omitted.status, 403, "omettere leadId non deve saltare il controllo: l'autorizzazione va derivata dallo storageKey");

        const deleteAttempt = await apiRequest(gatewayUrl, "POST", "/api/document-storage/delete", {
          token: operatoreToken,
          body: { storageKey }
        });
        assert.equal(deleteAttempt.status, 403, "la stessa protezione deve valere per la cancellazione");
      });
    });

    await runCase("presign-download: uno storageKey che punta a un lead inesistente viene rifiutato (404)", async () => {
      await withServers(async (leadUrl, gatewayUrl, gateway) => {
        const token = makeSession(gateway, "operatore");
        const ghostStorageKey = "lead-documents-test/lead_ghost_does_not_exist/identity_document/doc_1-ghost.pdf";
        const res = await apiRequest(gatewayUrl, "POST", "/api/document-storage/presign-download", {
          token,
          body: { storageKey: ghostStorageKey, fileName: "ghost.pdf" }
        });
        assert.equal(res.status, 404);
      });
    });

    await runCase("presign-download: una pratica aperta e accessibile resta scaricabile anche se il body dichiara un leadId diverso", async () => {
      await withServers(async (leadUrl, gatewayUrl, gateway) => {
        const openLead = await createLead(leadUrl);
        const otherOpenLead = await createLead(leadUrl);
        const token = makeSession(gateway, "operatore");
        const query = new URLSearchParams({ leadId: openLead.id, documentKey: "identity_document", fileName: "doc.pdf" });
        const upload = await apiRequest(gatewayUrl, "POST", `/api/document-storage/upload?${query.toString()}`, {
          token,
          rawBody: Buffer.from("x"),
          contentType: "application/pdf"
        });
        assert.equal(upload.status, 200);
        const download = await apiRequest(gatewayUrl, "POST", "/api/document-storage/presign-download", {
          token,
          body: { storageKey: upload.body.attachment.storageKey, fileName: "doc.pdf", leadId: otherOpenLead.id }
        });
        assert.equal(download.status, 200, "una pratica aperta resta accessibile: la correzione non deve introdurre falsi blocchi");
      });
    });
  } finally {
    await closeServer(fakeS3.server);
  }
}

main()
  .then(() => {
    cleanupDb();
    console.log("All document-storage checks passed.");
  })
  .catch((error) => {
    cleanupDb();
    console.error(error);
    process.exitCode = 1;
  });
