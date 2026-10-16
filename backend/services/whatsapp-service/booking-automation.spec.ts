import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const BACKEND_ROOT = path.join(__dirname, "..", "..", "..");
const TEST_DB_FILE = path.join(BACKEND_ROOT, "data", "db.booking-automation.test.json");
const TEST_CHAT_DB_FILE = path.join(BACKEND_ROOT, "data", "whatsapp.booking-automation.test.json");

process.env.NODE_ENV = "test";
process.env.JSON_DB_FILE = TEST_DB_FILE;
process.env.WHATSAPP_DB_FILE = TEST_CHAT_DB_FILE;
delete process.env.MONGO_URL;
delete process.env.MONGODB_URI;
delete process.env.WHATSAPP_ACCESS_TOKEN;
delete process.env.WHATSAPP_PHONE_NUMBER_ID;
delete process.env.WHATSAPP_APP_SECRET;
delete process.env.META_APP_SECRET;
delete process.env.WHATSAPP_AUTOMATION_ENABLED;

const leadService = require("../lead-service/server") as typeof import("../lead-service/server");
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

async function request(baseUrl: string, method: string, urlPath: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

async function withServers<T>(fn: (leadUrl: string, waUrl: string) => Promise<T>): Promise<T> {
  const leadPort = await listenEphemeral(leadService.server);
  const leadUrl = `http://127.0.0.1:${leadPort}`;
  try {
    process.env.LEAD_SERVICE_URL = leadUrl;
    delete require.cache[require.resolve("./server")];
    const whatsappService = require("./server");
    const waPort = await listenEphemeral(whatsappService.server);
    try {
      return await fn(leadUrl, `http://127.0.0.1:${waPort}`);
    } finally {
      await closeServer(whatsappService.server);
    }
  } finally {
    await closeServer(leadService.server);
  }
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

// A lead with a linked WhatsApp conversation, as the practice "WhatsApp" button creates it.
async function createLeadWithConversation(leadUrl: string, waUrl: string, extra: Record<string, unknown> = {}) {
  const digits = `393${Math.floor(Math.random() * 900000000 + 100000000)}`;
  const created = await request(leadUrl, "POST", "/leads", { fullName: "Cliente Booking", phone: `+${digits}` });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const lead = created.body as any;
  if (Object.keys(extra).length) {
    const patched = await request(leadUrl, "PATCH", `/leads/${lead.id}`, extra);
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
  }
  const conversation = await request(waUrl, "POST", "/conversations/ensure", { phone: digits, leadId: lead.id, customerName: "Cliente Booking" });
  assert.equal(conversation.status, 200);
  return { lead, conversation: conversation.body as any, digits };
}

function sendTemplate(waUrl: string, conversationId: string, templateKey: string, extra: Record<string, unknown> = {}) {
  return request(waUrl, "POST", "/messages/send", { conversationId, mode: "template", templateKey, agentName: "operatore1", ...extra });
}

async function templateMessages(conversationId: string) {
  return (await chatStore.listMessages(conversationId, 500)).filter((m: any) => m.messageType === "template");
}

async function leadTimeline(leadUrl: string, leadId: string) {
  return ((await request(leadUrl, "GET", `/leads/${leadId}`)).body as any).timeline as any[];
}

function inboundWebhook(from: string, id: string, text = "Ciao") {
  return {
    object: "whatsapp_business_account",
    entry: [{ changes: [{ value: { contacts: [{ wa_id: from, profile: { name: "Cliente" } }], messages: [{ id, from, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }] } }] }]
  };
}

async function main() {
  await runCase("primo contatto: inviato una volta, il secondo invio viene rifiutato", async () => {
    await withServers(async (leadUrl, waUrl) => {
      const { lead, conversation } = await createLeadWithConversation(leadUrl, waUrl, { productInterest: "Crociera Fiordi" });
      const first = await sendTemplate(waUrl, conversation.id, "lead_first_contact");
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.ok(first.body.message.text.includes("Crociera Fiordi"), "{{1}} sostituito nel testo salvato");
      assert.equal(first.body.message.trigger, "manual");
      assert.equal(first.body.message.leadId, lead.id);
      assert.deepEqual(first.body.message.templateParams, { destination: "Crociera Fiordi" });
      const second = await sendTemplate(waUrl, conversation.id, "lead_first_contact");
      assert.equal(second.status, 409);
      assert.equal(second.body.code, "already_sent");
      const legacy = await sendTemplate(waUrl, conversation.id, "primo_contatto_cliente");
      assert.equal(legacy.status, 409, "anche il vecchio template di primo contatto e bloccato");
      assert.equal((await templateMessages(conversation.id)).length, 1);
    });
  });

  await runCase("retry con la stessa chiave non duplica messaggio, log e attivita", async () => {
    await withServers(async (leadUrl, waUrl) => {
      const { lead, conversation } = await createLeadWithConversation(leadUrl, waUrl);
      const first = await sendTemplate(waUrl, conversation.id, "request_documents", { idempotencyKey: "job_1" });
      const retry = await sendTemplate(waUrl, conversation.id, "request_documents", { idempotencyKey: "job_1" });
      assert.equal(first.status, 200);
      assert.equal(retry.status, 200);
      assert.equal(retry.body.duplicate, true);
      assert.equal(retry.body.message.id, first.body.message.id);
      assert.equal((await templateMessages(conversation.id)).length, 1);
      const sentActivities = (await leadTimeline(leadUrl, lead.id)).filter((item) => item.type === "whatsapp_template_sent");
      assert.equal(sentActivities.length, 1);
    });
  });

  await runCase("template preventivo: rifiutato senza URL, inviato con il link del preventivo", async () => {
    await withServers(async (leadUrl, waUrl) => {
      const { lead, conversation } = await createLeadWithConversation(leadUrl, waUrl);
      const missing = await sendTemplate(waUrl, conversation.id, "quote_ready");
      assert.equal(missing.status, 400);
      assert.equal(missing.body.code, "quote_missing");
      const invalidPatch = await request(leadUrl, "PATCH", `/leads/${lead.id}`, { quoteUrl: "javascript:alert(1)" });
      assert.equal(invalidPatch.status, 400, "un link non http(s) non viene salvato");
      await request(leadUrl, "PATCH", `/leads/${lead.id}`, { quoteUrl: "https://crocieriamo.it/preventivo/42" });
      const sent = await sendTemplate(waUrl, conversation.id, "quote_ready");
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
      assert.ok(sent.body.message.text.includes("https://crocieriamo.it/preventivo/42"));
    });
  });

  await runCase("optOut blocca i template, l'inbound riapre la chat ma non lo cancella", async () => {
    await withServers(async (leadUrl, waUrl) => {
      const { lead, conversation, digits } = await createLeadWithConversation(leadUrl, waUrl, { productInterest: "Caraibi" });
      const optOut = await request(leadUrl, "PATCH", `/leads/${lead.id}`, { doNotContact: { active: true, reason: "Richiesta del cliente" }, actor: "operatore1" });
      assert.equal(optOut.body.doNotContact.active, true);
      assert.equal(optOut.body.doNotContact.setBy, "operatore1");
      const blocked = await sendTemplate(waUrl, conversation.id, "lead_first_contact");
      assert.equal(blocked.status, 409);
      assert.equal(blocked.body.code, "opt_out");
      const inbound = await request(waUrl, "POST", "/webhook", inboundWebhook(digits, "wamid.optout_inbound"));
      assert.equal(inbound.status, 200);
      const after = (await request(leadUrl, "GET", `/leads/${lead.id}`)).body as any;
      assert.equal(after.lead.doNotContact.active, true, "un messaggio in arrivo non annulla l'opt-out esplicito");
      const state = (await request(waUrl, "GET", `/automation/state?leadId=${lead.id}`)).body as any;
      assert.equal(state.state.stoppedReason, "opt_out");
      assert.deepEqual(state.suggestions, []);
      assert.equal(state.templates.request_documents.allowed, false);
    });
  });

  await runCase("webhook inbound duplicato (retry Meta) non duplica il messaggio", async () => {
    await withServers(async (leadUrl, waUrl) => {
      const { conversation, digits } = await createLeadWithConversation(leadUrl, waUrl);
      await request(waUrl, "POST", "/webhook", inboundWebhook(digits, "wamid.dup_1"));
      await request(waUrl, "POST", "/webhook", inboundWebhook(digits, "wamid.dup_1"));
      const inbound = (await chatStore.listMessages(conversation.id, 500)).filter((m: any) => m.direction === "inbound");
      assert.equal(inbound.length, 1);
    });
  });

  await runCase("la risposta del cliente ferma i solleciti (stato derivato) e lo stato e esposto all'operatore", async () => {
    await withServers(async (leadUrl, waUrl) => {
      const { lead, conversation, digits } = await createLeadWithConversation(leadUrl, waUrl, { productInterest: "Fiordi" });
      await sendTemplate(waUrl, conversation.id, "lead_first_contact");
      await new Promise((resolve) => setTimeout(resolve, 1100));
      await request(waUrl, "POST", "/webhook", inboundWebhook(digits, "wamid.reply_1", "Si, mi interessa"));
      const state = (await request(waUrl, "GET", `/automation/state?leadId=${lead.id}`)).body as any;
      assert.equal(state.state.stoppedReason, "customer_replied");
      assert.ok(state.state.firstContactSentAt);
      assert.ok(state.state.customerRepliedAt);
    });
  });

  await runCase("status webhook: pricing Meta salvato una volta, retry senza duplicati, stato che non torna indietro", async () => {
    await withServers(async (leadUrl, waUrl) => {
      const { conversation } = await createLeadWithConversation(leadUrl, waUrl);
      const sent = await sendTemplate(waUrl, conversation.id, "request_documents");
      const providerMessageId = sent.body.message.providerMessageId;
      const status = (value: string) => ({
        entry: [{ changes: [{ value: { statuses: [{ id: providerMessageId, status: value, pricing: { billable: true, category: "utility", pricing_model: "PMP", type: "regular" } }] } }] }]
      });
      await request(waUrl, "POST", "/webhook", status("delivered"));
      await request(waUrl, "POST", "/webhook", status("read"));
      await request(waUrl, "POST", "/webhook", status("read"));
      await request(waUrl, "POST", "/webhook", status("delivered"));
      const messages = await templateMessages(conversation.id);
      assert.equal(messages.length, 1);
      assert.equal(messages[0].status, "read", "un delivered arrivato in ritardo non riporta indietro lo stato");
      assert.deepEqual(messages[0].pricing, { billable: true, category: "utility", pricingModel: "PMP", type: "regular" });
    });
  });

  await runCase("senza pricing da Meta nessun costo viene inventato", async () => {
    await withServers(async (leadUrl, waUrl) => {
      const { conversation } = await createLeadWithConversation(leadUrl, waUrl);
      const sent = await sendTemplate(waUrl, conversation.id, "request_documents");
      await request(waUrl, "POST", "/webhook", { entry: [{ changes: [{ value: { statuses: [{ id: sent.body.message.providerMessageId, status: "delivered" }] } }] }] });
      const [message] = await templateMessages(conversation.id);
      assert.equal(message.pricing, undefined);
    });
  });

  await runCase("tick automazione con interruttore spento non invia nulla", async () => {
    await withServers(async (leadUrl, waUrl) => {
      const { conversation } = await createLeadWithConversation(leadUrl, waUrl, { productInterest: "Fiordi" });
      const tick = await request(waUrl, "POST", "/internal/automation/tick");
      assert.equal(tick.body.sent, 0);
      assert.equal(tick.body.skipped, "automation_disabled");
      assert.equal((await templateMessages(conversation.id)).length, 0);
    });
  });

  await runCase("diagnostica: stato configurazione senza esporre secret, ultimo webhook registrato", async () => {
    await withServers(async (leadUrl, waUrl) => {
      const { digits } = await createLeadWithConversation(leadUrl, waUrl);
      await request(waUrl, "POST", "/webhook", inboundWebhook(digits, "wamid.diag_1"));
      const diagnostics = (await request(waUrl, "GET", "/diagnostics")).body as any;
      assert.equal(diagnostics.provider.accessTokenConfigured, false);
      assert.equal(diagnostics.provider.automationEnabled, false);
      assert.ok(diagnostics.lastWebhookAt);
      assert.ok(!JSON.stringify(diagnostics).includes("dev_whatsapp_token"), "nessun valore di token nella risposta");
    });
  });
}

main()
  .then(() => {
    cleanupDb();
    console.log("All booking-automation checks passed.");
  })
  .catch((error) => {
    cleanupDb();
    console.error(error);
    process.exit(1);
  });
