import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const BACKEND_ROOT = path.join(__dirname, "..", "..", "..");
const TEST_DB_FILE = path.join(BACKEND_ROOT, "data", "db.task-sync.test.json");

process.env.NODE_ENV = "test";
process.env.JSON_DB_FILE = TEST_DB_FILE;
delete process.env.MONGO_URL;
delete process.env.MONGODB_URI;

const leadService = require("./server") as typeof import("./server");
const leadStore = require("../common/leadStore") as typeof import("../common/leadStore");
const taskStore = require("../common/taskStore") as typeof import("../common/taskStore");

function resetDb() {
  fs.mkdirSync(path.dirname(TEST_DB_FILE), { recursive: true });
  fs.writeFileSync(TEST_DB_FILE, JSON.stringify({ leads: [], activities: [], tasks: [], callLogs: [] }, null, 2), "utf8");
}

function cleanupDb() {
  if (fs.existsSync(TEST_DB_FILE)) fs.unlinkSync(TEST_DB_FILE);
}

function buildDocuments(missingKeys: string[] = []) {
  return leadService.normalizePracticeDocuments({
    items: ["identity_document", "passenger_data", "signed_contract", "deposit_payment"].map((key) => ({
      key,
      required: true,
      received: !missingKeys.includes(key),
      verified: !missingKeys.includes(key)
    }))
  });
}

function buildPayments(config: Record<string, { status: "pending" | "received" | "verified"; amount?: number }> = {}) {
  return leadService.normalizePracticePayments({
    items: ["payment_deposit", "payment_balance"].map((id) => ({
      id,
      status: config[id]?.status || "verified",
      amount: config[id]?.amount
    }))
  });
}

