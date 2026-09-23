import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Resolve relative to this compiled spec's own location (backend/dist/services/whatsapp-service/),
// not process.cwd(), which differs depending on whether the test runner was invoked from the repo
// root or with --prefix backend (cwd becomes backend/, which would double the "backend" segment).
const BACKEND_ROOT = path.join(__dirname, "..", "..", "..");
const TEST_DB_FILE = path.join(BACKEND_ROOT, "data", "db.identity-association.test.json");
const TEST_CHAT_DB_FILE = path.join(BACKEND_ROOT, "data", "whatsapp.identity-association.test.json");

process.env.NODE_ENV = "test";
process.env.JSON_DB_FILE = TEST_DB_FILE;
process.env.WHATSAPP_DB_FILE = TEST_CHAT_DB_FILE;
delete process.env.MONGO_URL;
delete process.env.MONGODB_URI;
delete process.env.WHATSAPP_ACCESS_TOKEN;
delete process.env.WHATSAPP_PHONE_NUMBER_ID;

const leadService = require("../lead-service/server") as typeof import("../lead-service/server");
const leadStore = require("../common/leadStore") as typeof import("../common/leadStore");
const chatStore = require("../common/chatStore") as typeof import("../common/chatStore");

function resetDb() {
  fs.mkdirSync(path.dirname(TEST_DB_FILE), { recursive: true });
  fs.writeFileSync(
    TEST_DB_FILE,
    JSON.stringify({ leads: [], activities: [], tasks: [], callLogs: [], customers: [], purchases: [] }, null, 2),
    "utf8"
  );
  fs.writeFileSync(TEST_CHAT_DB_FILE, JSON.stringify({ conversations: [], messages: [] }, null, 2), "utf8");
}

function cleanupDb() {
  if (fs.existsSync(TEST_DB_FILE)) fs.unlinkSync(TEST_DB_FILE);
  if (fs.existsSync(TEST_CHAT_DB_FILE)) fs.unlinkSync(TEST_CHAT_DB_FILE);
}

async function listenEphemeral(server: import("http").Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", (error?: Error) => (error ? reject(error) : resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server test non disponibile.");
  return address.port;
}

function closeServer(server: import("http").Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error?: Error) => (error ? reject(error) : resolve())));
}

async function postJson(baseUrl: string, path: string, body: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

async function getJson(baseUrl: string, path: string) {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, body: await response.json() };
}

async function patchJson(baseUrl: string, path: string, body: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
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

async function withServers<T>(fn: (leadUrl: string, waUrl: string, whatsappService: any) => Promise<T>): Promise<T> {
  const leadPort = await listenEphemeral(leadService.server);
  const leadUrl = `http://127.0.0.1:${leadPort}`;
  try {
    // whatsapp-service reads LEAD_SERVICE_URL into a top-level const at require time, so the env
    // var must be set (to the lead-service's just-assigned ephemeral port) before this require.
    process.env.LEAD_SERVICE_URL = leadUrl;
    delete require.cache[require.resolve("./server")];
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const whatsappService = require("./server");
    const waPort = await listenEphemeral(whatsappService.server);
    const waUrl = `http://127.0.0.1:${waPort}`;
    try {
      return await fn(leadUrl, waUrl, whatsappService);
    } finally {
      await closeServer(whatsappService.server);
    }
  } finally {
    await closeServer(leadService.server);
  }
}

async function createLead(leadUrl: string, overrides: Record<string, unknown> = {}) {
  const created = await postJson(leadUrl, "/leads", {
    fullName: "Cliente Test",
    phone: overrides.phone || `+39 3${Math.floor(Math.random() * 900000000 + 100000000)}`,
    ...overrides
  });
  assert.equal(created.status, 201, `creazione lead fallita: ${JSON.stringify(created.body)}`);
  return created.body as any;
}

async function closeLeadAsLost(leadUrl: string, leadId: string) {
  const interested = await postJson(leadUrl, `/leads/${leadId}/status`, { toStatus: "Contatto interessato" });
  assert.equal(interested.status, 200);
  const lost = await postJson(leadUrl, `/leads/${leadId}/status`, { toStatus: "Persa", lossReason: "fuori_budget" });
  assert.equal(lost.status, 200);
  return lost.body;
}

function buildInboundWebhookPayload(phone: string, text: string, messageId: string, contactName = "") {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ wa_id: phone, profile: { name: contactName } }],
              messages: [{ from: phone, id: messageId, type: "text", text: { body: text }, timestamp: String(Math.floor(Date.now() / 1000)) }]
            }
          }
        ]
      }
    ]
  };
}

