import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const BACKEND_ROOT = path.join(__dirname, "..", "..", "..");
const TEST_DB_FILE = path.join(BACKEND_ROOT, "data", "db.threecx-events.test.json");
const TEST_CHAT_DB_FILE = path.join(BACKEND_ROOT, "data", "whatsapp.threecx-events.test.json");

process.env.NODE_ENV = "test";
process.env.JSON_DB_FILE = TEST_DB_FILE;
process.env.WHATSAPP_DB_FILE = TEST_CHAT_DB_FILE;
delete process.env.MONGO_URL;
delete process.env.MONGODB_URI;

const leadService = require("./server") as typeof import("./server");
const { LEAD_STATUSES } = require("../common/workflow") as typeof import("../common/workflow");
const taskStore = require("../common/taskStore") as typeof import("../common/taskStore");

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
  if (fs.existsSync(TEST_CHAT_DB_FILE)) fs.unlinkSync(TEST_CHAT_DB_FILE);
}

async function withServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  await new Promise<void>((resolve, reject) => {
    leadService.server.listen(0, "127.0.0.1", (error?: Error) => (error ? reject(error) : resolve()));
  });
  try {
    const address = leadService.server.address();
    if (!address || typeof address === "string") throw new Error("Server test non disponibile.");
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => leadService.server.close((error?: Error) => (error ? reject(error) : resolve())));
  }
}