async function createLeadFixture(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-04-15T09:00:00.000Z").toISOString();
  const lead = {
    id: leadStore.newId("lead"),
    fullName: "Mario Rossi",
    phone: "+39 333 1234567",
    email: "mario@example.com",
    source: "Facebook",
    assignedTo: "operatore",
    status: "In trattativa",
    notes: "",
    documents: buildDocuments([]),
    payments: buildPayments({}),
    latestCallOutcome: null,
    latestCallAt: null,
    callAttempts: 0,
    nextActionAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
  await leadStore.createLead(lead, []);
  return lead;
}

async function getChecklistTasks(leadId: string, kind: string) {
  return (await taskStore.listTasks({ includeDismissed: true })).filter((task) => task.leadId === leadId && task.kind === kind);
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
  await runCase("crea document_checklist se manca almeno un documento richiesto", async () => {
    const lead = await createLeadFixture({ documents: buildDocuments(["identity_document"]) });
    await leadService.syncDocumentChecklistTask(lead);

    const tasks = await getChecklistTasks(lead.id, "document_checklist");
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].status, "open");
    assert.match(tasks[0].title, /Documenti mancanti/);
    assert.deepEqual(tasks[0].meta?.missingKeys, ["identity_document"]);
  });

  await runCase("aggiorna il task documenti se cambia la lista missing", async () => {
    const lead = await createLeadFixture({ documents: buildDocuments(["identity_document", "passenger_data"]) });
    await leadService.syncDocumentChecklistTask(lead);

    lead.documents = buildDocuments(["signed_contract"]);
    lead.updatedAt = new Date().toISOString();
    await leadStore.saveLead(lead);
    await leadService.syncDocumentChecklistTask(lead);

    const tasks = await getChecklistTasks(lead.id, "document_checklist");
    const activeTask = tasks.find((task) => task.status !== "dismissed");
    assert.ok(activeTask);
    assert.deepEqual(activeTask.meta?.missingKeys, ["signed_contract"]);
    assert.match(activeTask.description || "", /Contratto firmato/);
  });

  await runCase("chiude il task documenti quando tutto e completo", async () => {
    const lead = await createLeadFixture({ documents: buildDocuments(["identity_document"]) });
    await leadService.syncDocumentChecklistTask(lead);

    lead.documents = buildDocuments([]);
    lead.updatedAt = new Date().toISOString();
    await leadStore.saveLead(lead);
    await leadService.syncDocumentChecklistTask(lead);

    const tasks = await getChecklistTasks(lead.id, "document_checklist");
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].status, "done");
  });

  await runCase("crea payment_checklist se esiste almeno un pagamento required non verified", async () => {
    const lead = await createLeadFixture({
      payments: buildPayments({
        payment_deposit: { status: "verified" },
        payment_balance: { status: "pending", amount: 900 }
      })
    });
    await leadService.syncPaymentChecklistTask(lead);

    const tasks = await getChecklistTasks(lead.id, "payment_checklist");
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].status, "open");
    assert.deepEqual(tasks[0].meta?.pendingIds, ["payment_balance"]);
    assert.equal(tasks[0].meta?.pendingAmount, 900);
  });

  await runCase("aggiorna il task pagamenti se cambia il residuo o i pending", async () => {
    const lead = await createLeadFixture({
      payments: buildPayments({
        payment_deposit: { status: "pending", amount: 300 },
        payment_balance: { status: "pending", amount: 900 }
      })
    });
    await leadService.syncPaymentChecklistTask(lead);

    lead.payments = buildPayments({
      payment_deposit: { status: "verified", amount: 300 },
      payment_balance: { status: "received", amount: 700 }
    });
    lead.updatedAt = new Date().toISOString();
    await leadStore.saveLead(lead);
    await leadService.syncPaymentChecklistTask(lead);

    const tasks = await getChecklistTasks(lead.id, "payment_checklist");
    const activeTask = tasks.find((task) => task.status !== "dismissed");
    assert.ok(activeTask);
    assert.deepEqual(activeTask.meta?.pendingIds, ["payment_balance"]);
    assert.equal(activeTask.meta?.pendingAmount, 700);
    assert.match(activeTask.description || "", /Saldo/);
  });

  await runCase("chiude il task pagamenti quando tutto e verified", async () => {
    const lead = await createLeadFixture({
      payments: buildPayments({
        payment_deposit: { status: "pending" }
      })
    });
    await leadService.syncPaymentChecklistTask(lead);

    lead.payments = buildPayments({
      payment_deposit: { status: "verified" },
      payment_balance: { status: "verified" }
    });
    lead.updatedAt = new Date().toISOString();
    await leadStore.saveLead(lead);
    await leadService.syncPaymentChecklistTask(lead);

    const tasks = await getChecklistTasks(lead.id, "payment_checklist");
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].status, "done");
  });

  await runCase("non crea duplicati e se esistono ne lascia uno canonico dismissando gli altri", async () => {
    const lead = await createLeadFixture({ documents: buildDocuments(["identity_document"]) });

    await taskStore.createTask({
      leadId: lead.id,
      assignedTo: "operatore",
      kind: "document_checklist",
      title: "Documento duplicato 1",
      description: "",
      source: "automation",
      status: "open",
      priority: 80,
      dueAt: new Date().toISOString(),
      meta: null
    });
    await taskStore.createTask({
      leadId: lead.id,
      assignedTo: "operatore",
      kind: "document_checklist",
      title: "Documento duplicato 2",
      description: "",
      source: "automation",
      status: "open",
      priority: 80,
      dueAt: new Date().toISOString(),
      meta: null
    });

    await leadService.syncDocumentChecklistTask(lead);

    const tasks = await getChecklistTasks(lead.id, "document_checklist");
    assert.equal(tasks.filter((task) => task.status === "open").length, 1);
    assert.equal(tasks.filter((task) => task.status === "dismissed").length, 1);
  });

  await runCase("cleanup legacy duplicates lascia un task canonico per categoria", async () => {
    const lead = await createLeadFixture({ payments: buildPayments({ payment_balance: { status: "pending" } }) });

    await taskStore.createTask({
      leadId: lead.id,
      assignedTo: "operatore",
      kind: "payment_checklist",
      title: "Pagamento duplicato 1",
      description: "",
      source: "automation",
      status: "open",
      priority: 88,
      dueAt: new Date().toISOString(),
      meta: null
    });
    await taskStore.createTask({
      leadId: lead.id,
      assignedTo: "operatore",
      kind: "payment_checklist",
      title: "Pagamento duplicato 2",
      description: "",
      source: "automation",
      status: "open",
      priority: 88,
      dueAt: new Date().toISOString(),
      meta: null
    });

    await leadService.cleanupLegacyAutomaticTaskDuplicates();

    const tasks = await getChecklistTasks(lead.id, "payment_checklist");
    assert.equal(tasks.filter((task) => task.status !== "dismissed").length, 1);
    assert.equal(tasks.filter((task) => task.status === "dismissed").length, 1);
  });

  await runCase("scheduler riallinea correttamente i task documenti e pagamenti", async () => {
    const lead = await createLeadFixture({
      documents: buildDocuments(["identity_document"]),
      payments: buildPayments({ payment_balance: { status: "pending" } })
    });

    await leadService.ensureSlaTasks();

    let documentTasks = await getChecklistTasks(lead.id, "document_checklist");
    let paymentTasks = await getChecklistTasks(lead.id, "payment_checklist");
    assert.equal(documentTasks.filter((task) => task.status === "open").length, 1);
    assert.equal(paymentTasks.filter((task) => task.status === "open").length, 1);

    lead.documents = buildDocuments([]);
    lead.payments = buildPayments({
      payment_deposit: { status: "verified" },
      payment_balance: { status: "verified" }
    });
    lead.updatedAt = new Date().toISOString();
    await leadStore.saveLead(lead);

    await leadService.ensureSlaTasks();

    documentTasks = await getChecklistTasks(lead.id, "document_checklist");
    paymentTasks = await getChecklistTasks(lead.id, "payment_checklist");
    assert.equal(documentTasks[0].status, "done");
    assert.equal(paymentTasks[0].status, "done");
  });

  await runCase("PATCH lead rilancia correttamente la sync", async () => {
    const lead = await createLeadFixture({
      documents: buildDocuments(["identity_document"]),
      payments: buildPayments({ payment_balance: { status: "pending" } })
    });
    await leadService.syncDocumentChecklistTask(lead);
    await leadService.syncPaymentChecklistTask(lead);

    await new Promise<void>((resolve, reject) => {
      leadService.server.listen(0, "127.0.0.1", (error?: Error) => {
        if (error) reject(error);
        else resolve();
      });
    });

    try {
      const address = leadService.server.address();
      if (!address || typeof address === "string") throw new Error("Server test non disponibile.");
      const response = await fetch(`http://127.0.0.1:${address.port}/leads/${lead.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documents: buildDocuments([]),
          payments: buildPayments({
            payment_deposit: { status: "verified" },
            payment_balance: { status: "verified" }
          })
        })
      });
      assert.equal(response.status, 200);

      const documentTasks = await getChecklistTasks(lead.id, "document_checklist");
      const paymentTasks = await getChecklistTasks(lead.id, "payment_checklist");
      assert.equal(documentTasks.length, 1);
      assert.equal(paymentTasks.length, 1);
      assert.equal(documentTasks[0].status, "done");
      assert.equal(paymentTasks[0].status, "done");
    } finally {
      await new Promise<void>((resolve, reject) => leadService.server.close((error?: Error) => (error ? reject(error) : resolve())));
    }
  });
}

main()
  .then(() => {
    cleanupDb();
    console.log("All task-sync checks passed.");
  })
  .catch((error) => {
    cleanupDb();
    console.error(error);
    process.exitCode = 1;
  });