function buildInboundMediaWebhookPayload(phone: string, messageId: string, mediaType: "image" | "document", media: Record<string, unknown>) {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ wa_id: phone, profile: { name: "" } }],
              messages: [
                {
                  from: phone,
                  id: messageId,
                  type: mediaType,
                  [mediaType]: media,
                  timestamp: String(Math.floor(Date.now() / 1000))
                }
              ]
            }
          }
        ]
      }
    ]
  };
}

async function main() {
  await runCase("numero normalizzato individua il Customer corretto anche con formattazioni diverse", async () => {
    await withServers(async (leadUrl, waUrl) => {
      const lead = await createLead(leadUrl, { phone: "+39 333 1112222" });
      const resolution = await getJson(leadUrl, `/internal/lead-association?phone=${encodeURIComponent("+39 333 1112222")}`);
      assert.equal(resolution.status, 200);
      assert.equal(resolution.body.customerId, lead.customerId);
    });
  });

  await runCase("customer con un solo lead attivo -> associazione corretta al primo messaggio inbound", async () => {
    await withServers(async (leadUrl, waUrl) => {
      const lead = await createLead(leadUrl, { phone: "+39 333 2223333" });
      const webhook = await postJson(waUrl, "/webhook", buildInboundWebhookPayload("393332223333", "Ciao", "wamid.first_1"));
      assert.equal(webhook.status, 200);
      assert.equal(webhook.body.messageCount, 1);

      const conversations = await getJson(waUrl, "/conversations");
      const conversation = conversations.body.find((c: any) => c.phone === "393332223333");
      assert.ok(conversation, "conversazione non trovata");
      assert.equal(conversation.leadId, lead.id);
      assert.equal(conversation.customerId, lead.customerId);
    });
  });

  await runCase("customer con lead chiuso + lead attivo -> usa il lead attivo, non quello chiuso", async () => {
    await withServers(async (leadUrl, waUrl) => {
      const phone = "+39 333 3334444";
      const closedLead = await createLead(leadUrl, { phone });
      await closeLeadAsLost(leadUrl, closedLead.id);
      // Recontact creates a fresh opportunity for the same Customer (booking-workflow behavior).
      const activeLead = await createLead(leadUrl, { phone });
      assert.notEqual(activeLead.id, closedLead.id);
      assert.equal(activeLead.customerId, closedLead.customerId);

      const webhook = await postJson(waUrl, "/webhook", buildInboundWebhookPayload("393333334444", "Sono di nuovo interessato", "wamid.active_1"));
      assert.equal(webhook.status, 200);

      const conversations = await getJson(waUrl, "/conversations");
      const conversation = conversations.body.find((c: any) => c.phone === "393333334444");
      assert.equal(conversation.leadId, activeLead.id, "deve usare il lead attivo, non quello chiuso");
    });
  });

  await runCase("customer con piu lead attivi -> nessuna scelta arbitraria (leadId resta null, customerId impostato)", async () => {
    await withServers(async (leadUrl, waUrl) => {
      // Through the public API, two genuinely independent OPEN leads for one Customer can't
      // normally coexist -- findLeadByContact merges any new inbound contact into an existing
      // open lead by design (this is what prevents duplicate active opportunities in the first
      // place). To exercise the real ambiguity branch, seed two open leads sharing a customerId
      // directly via leadStore, the way a data-quality edge case or a future bulk-import bug
      // could still produce one.
      const phone = "+39 333 4445555";
      // Establish the Customer through the normal API, keyed on this exact phone.
      const firstLead = await createLead(leadUrl, { phone });
      // Seed a second OPEN lead directly under the same customerId (any other phone -- resolution
      // looks up the Customer by phone once, then lists ALL of that Customer's leads regardless
      // of each lead's own phone value).
      const now = new Date().toISOString();
      const secondActiveLead = {
        id: leadStore.newId("lead"),
        fullName: "Cliente Test",
        phone: "+39 333 4445556",
        customerId: firstLead.customerId,
        status: "Contatto interessato",
        closingOutcome: "open",
        notes: "",
        documents: { items: [] },
        payments: { items: [] },
        callAttempts: 0,
        nextActionAt: null,
        createdAt: now,
        updatedAt: now
      };
      await leadStore.createLead(secondActiveLead, []);

      const resolution = await getJson(leadUrl, `/internal/lead-association?phone=${encodeURIComponent(phone)}`);
      assert.equal(resolution.status, 200);
      assert.equal(resolution.body.customerId, firstLead.customerId);
      assert.equal(resolution.body.leadId, null, "non deve scegliere arbitrariamente tra due lead attivi");
      assert.equal(resolution.body.ambiguous, true);
      assert.equal(resolution.body.candidateLeadIds.length, 2);

      // The conversation should still pick up the Customer, just not a specific lead.
      const webhook = await postJson(waUrl, "/webhook", buildInboundWebhookPayload("393334445555", "Salve", "wamid.ambiguous_1"));
      assert.equal(webhook.status, 200);
      const conversations = await getJson(waUrl, "/conversations");
      const conversation = conversations.body.find((c: any) => c.phone === "393334445555");
      assert.equal(conversation.customerId, firstLead.customerId);
      assert.equal(conversation.leadId, null, "la conversazione non deve collegarsi arbitrariamente a uno dei due lead");
    });
  });

  await runCase("conversation con leadId gia presente -> preservato anche se il customer avrebbe un altro lead attivo", async () => {
    await withServers(async (leadUrl, waUrl) => {
      const phone = "+39 333 5556666";
      const firstLead = await createLead(leadUrl, { phone });
      // Pin the conversation to firstLead explicitly (as if it had been claimed earlier).
      await chatStore.createOrUpdateConversation({ phone: "393335556666", customerName: "Cliente", leadId: firstLead.id, source: "whatsapp" });

      const webhook = await postJson(waUrl, "/webhook", buildInboundWebhookPayload("393335556666", "Domanda sulla mia pratica", "wamid.pinned_1"));
      assert.equal(webhook.status, 200);

      const conversations = await getJson(waUrl, "/conversations");
      const conversation = conversations.body.find((c: any) => c.phone === "393335556666");
      assert.equal(conversation.leadId, firstLead.id, "il leadId gia presente deve restare invariato");
      assert.equal(conversation.customerId, firstLead.customerId, "il customerId deve essere comunque compilato retroattivamente");
    });
  });

  await runCase("POST /conversations/ensure su una conversazione gia esistente non ne cambia il leadId (apertura da Pratica di un'altra pratica dello stesso Customer)", async () => {
    await withServers(async (leadUrl, waUrl) => {
      const phone = "+39 333 1112223";
      const firstLead = await createLead(leadUrl, { phone });
      await chatStore.createOrUpdateConversation({ phone, customerName: "Cliente", leadId: firstLead.id, customerId: firstLead.customerId, source: "whatsapp" });

      // A second, unrelated lead for the same Customer (simulates opening WhatsApp from a
      // different Pratica belonging to the same person).
      const now = new Date().toISOString();
      const otherLead = {
        id: leadStore.newId("lead"),
        fullName: "Cliente Test",
        phone: "+39 333 9998887",
        customerId: firstLead.customerId,
        status: "Contatto interessato",
        closingOutcome: "open",
        notes: "",
        documents: { items: [] },
        payments: { items: [] },
        callAttempts: 0,
        nextActionAt: null,
        createdAt: now,
        updatedAt: now
      };
      await leadStore.createLead(otherLead, []);

      const ensured = await postJson(waUrl, "/conversations/ensure", {
        phone,
        leadId: otherLead.id,
        customerId: firstLead.customerId,
        customerName: "Cliente"
      });
      assert.equal(ensured.status, 200);
      assert.equal(ensured.body.leadId, firstLead.id, "il leadId della conversazione esistente non deve essere sovrascritto dalla pratica che la apre");
    });
  });

  await runCase("POST /conversations/ensure crea una conversazione vuota quando il Customer non ne ha ancora una (Pratica -> WhatsApp, primo contatto)", async () => {
    await withServers(async (leadUrl, waUrl) => {
      const lead = await createLead(leadUrl, { phone: "+39 333 4442221" });
      const ensured = await postJson(waUrl, "/conversations/ensure", {
        phone: "+39 333 4442221",
        leadId: lead.id,
        customerId: lead.customerId,
        customerName: "Cliente Test"
      });
      assert.equal(ensured.status, 200);
      assert.equal(ensured.body.leadId, lead.id);
      assert.equal(ensured.body.customerId, lead.customerId);
      assert.equal(ensured.body.lastMessagePreview, "", "una conversazione appena inizializzata non ha ancora messaggi");

      const list = await getJson(waUrl, "/conversations");
      assert.ok(list.body.find((c: any) => c.id === ensured.body.id), "la conversazione appena creata deve comparire nell'elenco");
    });
  });

  await runCase("GET /conversations?customerId= restituisce solo la conversazione del Customer richiesto", async () => {
    await withServers(async (leadUrl, waUrl) => {
      const leadA = await createLead(leadUrl, { phone: "+39 333 5551110" });
      const leadB = await createLead(leadUrl, { phone: "+39 333 5551111" });
      await chatStore.createOrUpdateConversation({ phone: "+39 333 5551110", customerName: "A", leadId: leadA.id, customerId: leadA.customerId, source: "whatsapp" });
      await chatStore.createOrUpdateConversation({ phone: "+39 333 5551111", customerName: "B", leadId: leadB.id, customerId: leadB.customerId, source: "whatsapp" });

      const filtered = await getJson(waUrl, `/conversations?customerId=${encodeURIComponent(leadA.customerId)}`);
      assert.equal(filtered.status, 200);
      assert.equal(filtered.body.length, 1);
      assert.equal(filtered.body[0].customerId, leadA.customerId);
    });
  });

  await runCase("conversazione legacy senza customerId resta leggibile", async () => {
    await withServers(async (leadUrl, waUrl) => {
      const legacy = await chatStore.createOrUpdateConversation({ phone: "+39 388 7776655", customerName: "Legacy", leadId: null, source: "whatsapp" });
      assert.equal(legacy.customerId, null);
      const fetched = await getJson(waUrl, "/conversations");
      const found = fetched.body.find((c: any) => c.id === legacy.id);
      assert.ok(found, "la conversazione legacy deve restare leggibile");
      assert.equal(found.phone, "+39 388 7776655");
    });
  });

  await runCase("lo stesso providerMessageId non genera un messaggio duplicato (retry webhook)", async () => {
    await withServers(async (leadUrl, waUrl) => {
      const phone = "393336667777";
      await createLead(leadUrl, { phone: "+39 333 6667777" });
      const payload = buildInboundWebhookPayload(phone, "Messaggio ripetuto da Meta", "wamid.retry_1");
      const first = await postJson(waUrl, "/webhook", payload);
      assert.equal(first.body.messageCount, 1);
      const retry = await postJson(waUrl, "/webhook", payload);
      assert.equal(retry.body.messageCount, 0, "il retry non deve produrre un nuovo messaggio");

      const conversations = await getJson(waUrl, "/conversations");
      const conversation = conversations.body.find((c: any) => c.phone === phone);
      const messages = await getJson(waUrl, `/conversations/${conversation.id}/messages`);
      assert.equal(messages.body.messages.length, 1, "deve esistere un solo messaggio salvato");
      assert.equal(conversation.unreadCount, 1, "il retry non deve incrementare nuovamente il contatore non letti");
    });
  });

  await runCase("lo storico conversazione resta consultabile dopo la chiusura della reply window (finestra 24h != storico)", async () => {
    await withServers(async (leadUrl, waUrl) => {
      const phone = "393337778888";
      await createLead(leadUrl, { phone: "+39 333 7778888" });
      await postJson(waUrl, "/webhook", buildInboundWebhookPayload(phone, "Messaggio prima della scadenza finestra", "wamid.history_1"));
      const conversations = await getJson(waUrl, "/conversations");
      const conversation = conversations.body.find((c: any) => c.phone === phone);
      assert.ok(conversation.hasOpenSession);

      // Force the reply window into the past, as if 24h had elapsed -- history/consultability
      // must not depend on this, only the ability to send free text does.
      await chatStore.updateConversation(conversation.id, { replyWindowExpiresAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() });

      const afterExpiry = await getJson(waUrl, "/conversations");
      const expiredConversation = afterExpiry.body.find((c: any) => c.id === conversation.id);
      assert.equal(expiredConversation.hasOpenSession, false, "la finestra deve risultare chiusa");
      assert.ok(afterExpiry.body.some((c: any) => c.id === conversation.id), "la conversazione deve restare nell'elenco anche a finestra chiusa");

      const messages = await getJson(waUrl, `/conversations/${conversation.id}/messages`);
      assert.equal(messages.status, 200);
      assert.equal(messages.body.messages.length, 1, "lo storico messaggi deve restare leggibile a finestra chiusa");

      const blockedSend = await postJson(waUrl, "/messages/send", { conversationId: conversation.id, mode: "text", text: "Messaggio libero fuori finestra" });
      assert.equal(blockedSend.status, 400, "a finestra chiusa il testo libero deve essere rifiutato (serve un template), non l'intera conversazione");
    });
  });

  await runCase("la reply window viene calcolata correttamente (24h da lastInboundAt)", async () => {
    await withServers(async (leadUrl, waUrl) => {
      const phone = "393338889999";
      await createLead(leadUrl, { phone: "+39 333 8889999" });
      const before = Date.now();
      await postJson(waUrl, "/webhook", buildInboundWebhookPayload(phone, "Ciao", "wamid.window_1"));
      const conversations = await getJson(waUrl, "/conversations");
      const conversation = conversations.body.find((c: any) => c.phone === phone);
      assert.ok(conversation.hasOpenSession, "la finestra di risposta deve risultare aperta subito dopo un inbound");
      const expiresAtMs = new Date(conversation.replyWindowExpiresAt).getTime();
      const deltaHours = (expiresAtMs - before) / (60 * 60 * 1000);
      assert.ok(deltaHours > 23.9 && deltaHours < 24.1, `atteso ~24h, ottenuto ${deltaHours}h`);
    });
  });

  await runCase("invio outbound simulato funziona senza credenziali Meta (nessun QR/sessione necessari)", async () => {
    await withServers(async (leadUrl, waUrl) => {
      const phone = "+39 333 1230000";
      await createLead(leadUrl, { phone });
      const send = await postJson(waUrl, "/messages/send", { to: "393331230000", mode: "text", text: "Messaggio di test", agentName: "operatore" });
      assert.equal(send.status, 200);
      assert.equal(send.body.simulated, true, "senza WHATSAPP_ACCESS_TOKEN/PHONE_NUMBER_ID l'invio deve essere simulato, non fallire");
      assert.ok(send.body.message.providerMessageId.startsWith("sim_"));
    });
  });

  await runCase("il webhook rifiuta una richiesta con firma X-Hub-Signature-256 mancante o non valida quando WHATSAPP_APP_SECRET e configurato", async () => {
    process.env.WHATSAPP_APP_SECRET = "test_app_secret";
    try {
      await withServers(async (leadUrl, waUrl) => {
        const payload = buildInboundWebhookPayload("393339990000", "Ciao", "wamid.sig_1");
        const rawBody = JSON.stringify(payload);

        const missingSignature = await fetch(`${waUrl}/webhook`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: rawBody
        });
        assert.equal(missingSignature.status, 401, "senza firma la richiesta deve essere rifiutata");

        const wrongSignature = await fetch(`${waUrl}/webhook`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Hub-Signature-256": "sha256=0000000000000000000000000000000000000000000000000000000000000000" },
          body: rawBody
        });
        assert.equal(wrongSignature.status, 401, "una firma errata deve essere rifiutata");

        const conversations = await getJson(waUrl, "/conversations");
        assert.equal(conversations.body.find((c: any) => c.phone === "393339990000"), undefined, "un webhook non verificato non deve creare alcuna conversazione");
      });
    } finally {
      delete process.env.WHATSAPP_APP_SECRET;
    }
  });

  await runCase("il webhook accetta una richiesta con firma X-Hub-Signature-256 valida quando WHATSAPP_APP_SECRET e configurato", async () => {
    process.env.WHATSAPP_APP_SECRET = "test_app_secret";
    try {
      await withServers(async (leadUrl, waUrl) => {
        await createLead(leadUrl, { phone: "+39 333 9991111" });
        const payload = buildInboundWebhookPayload("393339991111", "Ciao con firma valida", "wamid.sig_2");
        const rawBody = JSON.stringify(payload);
        const signature = `sha256=${crypto.createHmac("sha256", "test_app_secret").update(rawBody, "utf8").digest("hex")}`;

        const response = await fetch(`${waUrl}/webhook`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signature },
          body: rawBody
        });
        assert.equal(response.status, 200);
        const conversations = await getJson(waUrl, "/conversations");
        assert.ok(conversations.body.find((c: any) => c.phone === "393339991111"), "un webhook con firma valida deve essere elaborato normalmente");
      });
    } finally {
      delete process.env.WHATSAPP_APP_SECRET;
    }
  });

  await runCase("customer action RICONTATTAMI: crea activity e task senza inventare data/ora", async () => {
    await withServers(async (leadUrl, waUrl) => {
      const lead = await createLead(leadUrl, { phone: "+39 333 0011001" });
      const action = await postJson(waUrl, "/customer-actions", { phone: "+39 333 0011001", action: "callback_request" });
      assert.equal(action.status, 200);
      assert.equal(action.body.leadId, lead.id);

      const leadDetail = await getJson(leadUrl, `/leads/${lead.id}`);
      // Activities land in the timeline, fetched via the detail endpoint.
      const activity = (leadDetail.body.timeline || []).find((item: any) => item.type === "whatsapp_customer_action");
      assert.ok(activity, "deve essere stata creata un'activity per la richiesta di richiamo");

      const tasks = await getJson(leadUrl, `/tasks?leadId=${lead.id}`);
      const task = tasks.body.find((t: any) => t.kind === "callback_reminder" && t.source === "whatsapp_customer_action");
      assert.ok(task, "deve essere stato creato un task di richiamo");
      assert.equal(task.dueAt, null, "nessuna data/ora deve essere inventata: il task deve restare senza dueAt");
    });
  });

  await runCase("customer action NON INTERESSATO: crea activity e task di revisione, non chiude automaticamente il lead", async () => {
    await withServers(async (leadUrl, waUrl) => {
      const lead = await createLead(leadUrl, { phone: "+39 333 0011002" });
      const action = await postJson(waUrl, "/customer-actions", { phone: "+39 333 0011002", action: "not_interested" });
      assert.equal(action.status, 200);

      const leadDetail = await getJson(leadUrl, `/leads/${lead.id}`);
      assert.equal(leadDetail.body.lead.status, "Da contattare", "il lead non deve essere chiuso automaticamente da un singolo segnale WhatsApp");
      assert.equal(leadDetail.body.lead.closingOutcome, "open");

      const tasks = await getJson(leadUrl, `/tasks?leadId=${lead.id}`);
      const task = tasks.body.find((t: any) => t.kind === "customer_not_interested_review");
      assert.ok(task, "deve essere creato un task di revisione operatore, non una chiusura automatica");
    });
  });

  await runCase("customer action non riconosciuta viene rifiutata (400)", async () => {
    await withServers(async (leadUrl, waUrl) => {
      const action = await postJson(waUrl, "/customer-actions", { phone: "+39 333 0011003", action: "qualcosa_di_strano" });
      assert.equal(action.status, 400);
    });
  });

  await runCase("un tap su un bottone interattivo Meta con id riconosciuto attiva la stessa azione cliente (via webhook)", async () => {
    await withServers(async (leadUrl, waUrl) => {
      const phone = "393330011004";
      const lead = await createLead(leadUrl, { phone: "+39 333 0011004" });
      const payload = {
        entry: [
          {
            changes: [
              {
                value: {
                  contacts: [{ wa_id: phone, profile: { name: "" } }],
                  messages: [
                    {
                      from: phone,
                      id: "wamid.button_1",
                      type: "interactive",
                      interactive: { type: "button_reply", button_reply: { id: "action_callback_request", title: "Ricontattami" } },
                      timestamp: String(Math.floor(Date.now() / 1000))
                    }
                  ]
                }
              }
            ]
          }
        ]
      };
      const webhook = await postJson(waUrl, "/webhook", payload);
      assert.equal(webhook.status, 200);

      const tasks = await getJson(leadUrl, `/tasks?leadId=${lead.id}`);
      const task = tasks.body.find((t: any) => t.kind === "callback_reminder" && t.source === "whatsapp_customer_action");
      assert.ok(task, "il tap sul bottone interattivo deve generare lo stesso task della richiesta strutturata");
    });
  });

  await runCase("un messaggio inbound con immagine/documento salva i metadata dell'allegato (mediaId, mimeType, filename)", async () => {
    await withServers(async (leadUrl, waUrl) => {
      const phone = "393330004444";
      await createLead(leadUrl, { phone: "+39 333 0004444" });
      const payload = buildInboundMediaWebhookPayload(phone, "wamid.media_1", "document", {
        id: "media_abc123",
        mime_type: "application/pdf",
        sha256: "deadbeef",
        filename: "passaporto.pdf",
        caption: "Ecco il documento"
      });
      const webhook = await postJson(waUrl, "/webhook", payload);
      assert.equal(webhook.status, 200);
      assert.equal(webhook.body.messageCount, 1);

      const conversations = await getJson(waUrl, "/conversations");
      const conversation = conversations.body.find((c: any) => c.phone === phone);
      const messages = await getJson(waUrl, `/conversations/${conversation.id}/messages`);
      const stored = messages.body.messages[0];
      assert.equal(stored.attachment.mediaType, "document");
      assert.equal(stored.attachment.mediaId, "media_abc123");
      assert.equal(stored.attachment.mimeType, "application/pdf");
      assert.equal(stored.attachment.filename, "passaporto.pdf");
      assert.equal(stored.attachment.direction, "inbound");
    });
  });

  await runCase("un messaggio inbound di solo testo non genera metadata di allegato (attachment resta null)", async () => {
    await withServers(async (leadUrl, waUrl) => {
      const phone = "393330005555";
      await createLead(leadUrl, { phone: "+39 333 0005555" });
      await postJson(waUrl, "/webhook", buildInboundWebhookPayload(phone, "Solo testo, nessun allegato", "wamid.notext_1"));
      const conversations = await getJson(waUrl, "/conversations");
      const conversation = conversations.body.find((c: any) => c.phone === phone);
      const messages = await getJson(waUrl, `/conversations/${conversation.id}/messages`);
      assert.equal(messages.body.messages[0].attachment, null);
    });
  });

  await runCase("invio outbound di un allegato fuori dalla finestra 24h viene rifiutato (nessun bypass del vincolo Meta)", async () => {
    await withServers(async (leadUrl, waUrl) => {
      const phone = "393330006666";
      await createLead(leadUrl, { phone: "+39 333 0006666" });
      // No inbound message yet -> no open session, so a bare conversationId-less send has no
      // conversation to check hasOpenSession against; create one explicitly with a closed window.
      const conversation = await chatStore.createOrUpdateConversation({
        phone,
        customerName: "Cliente",
        source: "whatsapp",
        replyWindowExpiresAt: new Date(Date.now() - 60 * 60 * 1000).toISOString()
      });
      const send = await postJson(waUrl, "/messages/send", {
        conversationId: conversation.id,
        mode: "attachment",
        attachment: { url: "https://example.invalid/doc.pdf", filename: "documento.pdf", mimeType: "application/pdf" }
      });
      assert.equal(send.status, 400, "un allegato fuori finestra deve essere rifiutato esattamente come il testo libero");
    });
  });

  await runCase("invio outbound di un allegato dentro la finestra 24h funziona in modalita simulata (nessuna credenziale Meta reale)", async () => {
    await withServers(async (leadUrl, waUrl) => {
      const phone = "393330007777";
      await createLead(leadUrl, { phone: "+39 333 0007777" });
      await postJson(waUrl, "/webhook", buildInboundWebhookPayload(phone, "Ciao, serve un documento", "wamid.attctx_1"));
      const conversations = await getJson(waUrl, "/conversations");
      const conversation = conversations.body.find((c: any) => c.phone === phone);
      assert.ok(conversation.hasOpenSession);

      const send = await postJson(waUrl, "/messages/send", {
        conversationId: conversation.id,
        mode: "attachment",
        agentName: "operatore1",
        attachment: { url: "https://example.invalid/preventivo.pdf", filename: "preventivo.pdf", mimeType: "application/pdf", storageKey: "lead-documents/lead_x/quote/doc-preventivo.pdf" }
      });
      assert.equal(send.status, 200);
      assert.equal(send.body.simulated, true, "senza credenziali Meta reali l'invio deve essere simulato, non fallire");
      assert.equal(send.body.message.attachment.filename, "preventivo.pdf");
      assert.equal(send.body.message.attachment.documentStorageKey, "lead-documents/lead_x/quote/doc-preventivo.pdf");

      const messages = await getJson(waUrl, `/conversations/${conversation.id}/messages`);
      const outbound = messages.body.messages.find((m: any) => m.direction === "outbound");
      assert.ok(outbound.attachment, "l'allegato deve restare nello storico della conversazione");
    });
  });

  await runCase("una conversazione non assegnata e visibile a qualunque operatore e puo essere reclamata (claim)", async () => {
    await withServers(async (leadUrl, waUrl) => {
      const phone = "393330001111";
      await createLead(leadUrl, { phone: "+39 333 0001111" });
      await postJson(waUrl, "/webhook", buildInboundWebhookPayload(phone, "Ciao, ho una domanda", "wamid.claim_1"));
      const list = await getJson(waUrl, "/conversations");
      const conversation = list.body.find((c: any) => c.phone === phone);
      assert.equal(conversation.assignedTo, "", "una conversazione nuova deve arrivare non assegnata");

      const claimed = await patchJson(waUrl, `/conversations/${conversation.id}`, { assignedTo: "operatore1" });
      assert.equal(claimed.status, 200);
      assert.equal(claimed.body.assignedTo, "operatore1");
    });
  });

  await runCase("una conversazione reclamata puo essere riassegnata a un altro operatore (reassign)", async () => {
    await withServers(async (leadUrl, waUrl) => {
      const phone = "393330002222";
      await createLead(leadUrl, { phone: "+39 333 0002222" });
      await postJson(waUrl, "/webhook", buildInboundWebhookPayload(phone, "Ciao", "wamid.reassign_1"));
      const list = await getJson(waUrl, "/conversations");
      const conversation = list.body.find((c: any) => c.phone === phone);
      await patchJson(waUrl, `/conversations/${conversation.id}`, { assignedTo: "operatore1" });

      const reassigned = await patchJson(waUrl, `/conversations/${conversation.id}`, { assignedTo: "operatore2" });
      assert.equal(reassigned.status, 200);
      assert.equal(reassigned.body.assignedTo, "operatore2", "la riassegnazione deve sovrascrivere l'operatore precedente");
    });
  });

  await runCase("due operatori che leggono la stessa conversazione vedono lo stesso storico messaggi (nessuna perdita/partizionamento per operatore)", async () => {
    await withServers(async (leadUrl, waUrl) => {
      const phone = "393330003333";
      await createLead(leadUrl, { phone: "+39 333 0003333" });
      await postJson(waUrl, "/webhook", buildInboundWebhookPayload(phone, "Messaggio condiviso", "wamid.shared_1"));
      const list = await getJson(waUrl, "/conversations");
      const conversation = list.body.find((c: any) => c.phone === phone);

      const [viewA, viewB] = await Promise.all([
        getJson(waUrl, `/conversations/${conversation.id}/messages`),
        getJson(waUrl, `/conversations/${conversation.id}/messages`)
      ]);
      assert.equal(viewA.body.messages.length, 1);
      assert.equal(viewB.body.messages.length, 1);
      assert.equal(viewA.body.messages[0].id, viewB.body.messages[0].id, "entrambi gli operatori devono vedere esattamente lo stesso messaggio, non copie separate");
    });
  });

  await runCase("nessuna dipendenza WhatsApp non ufficiale (whatsapp-web.js/Baileys/puppeteer/QR) e presente nel backend", async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(BACKEND_ROOT, "package.json"), "utf8"));
    const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const forbidden = ["whatsapp-web.js", "baileys", "@whiskeysockets/baileys", "puppeteer", "puppeteer-core", "venom-bot", "wppconnect", "qrcode", "qrcode-terminal"];
    const found = forbidden.filter((name) => Object.prototype.hasOwnProperty.call(allDeps, name));
    assert.deepEqual(found, [], `dipendenze WhatsApp non ufficiali rilevate: ${found.join(", ")}`);
  });
}

main()
  .then(() => {
    cleanupDb();
    console.log("All identity-association checks passed.");
  })
  .catch((error) => {
    cleanupDb();
    console.error(error);
    process.exitCode = 1;
  });