async function request(baseUrl: string, method: string, urlPath: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
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

async function createLead(baseUrl: string) {
  const phone = `+393${Math.floor(Math.random() * 900000000 + 100000000)}`;
  const created = await request(baseUrl, "POST", "/leads", { fullName: "Cliente 3CX", phone });
  assert.equal(created.status, 201);
  return created.body as any;
}

const callEvent = (baseUrl: string, body: Record<string, unknown>) => request(baseUrl, "POST", "/internal/call-events", body);
const detail = async (baseUrl: string, leadId: string) => (await request(baseUrl, "GET", `/leads/${leadId}`)).body as any;

async function main() {
  await runCase("alias 3CX normalizzati sugli esiti CRM", async () => {
    assert.equal(leadService.normalizeThreeCxDisposition("missed"), "no_answer");
    assert.equal(leadService.normalizeThreeCxDisposition("Answered"), "completed");
    assert.equal(leadService.normalizeThreeCxDisposition("callback"), "call_back");
    assert.equal(leadService.normalizeThreeCxDisposition(undefined), "completed");
  });

  await runCase("numero sconosciuto: la chiamata in arrivo crea il contatto, senza mai perderla", async () => { await withServer(async (baseUrl) => {
    const auth = require("../api-gateway/auth-store");
    const original = auth.listUsers;
    auth.listUsers = async () => [{ id: "u1", username: "marta", name: "Marta", role: "operatore", threeCxDn: "901" }, { id: "u2", username: "capo", name: "Capo", role: "admin", threeCxDn: "913" }];
    const stored = async (phone: string) => (await request(baseUrl, "GET", `/leads?search=${encodeURIComponent(phone)}`)).body as any[];
    try {
      const startedAt = new Date().toISOString();
      const missed = await callEvent(baseUrl, { callId: "901001", direction: "inbound", from: "+393401000001", startedAt, endedAt: startedAt, disposition: "no_answer", eventType: "call_control_final" });
      assert.equal(missed.body.matched, true, "a missed call from a new customer is recorded");
      const [waiting] = await stored("+393401000001");
      assert.deepEqual([waiting.assignedTo, waiting.source, waiting.fullName], ["", "3cx_chiamata", "Chiamata da +393401000001"], "it waits for the admin");

      await callEvent(baseUrl, { callId: "901002", direction: "inbound", from: "+393401000002", agent: "901", startedAt, answeredAt: startedAt, endedAt: startedAt, durationSeconds: 60, disposition: "completed", eventType: "call_control_final" });
      assert.equal((await stored("+393401000002"))[0].assignedTo, "marta", "who answered keeps the customer");

      await callEvent(baseUrl, { callId: "901003", direction: "inbound", from: "+393401000003", agent: "913", startedAt, answeredAt: startedAt, endedAt: startedAt, disposition: "completed", eventType: "call_control_final" });
      assert.equal((await stored("+393401000003"))[0].assignedTo, "", "an admin picking up does not take the customer from the distribution");

      const again = await callEvent(baseUrl, { callId: "901004", direction: "inbound", from: "+393401000001", startedAt: new Date(Date.now() + 3600_000).toISOString(), disposition: "no_answer", eventType: "call_control_final" });
      assert.equal(again.body.leadId, waiting.id, "the second call lands on the same contact");
      assert.equal((await stored("+393401000001")).length, 1);

      assert.equal((await callEvent(baseUrl, { callId: "901005", direction: "outbound", from: "+393401000005", disposition: "completed" })).body.matched, false, "an outgoing call to another number creates nothing");
      assert.equal((await callEvent(baseUrl, { callId: "901006", from: "+393401000006", disposition: "completed" })).body.matched, false, "without a direction nothing is assumed");
      assert.equal((await callEvent(baseUrl, { callId: "901007", direction: "inbound", from: "123", disposition: "completed" })).body.matched, false, "a short code is not a customer");
    } finally {
      auth.listUsers = original;
    }
  }); });

  await runCase("un cliente archiviato che ricontatta rientra da solo, con il suo storico", async () => { await withServer(async (baseUrl) => {
    const leadStore = require("../common/leadStore");
    const auth = require("../api-gateway/auth-store");
    const original = auth.listUsers;
    auth.listUsers = async () => [{ id: "u1", username: "marta", name: "Marta", role: "operatore", threeCxDn: "901" }];
    const archived = async (phone: string, extra: Record<string, unknown> = {}) => {
      const created = await request(baseUrl, "POST", "/internal/ingest", { source: "excel_clienti_2025", fullName: "Cliente " + phone, phone, email: phone.slice(-6) + "@esempio.it" });
      const lead = await leadStore.getLeadById(created.body.lead.id);
      Object.assign(lead, { assignedTo: "vecchio.operatore", archivedAt: new Date().toISOString(), archivedBy: "admin.test", archiveReason: "Non risponde", ...extra });
      await leadStore.saveLead(lead);
      return lead.id;
    };
    const stored = (id: string) => leadStore.getLeadById(id);
    try {
      const at = new Date().toISOString();

      const missed = await archived("+393402000001");
      const call = await callEvent(baseUrl, { callId: "902001", direction: "inbound", from: "+393402000001", startedAt: at, endedAt: at, disposition: "no_answer", eventType: "call_control_final" });
      assert.equal(call.body.leadId, missed, "the same contact, not a copy");
      let lead = await stored(missed);
      assert.equal(lead.archivedAt, undefined);
      assert.equal(lead.assignedTo, "", "a missed call waits in Da assegnare");
      assert.equal((await leadStore.listLeadsByContact("+393402000001", "")).length, 1, "no duplicate");

      const answered = await archived("+393402000002", { status: LEAD_STATUSES.LOST, closingOutcome: "lost" });
      await callEvent(baseUrl, { callId: "902002", direction: "inbound", from: "+393402000002", agent: "901", startedAt: at, answeredAt: at, endedAt: at, durationSeconds: 60, disposition: "completed", eventType: "call_control_final" });
      lead = await stored(answered);
      assert.equal(lead.assignedTo, "marta", "who answered keeps it");
      assert.equal(lead.closingOutcome, "open", "a lost practice can be worked again");

      const sold = await archived("+393402000003", { closingOutcome: "won", status: LEAD_STATUSES.SOLD });
      await callEvent(baseUrl, { callId: "902003", direction: "inbound", from: "+393402000003", startedAt: at, endedAt: at, disposition: "no_answer", eventType: "call_control_final" });
      lead = await stored(sold);
      assert.equal(lead.archivedAt, undefined);
      assert.equal(lead.closingOutcome, "won", "a sale stays a sale");

      const outgoing = await archived("+393402000004");
      await callEvent(baseUrl, { callId: "902004", direction: "outbound", from: "+393402000004", startedAt: at, disposition: "completed" });
      assert.ok((await stored(outgoing)).archivedAt, "our own call is not the customer coming back");

      const chat = await archived("+393402000005");
      const returned = await request(baseUrl, "POST", "/internal/contact-returned", { phone: "+393402000005", via: "whatsapp" });
      assert.deepEqual(returned.body, { returned: true, leadId: chat });
      assert.equal((await request(baseUrl, "POST", "/internal/contact-returned", { phone: "+393402000005", via: "whatsapp" })).body.returned, false, "a retried webhook changes nothing");
      const trail = (await leadStore.listActivitiesByType("lead_restored")).find((row: any) => row.leadId === chat);
      assert.ok(trail.text.includes("WhatsApp"), "the history says why it came back");
      assert.equal(trail.meta.previous.assignedTo, "vecchio.operatore");

      const form = await archived("+393402000006");
      const request2 = await request(baseUrl, "POST", "/internal/ingest", { source: "meta_lead", fullName: "Cliente", phone: "+393402000006" });
      assert.equal(request2.body.lead.id, form, "a new request lands on the same contact");

      const mail = await archived("+393402000007");
      const email = "000007@esempio.it";
      assert.equal(await leadService.inboxDeps.findLeadIdByEmail(email), mail);
      await leadService.inboxDeps.onReceived({ id: "m1", leadId: mail, from: email, subject: "Ciao" } as any);
      assert.equal((await stored(mail)).archivedAt, undefined);

      const kept = await archived("+393402000008");
      const active = await request(baseUrl, "POST", "/internal/ingest", { source: "manuale", fullName: "Altra scheda", phone: "+393402000009" });
      await leadStore.saveLead({ ...(await stored(active.body.lead.id)), email: "000008@esempio.it" });
      assert.ok(active.body.lead.id !== kept);
      assert.equal((await request(baseUrl, "POST", "/internal/contact-returned", { email: "000008@esempio.it", via: "email" })).body.returned, false, "an active practice already answers for this contact");
    } finally {
      auth.listUsers = original;
    }
  }); });

  await runCase("no_answer 3CX: stato Non risponde, attivita con tentativo, durata e template suggerito", async () => {
    await withServer(async (baseUrl) => {
      const lead = await createLead(baseUrl);
      const result = await callEvent(baseUrl, { from: lead.phone, disposition: "missed", callId: "c_na_1", durationSeconds: 0, agent: "101" });
      assert.equal(result.body.matched, true);
      const after = await detail(baseUrl, lead.id);
      assert.equal(after.lead.status, LEAD_STATUSES.NO_ANSWER);
      const event = after.timeline.find((item: any) => item.type === "3cx_event");
      assert.ok(event.text.includes("nessuna risposta"));
      assert.equal(event.meta.suggestedTemplate, "call_no_answer");
      assert.equal(after.callLogs[0].outcome, "no_answer");
      assert.equal(after.callLogs[0].actor, "101");
    });
  });

  await runCase("evento 3CX duplicato (stesso callId) non duplica chiamata ne attivita", async () => {
    await withServer(async (baseUrl) => {
      const lead = await createLead(baseUrl);
      await callEvent(baseUrl, { from: lead.phone, disposition: "no_answer", callId: "c_dup" });
      const retry = await callEvent(baseUrl, { from: lead.phone, disposition: "no_answer", callId: "c_dup" });
      assert.equal(retry.body.duplicate, true);
      const after = await detail(baseUrl, lead.id);
      assert.equal(after.callLogs.length, 1);
      assert.equal(after.timeline.filter((item: any) => item.type === "3cx_event").length, 1);
      assert.equal(after.lead.callAttempts, 1);
    });
  });

  await runCase("finale Call Control riusa il processing: callid nativo, metadati e retry senza duplicati", async () => {
    await withServer(async (baseUrl) => {
      const lead = await createLead(baseUrl);
      const event = { callId: "123456", from: lead.phone, eventType: "call_control_final", disposition: "completed",
        agent: "913", direction: "outbound", startedAt: "2026-10-16T10:00:00.000Z",
        answeredAt: "2026-10-16T10:00:05.000Z", endedAt: "2026-10-16T10:01:40.000Z", durationSeconds: 95 };
      assert.equal((await callEvent(baseUrl, event)).body.matched, true);
      assert.equal((await callEvent(baseUrl, event)).body.duplicate, true);
      const after = await detail(baseUrl, lead.id);
      assert.equal(after.callLogs.length, 1);
      assert.equal(after.callLogs[0].idempotencyKey, "3cx_123456");
      assert.equal(after.callLogs[0].direction, "outbound");
      assert.equal(after.callLogs[0].answeredAt, event.answeredAt);
      assert.equal(after.callLogs[0].actor, "913");
      assert.equal(after.callLogs[0].durationSeconds, 95);
      assert.equal(after.lead.status, LEAD_STATUSES.TO_CONTACT, "nessun esito commerciale derivato");
      const timeline = after.timeline.filter((row: any) => row.type === "3cx_event");
      assert.equal(timeline.length, 1);
      assert.equal(timeline[0].meta.callId, "123456");
      assert.equal(timeline[0].meta.answeredAt, event.answeredAt);
    });
  });

  await runCase("callid riusato dopo un riavvio del centralino: nuova chiamata registrata, retry ancora unico", async () => {
    await withServer(async (baseUrl) => {
      const lead = await createLead(baseUrl);
      const first = { callId: "6", from: lead.phone, eventType: "call_control_final", disposition: "completed", agent: "913", direction: "outbound",
        startedAt: "2026-11-03T08:41:00.000Z", answeredAt: "2026-11-03T08:41:10.000Z", endedAt: "2026-11-03T08:43:00.000Z", durationSeconds: 110 };
      const second = { ...first, agent: "901", startedAt: "2026-11-03T10:58:00.000Z", answeredAt: "2026-11-03T10:58:08.000Z", endedAt: "2026-11-03T11:00:00.000Z" };
      assert.equal((await callEvent(baseUrl, first)).body.matched, true);
      const reused = await callEvent(baseUrl, second);
      assert.equal(reused.body.matched, true); assert.notEqual(reused.body.duplicate, true, "same id two hours later is another call");
      assert.equal((await callEvent(baseUrl, second)).body.duplicate, true, "retry of the second call");
      assert.equal((await callEvent(baseUrl, first)).body.duplicate, true, "retry of the first call");
      const after = await detail(baseUrl, lead.id);
      assert.equal(after.callLogs.length, 2);
      assert.deepEqual(after.callLogs.map((row: any) => row.idempotencyKey).sort(), ["3cx_6", `3cx_6_${Date.parse(second.startedAt)}`].sort());
    });
  });

  await runCase("callback 3CX con data: Richiamo concordato, nextActionAt e task di richiamo", async () => {
    await withServer(async (baseUrl) => {
      const lead = await createLead(baseUrl);
      const callbackAt = new Date(Date.now() + 48 * 3_600_000).toISOString();
      await callEvent(baseUrl, { from: lead.phone, disposition: "callback", callId: "c_cb_1", callbackAt, durationSeconds: 95, note: "Dopo le 18" });
      const after = await detail(baseUrl, lead.id);
      assert.equal(after.lead.status, LEAD_STATUSES.CALLBACK_AGREED);
      assert.equal(after.lead.nextActionAt, callbackAt);
      assert.equal(after.callLogs[0].durationSeconds, 95);
      assert.equal(after.callLogs[0].callbackAt, callbackAt);
      const tasks = await taskStore.listTasks({ leadId: lead.id, status: "open" });
      assert.ok(tasks.some((task: any) => task.kind === "callback_reminder"), "task di richiamo creato");
    });
  });

  await runCase("callback 3CX senza data: stato invariato, nessuna data inventata", async () => {
    await withServer(async (baseUrl) => {
      const lead = await createLead(baseUrl);
      await callEvent(baseUrl, { from: lead.phone, disposition: "call_back", callId: "c_cb_2" });
      const after = await detail(baseUrl, lead.id);
      assert.equal(after.lead.status, LEAD_STATUSES.TO_CONTACT);
      assert.ok(after.timeline.find((item: any) => item.type === "3cx_event").text.includes("stato invariato"));
    });
  });

  await runCase("interested 3CX cambia stato solo se confermato dall'agente", async () => {
    await withServer(async (baseUrl) => {
      const unconfirmed = await createLead(baseUrl);
      await callEvent(baseUrl, { from: unconfirmed.phone, disposition: "interested", callId: "c_int_1" });
      assert.equal((await detail(baseUrl, unconfirmed.id)).lead.status, LEAD_STATUSES.TO_CONTACT);
      const confirmed = await createLead(baseUrl);
      await callEvent(baseUrl, { from: confirmed.phone, disposition: "interested", callId: "c_int_2", agentDisposition: true });
      assert.equal((await detail(baseUrl, confirmed.id)).lead.status, LEAD_STATUSES.INTERESTED);
    });
  });

  await runCase("not_interested 3CX ferma sempre i solleciti WhatsApp; chiude solo con agente e motivo", async () => {
    await withServer(async (baseUrl) => {
      const lead = await createLead(baseUrl);
      await callEvent(baseUrl, { from: lead.phone, disposition: "not_interested", callId: "c_ni_1" });
      let after = await detail(baseUrl, lead.id);
      assert.equal(after.lead.status, LEAD_STATUSES.TO_CONTACT, "senza conferma dell'agente lo stato non cambia");
      assert.equal(after.lead.whatsappAutomation.stoppedReason, "not_interested");
      const other = await createLead(baseUrl);
      await callEvent(baseUrl, { from: other.phone, disposition: "not_interested", callId: "c_ni_2", agentDisposition: true, lossReason: "Ha gia prenotato altrove" });
      after = await detail(baseUrl, other.id);
      assert.equal(after.lead.status, LEAD_STATUSES.NOT_INTERESTED);
      assert.equal(after.lead.lossReason, "Ha gia prenotato altrove");
    });
  });

  await runCase("opt-out: impostato e rimosso solo dall'operatore, con attivita in timeline", async () => {
    await withServer(async (baseUrl) => {
      const lead = await createLead(baseUrl);
      const set = await request(baseUrl, "PATCH", `/leads/${lead.id}`, { doNotContact: { active: true, reason: "STOP via WhatsApp" }, actor: "operatore1" });
      assert.equal(set.body.doNotContact.active, true);
      const again = await request(baseUrl, "PATCH", `/leads/${lead.id}`, { doNotContact: { active: true, reason: "STOP via WhatsApp" }, actor: "operatore1" });
      assert.equal(again.body.doNotContact.setAt, set.body.doNotContact.setAt, "un PATCH ripetuto non cambia la data");
      const cleared = await request(baseUrl, "PATCH", `/leads/${lead.id}`, { doNotContact: { active: false }, actor: "admin" });
      assert.equal(cleared.body.doNotContact.active, false);
      const timeline = (await detail(baseUrl, lead.id)).timeline.map((item: any) => item.type);
      assert.equal(timeline.filter((type: string) => type === "do_not_contact_set").length, 1);
      assert.equal(timeline.filter((type: string) => type === "do_not_contact_cleared").length, 1);
    });
  });
}

main()
  .then(() => {
    cleanupDb();
    console.log("All threecx-events checks passed.");
  })
  .catch((error) => {
    cleanupDb();
    console.error(error);
    process.exit(1);
  });
