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
