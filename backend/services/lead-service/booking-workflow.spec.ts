import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const BACKEND_ROOT = path.join(__dirname, "..", "..", "..");
const TEST_DB_FILE = path.join(BACKEND_ROOT, "data", "db.booking-workflow.test.json");
const TEST_CHAT_DB_FILE = path.join(BACKEND_ROOT, "data", "whatsapp.booking-workflow.test.json");

process.env.NODE_ENV = "test";
process.env.JSON_DB_FILE = TEST_DB_FILE;
process.env.WHATSAPP_DB_FILE = TEST_CHAT_DB_FILE;
delete process.env.MONGO_URL;
delete process.env.MONGODB_URI;

const leadService = require("./server") as typeof import("./server");
const leadStore = require("../common/leadStore") as typeof import("../common/leadStore");
const taskStore = require("../common/taskStore") as typeof import("../common/taskStore");
const chatStore = require("../common/chatStore") as typeof import("../common/chatStore");

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

async function createLead(baseUrl: string, overrides: Record<string, unknown> = {}) {
  const created = await postJson(baseUrl, "/leads", {
    fullName: "Cliente Test",
    phone: `+39 3${Math.floor(Math.random() * 900000000 + 100000000)}`,
    assignedTo: "operatore1",
    ...overrides
  });
  assert.equal(created.status, 201);
  return created.body as any;
}

