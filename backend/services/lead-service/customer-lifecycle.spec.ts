import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const BACKEND_ROOT = path.join(__dirname, "..", "..", "..");
const TEST_DB_FILE = path.join(BACKEND_ROOT, "data", "db.customer-lifecycle.test.json");

process.env.NODE_ENV = "test";
process.env.JSON_DB_FILE = TEST_DB_FILE;
delete process.env.MONGO_URL;
delete process.env.MONGODB_URI;

const leadService = require("./server") as typeof import("./server");
const leadStore = require("../common/leadStore") as typeof import("../common/leadStore");
const customerStore = require("../common/customerStore") as typeof import("../common/customerStore");
const purchaseStore = require("../common/purchaseStore") as typeof import("../common/purchaseStore");

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

async function patchJson(baseUrl: string, path: string, body: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

async function getJson(baseUrl: string, path: string) {
  const response = await fetch(`${baseUrl}${path}`);
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

async function main() {
  await runCase("stesso telefono/email crea/risolve sempre lo stesso Customer", async () => {
    const same1 = await customerStore.findOrCreateCustomerByContact({ phone: "+39 333 1112222", email: "mario@example.com" });
    const same2 = await customerStore.findOrCreateCustomerByContact({ phone: "+39 333 1112222", email: "mario@example.com" });
    assert.equal(same1?.id, same2?.id);

    const byEmailOnly1 = await customerStore.findOrCreateCustomerByContact({ email: "Giulia@Example.com" });
    const byEmailOnly2 = await customerStore.findOrCreateCustomerByContact({ email: "giulia@example.com" });
    assert.equal(byEmailOnly1?.id, byEmailOnly2?.id, "email normalization deve essere case-insensitive");
  });

  await runCase("stesso Customer puo avere piu Lead quando il precedente e chiuso", async () => {
    await withServer(async (baseUrl) => {
      const first = await postJson(baseUrl, "/leads", { fullName: "Anna Bianchi", phone: "+39 340 1234567", email: "anna@example.com" });
      assert.equal(first.status, 201);
      const firstLeadId = first.body.id as string;
      const customerId = first.body.customerId as string;
      assert.ok(customerId);

      // Close the first opportunity as lost (workflow requires passing through "interessato" first).
      const interested = await postJson(baseUrl, `/leads/${firstLeadId}/status`, { toStatus: "Contatto interessato" });
      assert.equal(interested.status, 200);
      const closed = await postJson(baseUrl, `/leads/${firstLeadId}/status`, { toStatus: "Persa", lossReason: "non_interessato" });
      assert.equal(closed.status, 200);
      assert.equal(closed.body.closingOutcome, "lost");

      // The same person gets back in touch -- must create a NEW opportunity, not merge into the closed one.
      const second = await postJson(baseUrl, "/leads", { fullName: "Anna Bianchi", phone: "+39 340 1234567", email: "anna@example.com" });
      assert.equal(second.status, 201);
      const secondLeadId = second.body.id as string;
      assert.notEqual(secondLeadId, firstLeadId, "deve essere creato un nuovo lead, non riusare quello chiuso");
      assert.equal(second.body.customerId, customerId, "il nuovo lead deve restare collegato allo stesso customer");
      assert.equal(second.body.status, "Da contattare");

      // The first (closed) lead must be untouched by the new contact.
      const firstAfter = await getJson(baseUrl, `/leads/${firstLeadId}`);
      assert.equal(firstAfter.body.lead.closingOutcome, "lost");

      const customerDetail = await getJson(baseUrl, `/customers/${customerId}`);
      assert.equal(customerDetail.status, 200);
      assert.equal(customerDetail.body.leads.length, 2, "il customer deve mostrare entrambe le opportunita");
    });
  });

  await runCase("un lead in post-vendita ma non ancora chiuso al 100% continua a fondersi (non e ancora terminale)", async () => {
    await withServer(async (baseUrl) => {
      const created = await postJson(baseUrl, "/leads", { fullName: "Cliente In Corso", phone: "+39 350 1112233" });
      const leadId = created.body.id as string;
      await postJson(baseUrl, `/leads/${leadId}/status`, { toStatus: "Contatto interessato" });
      await postJson(baseUrl, `/leads/${leadId}/status`, { toStatus: "Vendita unica" });
      const sold = await postJson(baseUrl, `/leads/${leadId}/status`, { toStatus: "Venduta" });
      assert.equal(sold.status, 200);
      const postSale = await postJson(baseUrl, `/leads/${leadId}/status`, { toStatus: "Invio gadget" });
      assert.equal(postSale.status, 200);
      assert.equal(postSale.body.closingOutcome, "won");

      const recontact = await postJson(baseUrl, "/leads", { fullName: "Cliente In Corso", phone: "+39 350 1112233" });
      assert.equal(recontact.status, 200);
      assert.equal(recontact.body.mode, "deduplicated");
      assert.equal(recontact.body.lead.id, leadId, "un lead in post-vendita non ancora chiuso al 100% deve continuare a fondersi");
    });
  });

  await runCase("un lead chiuso al 100% (won) genera una nuova opportunita su recontact", async () => {
    await withServer(async (baseUrl) => {
      const created = await postJson(baseUrl, "/leads", { fullName: "Cliente Chiuso", phone: "+39 351 4445566" });
      const leadId = created.body.id as string;
      const customerId = created.body.customerId as string;
      await postJson(baseUrl, `/leads/${leadId}/status`, { toStatus: "Contatto interessato" });
      await postJson(baseUrl, `/leads/${leadId}/status`, { toStatus: "Vendita unica" });
      await postJson(baseUrl, `/leads/${leadId}/status`, { toStatus: "Venduta" });
      await postJson(baseUrl, `/leads/${leadId}/status`, { toStatus: "Pronta per chiusura" });
      const closed = await postJson(baseUrl, `/leads/${leadId}/status`, { toStatus: "Chiusa 100%" });
      assert.equal(closed.status, 200);
      assert.equal(closed.body.closingOutcome, "won");

      const recontact = await postJson(baseUrl, "/leads", { fullName: "Cliente Chiuso", phone: "+39 351 4445566" });
      assert.equal(recontact.status, 201, "una pratica chiusa al 100% e terminale: il recontact crea una nuova opportunita");
      assert.notEqual(recontact.body.id, leadId);
      assert.equal(recontact.body.customerId, customerId);
    });
  });

  await runCase("il merge normale resta invariato quando il lead esistente e ancora aperto", async () => {
    await withServer(async (baseUrl) => {
      const first = await postJson(baseUrl, "/leads", { fullName: "Paolo Neri", phone: "+39 320 9998888" });
      assert.equal(first.status, 201);
      const second = await postJson(baseUrl, "/leads", { fullName: "Paolo Neri", phone: "+39 320 9998888", email: "paolo@example.com" });
      assert.equal(second.status, 200);
      assert.equal(second.body.mode, "deduplicated");
      assert.equal(second.body.lead.id, first.body.id, "lead ancora aperto: deve fondersi come prima, nessun nuovo lead");
    });
  });

  await runCase("lead con contatti distinti non vengono accidentalmente fusi", async () => {
    await withServer(async (baseUrl) => {
      const a = await postJson(baseUrl, "/leads", { fullName: "Cliente A", phone: "+39 111 1111111", email: "a@example.com" });
      const b = await postJson(baseUrl, "/leads", { fullName: "Cliente B", phone: "+39 222 2222222", email: "b@example.com" });
      assert.notEqual(a.body.id, b.body.id);
      assert.notEqual(a.body.customerId, b.body.customerId);
    });
  });

  await runCase("customer con 3 acquisti validi -> LTV somma corretta", async () => {
    const customer = await customerStore.findOrCreateCustomerByContact({ phone: "+39 300 1112223", fullName: "Luca Verdi" });
    assert.ok(customer);
    await purchaseStore.createPurchase({ customerId: customer!.id, leadId: null, amount: 1200, currency: "EUR", status: "completed", purchasedAt: "2026-01-10T00:00:00.000Z" });
    await purchaseStore.createPurchase({ customerId: customer!.id, leadId: null, amount: 800, currency: "EUR", status: "completed", purchasedAt: "2026-03-01T00:00:00.000Z" });
    await purchaseStore.createPurchase({ customerId: customer!.id, leadId: null, amount: 500, currency: "EUR", status: "completed", purchasedAt: "2026-02-15T00:00:00.000Z" });

    const purchases = await purchaseStore.listPurchasesByCustomerId(customer!.id);
    const ltv = purchaseStore.computeLtvFromPurchases(purchases);
    assert.equal(ltv.ltv, 2500);
    assert.equal(ltv.purchaseCount, 3);
    assert.equal(ltv.averageOrderValue, 2500 / 3);
    assert.equal(ltv.firstPurchaseAt, "2026-01-10T00:00:00.000Z");
    assert.equal(ltv.lastPurchaseAt, "2026-03-01T00:00:00.000Z");
  });

  await runCase("acquisto cancellato non contribuisce alla LTV", async () => {
    const customer = await customerStore.findOrCreateCustomerByContact({ phone: "+39 300 5556666", fullName: "Sara Gialli" });
    assert.ok(customer);
    await purchaseStore.createPurchase({ customerId: customer!.id, leadId: null, amount: 1000, currency: "EUR", status: "completed", purchasedAt: "2026-01-01T00:00:00.000Z" });
    await purchaseStore.createPurchase({ customerId: customer!.id, leadId: null, amount: 900, currency: "EUR", status: "cancelled", purchasedAt: "2026-01-05T00:00:00.000Z" });

    const purchases = await purchaseStore.listPurchasesByCustomerId(customer!.id);
    const ltv = purchaseStore.computeLtvFromPurchases(purchases);
    assert.equal(ltv.ltv, 1000);
    assert.equal(ltv.purchaseCount, 1);
  });

  await runCase("customer senza acquisti -> LTV 0", async () => {
    const customer = await customerStore.findOrCreateCustomerByContact({ phone: "+39 300 7778889", fullName: "Nessun Acquisto" });
    assert.ok(customer);
    const purchases = await purchaseStore.listPurchasesByCustomerId(customer!.id);
    const ltv = purchaseStore.computeLtvFromPurchases(purchases);
    assert.equal(ltv.ltv, 0);
    assert.equal(ltv.purchaseCount, 0);
    assert.equal(ltv.averageOrderValue, 0);
    assert.equal(ltv.firstPurchaseAt, null);
    assert.equal(ltv.lastPurchaseAt, null);
  });

  await runCase("lead legacy senza customerId continua a essere leggibile", async () => {
    const now = new Date().toISOString();
    const legacyLead = {
      id: leadStore.newId("lead"),
      fullName: "Lead Storico",
      phone: "+39 399 0001111",
      email: "storico@example.com",
      source: "manuale",
      status: "Da contattare",
      notes: "",
      documents: { items: [] },
      payments: { items: [] },
      callAttempts: 0,
      nextActionAt: null,
      createdAt: now,
      updatedAt: now
      // no customerId field at all, as pre-migration leads would look like
    };
    await leadStore.createLead(legacyLead, []);

    await withServer(async (baseUrl) => {
      const response = await getJson(baseUrl, `/leads/${legacyLead.id}`);
      assert.equal(response.status, 200);
      assert.equal(response.body.lead.id, legacyLead.id);
      assert.equal(response.body.lead.customerId, null, "customerId assente deve tornare null, non far fallire la risposta");
    });
  });

  await runCase("il matching/backfill del customer e idempotente", async () => {
    const first = await customerStore.findOrCreateCustomerByContact({ phone: "+39 388 4445555", email: "idem@example.com", fullName: "Idempotente Test" });
    const second = await customerStore.findOrCreateCustomerByContact({ phone: "+39 388 4445555", email: "idem@example.com", fullName: "Idempotente Test" });
    const third = await customerStore.findOrCreateCustomerByContact({ phone: "+39 388 4445555", email: "" });
    assert.equal(first?.id, second?.id);
    assert.equal(first?.id, third?.id);

    const all = await customerStore.listCustomersByIds([first!.id, second!.id, third!.id]);
    assert.equal(all.length, 1, "chiamate ripetute non devono creare customer duplicati");
  });

  await runCase("registrare un acquisto su un lead aggiorna correttamente LTV via API customer detail", async () => {
    await withServer(async (baseUrl) => {
      const created = await postJson(baseUrl, "/leads", { fullName: "Cliente Compratore", phone: "+39 366 1231234" });
      const leadId = created.body.id as string;
      const customerId = created.body.customerId as string;

      const purchase1 = await postJson(baseUrl, `/leads/${leadId}/purchases`, { amount: 1500, purchasedAt: "2026-04-01T00:00:00.000Z" });
      assert.equal(purchase1.status, 201);
      const purchase2 = await postJson(baseUrl, `/leads/${leadId}/purchases`, { amount: 400, status: "pending", purchasedAt: "2026-04-05T00:00:00.000Z" });
      assert.equal(purchase2.status, 201);

      const detail = await getJson(baseUrl, `/customers/${customerId}`);
      assert.equal(detail.status, 200);
      assert.equal(detail.body.ltv.ltv, 1500, "solo l'acquisto completed deve contribuire alla LTV");
      assert.equal(detail.body.ltv.purchaseCount, 1);
      assert.equal(detail.body.purchases.length, 2, "lo storico acquisti deve includere anche quelli non validi per LTV");

      const cancelled = await patchJson(baseUrl, `/purchases/${purchase2.body.id}`, { status: "cancelled" });
      assert.equal(cancelled.status, 200);
      assert.equal(cancelled.body.status, "cancelled");
    });
  });
}

main()
  .then(() => {
    cleanupDb();
    console.log("All customer-lifecycle checks passed.");
  })
  .catch((error) => {
    cleanupDb();
    console.error(error);
    process.exitCode = 1;
  });