/** Moves a lead out of TO_CONTACT so the pre-contact exemption no longer masks the invariant check. */
async function moveToInterested(baseUrl: string, leadId: string) {
  const res = await postJson(baseUrl, `/leads/${leadId}/calls`, { disposition: "interested", idempotencyKey: `seed_${leadId}` });
  assert.equal(res.status, 200);
  return res.body;
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

async function main() {
  await runCase("attivita 'completed' senza next action viene rifiutata (nessuna scusa 'non ancora contattato': il contatto e in corso ora)", async () => {
    await withServer(async (baseUrl) => {
      const lead = await createLead(baseUrl);
      assert.equal(lead.nextActionAt, null);
      const res = await postJson(baseUrl, `/leads/${lead.id}/calls`, { disposition: "completed", idempotencyKey: "attempt_completed_1" });
      assert.equal(res.status, 400);
    });
  });

  await runCase("callback senza data/ora viene rifiutato", async () => {
    await withServer(async (baseUrl) => {
      const lead = await createLead(baseUrl);
      const res = await postJson(baseUrl, `/leads/${lead.id}/calls`, {
        disposition: "call_back",
        callbackReason: "Cliente ha chiesto di essere richiamato domani",
        idempotencyKey: "cb_no_date"
      });
      assert.equal(res.status, 400);
    });
  });

  await runCase("callback senza motivo viene rifiutato", async () => {
    await withServer(async (baseUrl) => {
      const lead = await createLead(baseUrl);
      const res = await postJson(baseUrl, `/leads/${lead.id}/calls`, {
        disposition: "call_back",
        followUpAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
        idempotencyKey: "cb_no_reason"
      });
      assert.equal(res.status, 400);
    });
  });

  await runCase("callback valido crea il task di reminder e assegna l'operatore", async () => {
    await withServer(async (baseUrl) => {
      const lead = await createLead(baseUrl, { assignedTo: "" });
      const followUpAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
      const res = await postJson(baseUrl, `/leads/${lead.id}/calls`, {
        disposition: "call_back",
        followUpAt,
        callbackReason: "Vuole confrontare i prezzi con la concorrenza",
        assignedTo: "operatore2",
        idempotencyKey: "cb_valid"
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.status, "Richiamo concordato");
      assert.equal(res.body.closingOutcome, "open", "il lead deve restare attivo");
      assert.equal(res.body.nextActionAt, followUpAt);
      assert.equal(res.body.assignedTo, "operatore2");

      const tasks = (await taskStore.listTasks({ leadId: lead.id, includeDismissed: true })).filter((t: any) => t.kind === "callback_reminder");
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0].status, "open");
      assert.equal(tasks[0].assignedTo, "operatore2");
      assert.equal(tasks[0].dueAt, followUpAt);
    });
  });

  await runCase("callback completato (nuovo esito registrato) sincronizza/chiude il task di reminder", async () => {
    await withServer(async (baseUrl) => {
      const lead = await createLead(baseUrl);
      await postJson(baseUrl, `/leads/${lead.id}/calls`, {
        disposition: "call_back",
        followUpAt: new Date(Date.now() + 3600 * 1000).toISOString(),
        callbackReason: "Da richiamare in serata",
        idempotencyKey: "cb_1"
      });
      const res = await postJson(baseUrl, `/leads/${lead.id}/calls`, { disposition: "interested", idempotencyKey: "cb_1_resolved" });
      assert.equal(res.status, 200);
      const tasks = (await taskStore.listTasks({ leadId: lead.id, includeDismissed: true })).filter((t: any) => t.kind === "callback_reminder");
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0].status, "done", "il task di richiamo deve risultare completato una volta registrato un nuovo esito");
    });
  });

  await runCase("NO_ANSWER via webhook 3CX incrementa callAttempts una sola volta per evento", async () => {
    await withServer(async (baseUrl) => {
      const lead = await createLead(baseUrl);
      const res = await postJson(baseUrl, "/internal/call-events", {
        externalLeadId: lead.id,
        callId: "3cx_call_unique_1",
        disposition: "no_answer",
        eventType: "hangup"
      });
      assert.equal(res.status, 200);
      const after = await getJson(baseUrl, `/leads/${lead.id}`);
      assert.equal(after.body.lead.callAttempts, 1);
      assert.equal(after.body.lead.status, "Non risponde");
    });
  });

  await runCase("un retry del webhook 3CX con lo stesso callId non incrementa nuovamente il tentativo", async () => {
    await withServer(async (baseUrl) => {
      const lead = await createLead(baseUrl);
      const payload = { externalLeadId: lead.id, callId: "3cx_call_retry_1", disposition: "no_answer", eventType: "hangup" };
      const first = await postJson(baseUrl, "/internal/call-events", payload);
      assert.equal(first.status, 200);
      assert.equal(first.body.duplicate, undefined);
      // Simulate 3CX retrying delivery of the exact same event.
      const retry = await postJson(baseUrl, "/internal/call-events", payload);
      assert.equal(retry.status, 200);
      assert.equal(retry.body.duplicate, true);

      const after = await getJson(baseUrl, `/leads/${lead.id}`);
      assert.equal(after.body.lead.callAttempts, 1, "il retry non deve incrementare nuovamente callAttempts");

      const callLogs = await getJson(baseUrl, `/leads/${lead.id}/calls`);
      assert.equal(callLogs.body.length, 1, "il retry non deve scrivere un secondo CallLogRecord");
    });
  });

  await runCase("dopo il secondo tentativo senza risposta il backend espone secondAttemptPending=true", async () => {
    await withServer(async (baseUrl) => {
      const lead = await createLead(baseUrl);
      await postJson(baseUrl, "/internal/call-events", { externalLeadId: lead.id, callId: "att_1", disposition: "no_answer" });
      const afterFirst = await getJson(baseUrl, `/leads/${lead.id}`);
      assert.equal(afterFirst.body.lead.secondAttemptPending, false, "dopo un solo tentativo non deve scattare il flow guidato");

      await postJson(baseUrl, "/internal/call-events", { externalLeadId: lead.id, callId: "att_2", disposition: "no_answer" });
      const afterSecond = await getJson(baseUrl, `/leads/${lead.id}`);
      assert.equal(afterSecond.body.lead.callAttempts, 2);
      assert.equal(afterSecond.body.lead.secondAttemptPending, true, "dopo il secondo tentativo deve essere richiesto il follow-up guidato");

      // Resolving with any outcome clears the pending flag (the guided decision has been made).
      const resolved = await postJson(baseUrl, `/leads/${lead.id}/calls`, { disposition: "interested", idempotencyKey: "resolve_second_attempt" });
      assert.equal(resolved.status, 200);
      assert.equal(resolved.body.secondAttemptPending, false);
    });
  });

  await runCase("il testo dell'evento 3CX per NO_ANSWER e leggibile per l'operatore e indica il numero di tentativo", async () => {
    await withServer(async (baseUrl) => {
      const lead = await createLead(baseUrl);
      await postJson(baseUrl, "/internal/call-events", { externalLeadId: lead.id, callId: "readable_1", disposition: "no_answer" });
      await postJson(baseUrl, "/internal/call-events", { externalLeadId: lead.id, callId: "readable_2", disposition: "no_answer" });

      const detail = await getJson(baseUrl, `/leads/${lead.id}`);
      const events = detail.body.timeline.filter((item: any) => item.type === "3cx_event");
      assert.equal(events.length, 2);
      assert.ok(!events[0].text.includes("Evento 3CX"), "il testo non deve contenere gergo interno tipo 'Evento 3CX'");
      assert.ok(events[0].text.includes("tentativo 1"), `atteso il numero di tentativo nel testo, ottenuto: ${events[0].text}`);
      assert.ok(events[1].text.includes("tentativo 2"), `atteso il numero di tentativo nel testo, ottenuto: ${events[1].text}`);
    });
  });

  await runCase("NOT_INTERESTED senza motivo viene rifiutato", async () => {
    await withServer(async (baseUrl) => {
      const lead = await createLead(baseUrl);
      const res = await postJson(baseUrl, `/leads/${lead.id}/calls`, { disposition: "not_interested", idempotencyKey: "ni_no_reason" });
      assert.equal(res.status, 400);
    });
  });

  await runCase("NOT_INTERESTED valido chiude il lead come disqualified senza next action", async () => {
    await withServer(async (baseUrl) => {
      const lead = await createLead(baseUrl);
      const res = await postJson(baseUrl, `/leads/${lead.id}/calls`, {
        disposition: "not_interested",
        lossReason: "non_interessato",
        idempotencyKey: "ni_valid"
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.status, "Contattato non interessato");
      assert.equal(res.body.closingOutcome, "disqualified");
      assert.equal(res.body.lossReason, "non_interessato");
      assert.equal(res.body.nextActionAt, null, "un lead disqualificato non deve avere una next action operativa");
    });
  });

  await runCase("QUOTE_SENT lascia il lead attivo e crea/richiede una next action", async () => {
    await withServer(async (baseUrl) => {
      const lead = await createLead(baseUrl);
      const res = await postJson(baseUrl, `/leads/${lead.id}/calls`, { disposition: "quote_sent", idempotencyKey: "quote_sent_1" });
      assert.equal(res.status, 200);
      assert.equal(res.body.closingOutcome, "open", "QUOTE_SENT non deve chiudere il lead");
      assert.ok(res.body.nextActionAt, "QUOTE_SENT non deve lasciare il lead senza next action");
    });
  });

  await runCase("QUOTE_REQUIRED crea un task di preparazione preventivo, QUOTE_SENT lo risolve", async () => {
    await withServer(async (baseUrl) => {
      const lead = await createLead(baseUrl);
      const requested = await postJson(baseUrl, `/leads/${lead.id}/calls`, { disposition: "quote_required", idempotencyKey: "quote_req_1" });
      assert.equal(requested.status, 200);
      let quoteTasks = (await taskStore.listTasks({ leadId: lead.id, includeDismissed: true })).filter((t: any) => t.kind === "quote_preparation");
      assert.equal(quoteTasks.length, 1);
      assert.equal(quoteTasks[0].status, "open");

      const sent = await postJson(baseUrl, `/leads/${lead.id}/calls`, { disposition: "quote_sent", idempotencyKey: "quote_sent_2" });
      assert.equal(sent.status, 200);
      quoteTasks = (await taskStore.listTasks({ leadId: lead.id, includeDismissed: true })).filter((t: any) => t.kind === "quote_preparation");
      assert.equal(quoteTasks[0].status, "done");
    });
  });

  await runCase("un lead chiuso (LOST) mantiene next action pulita", async () => {
    await withServer(async (baseUrl) => {
      const lead = await createLead(baseUrl);
      await moveToInterested(baseUrl, lead.id);
      const lost = await postJson(baseUrl, `/leads/${lead.id}/status`, { toStatus: "Persa", lossReason: "fuori_budget" });
      assert.equal(lost.status, 200);
      assert.equal(lost.body.nextActionAt, null);
      assert.equal(lost.body.closingOutcome, "lost");
    });
  });

  await runCase("un lead aperto dopo l'attivita non resta orphan senza next action (interested auto-imposta la next action)", async () => {
    await withServer(async (baseUrl) => {
      const lead = await createLead(baseUrl);
      const res = await postJson(baseUrl, `/leads/${lead.id}/calls`, { disposition: "interested", idempotencyKey: "no_orphan_1" });
      assert.equal(res.status, 200);
      assert.equal(res.body.closingOutcome, "open");
      assert.ok(res.body.nextActionAt, "un lead interessato deve sempre avere una next action");
    });
  });

  await runCase("callback scaduto genera automaticamente un task callback_overdue (scheduler esistente)", async () => {
    await withServer(async (baseUrl) => {
      const lead = await createLead(baseUrl);
      const pastFollowUp = new Date(Date.now() - 3600 * 1000).toISOString();
      await postJson(baseUrl, `/leads/${lead.id}/calls`, {
        disposition: "call_back",
        followUpAt: pastFollowUp,
        callbackReason: "Richiamo gia scaduto per test",
        idempotencyKey: "overdue_cb"
      });
      await leadService.ensureSlaTasks();
      const overdueTasks = (await taskStore.listTasks({ leadId: lead.id, includeDismissed: true })).filter((t: any) => t.kind === "callback_overdue");
      assert.equal(overdueTasks.length, 1);
      assert.equal(overdueTasks[0].status, "open");
    });
  });

  await runCase("i task automatici booking non vengono duplicati su chiamate ripetute dello scheduler", async () => {
    await withServer(async (baseUrl) => {
      const lead = await createLead(baseUrl);
      await postJson(baseUrl, `/leads/${lead.id}/calls`, {
        disposition: "call_back",
        followUpAt: new Date(Date.now() - 3600 * 1000).toISOString(),
        callbackReason: "Richiamo scaduto",
        idempotencyKey: "dup_guard_cb"
      });
      await leadService.ensureSlaTasks();
      await leadService.ensureSlaTasks();
      await leadService.ensureSlaTasks();
      const overdueTasks = (await taskStore.listTasks({ leadId: lead.id, includeDismissed: true })).filter(
        (t: any) => t.kind === "callback_overdue" && t.status !== "dismissed"
      );
      assert.equal(overdueTasks.length, 1, "lo scheduler ripetuto non deve creare task duplicati");
    });
  });

  await runCase("Marketing Export: la segmentazione lost/disqualified resta invariata dopo il booking workflow", async () => {
    await withServer(async (baseUrl) => {
      const notInterestedLead = await createLead(baseUrl);
      await postJson(baseUrl, `/leads/${notInterestedLead.id}/calls`, {
        disposition: "not_interested",
        lossReason: "fuori_budget",
        idempotencyKey: "me_ni"
      });
      const openLead = await createLead(baseUrl);
      await postJson(baseUrl, `/leads/${openLead.id}/calls`, { disposition: "interested", idempotencyKey: "me_open" });

      const leadsResponse = await getJson(baseUrl, "/leads?view=summary");
      const notInterestedSummary = leadsResponse.body.find((item: any) => item.id === notInterestedLead.id);
      const openSummary = leadsResponse.body.find((item: any) => item.id === openLead.id);
      assert.equal(notInterestedSummary.closingOutcome, "disqualified");
      assert.equal(openSummary.closingOutcome, "open", "un lead con esito interessato non deve mai comparire come contatto morto");
    });
  });

  await runCase("Customer/LTV: il customerId e la relazione Lead->Customer restano invariati dopo un esito booking", async () => {
    await withServer(async (baseUrl) => {
      const lead = await createLead(baseUrl);
      assert.ok(lead.customerId);
      const res = await postJson(baseUrl, `/leads/${lead.id}/calls`, { disposition: "interested", idempotencyKey: "customer_regress" });
      assert.equal(res.status, 200);
      assert.equal(res.body.customerId, lead.customerId, "l'esito booking non deve alterare il collegamento al Customer");
    });
  });

  await runCase("lead legacy senza campi booking (callAttempts/secondAttemptPending) resta leggibile", async () => {
    const now = new Date().toISOString();
    const legacyLead = {
      id: leadStore.newId("lead"),
      fullName: "Lead Legacy Booking",
      phone: "+39 388 7776655",
      status: "Da contattare",
      notes: "",
      documents: { items: [] },
      payments: { items: [] },
      nextActionAt: null,
      createdAt: now,
      updatedAt: now
      // no callAttempts field at all, matching a pre-booking-workflow record
    };
    await leadStore.createLead(legacyLead, []);
    await withServer(async (baseUrl) => {
      const response = await getJson(baseUrl, `/leads/${legacyLead.id}`);
      assert.equal(response.status, 200);
      assert.equal(response.body.lead.callAttempts, 0);
      assert.equal(response.body.lead.secondAttemptPending, false);
    });
  });

  await runCase("l'associazione conversazione WhatsApp -> lead resta invariata (non toccata dal booking workflow)", async () => {
    const conversation = await chatStore.createOrUpdateConversation({
      phone: "+39 366 1112223",
      customerName: "Cliente WhatsApp",
      leadId: "lead_whatsapp_test",
      channel: "whatsapp"
    });
    assert.equal(conversation.leadId, "lead_whatsapp_test");
    const found = await chatStore.getConversationById(conversation.id);
    assert.equal(found?.leadId, "lead_whatsapp_test");
  });
}

main()
  .then(() => {
    cleanupDb();
    console.log("All booking-workflow checks passed.");
  })
  .catch((error) => {
    cleanupDb();
    console.error(error);
    process.exitCode = 1;
  });
