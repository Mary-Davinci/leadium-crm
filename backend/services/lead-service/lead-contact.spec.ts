import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const BACKEND_ROOT = path.join(__dirname, "..", "..", "..");
const TEST_DB_FILE = path.join(BACKEND_ROOT, "data", "db.lead-contact.test.json");
const TEST_CHAT_DB_FILE = path.join(BACKEND_ROOT, "data", "whatsapp.lead-contact.test.json");

process.env.NODE_ENV = "test";
process.env.JSON_DB_FILE = TEST_DB_FILE;
process.env.WHATSAPP_DB_FILE = TEST_CHAT_DB_FILE;
delete process.env.MONGO_URL;
delete process.env.MONGODB_URI;

const leadService = require("./server") as typeof import("./server");
const leadStore = require("../common/leadStore") as typeof import("../common/leadStore");
const customerStore = require("../common/customerStore") as typeof import("../common/customerStore");
const customerRoutes = require("./customer-routes") as typeof import("./customer-routes");
const correction = require("../common/contactCorrection") as typeof import("../common/contactCorrection");
const phoneIdentity = require("../common/phoneIdentity") as typeof import("../common/phoneIdentity");
const { internalIdentityHeaders } = require("../common/internalCapability") as typeof import("../common/internalCapability");

const ADMIN = { id: "u-admin", username: "admin.test", role: "admin" };
const OPERATOR = { id: "u-op", username: "operatore.test", role: "operatore" };

function resetDb() {
  fs.mkdirSync(path.dirname(TEST_DB_FILE), { recursive: true });
  fs.writeFileSync(TEST_DB_FILE, JSON.stringify({ leads: [], activities: [], tasks: [], callLogs: [], customers: [], purchases: [] }), "utf8");
}

function cleanupDb() {
  for (const file of [TEST_DB_FILE, TEST_CHAT_DB_FILE]) if (fs.existsSync(file)) fs.unlinkSync(file);
}

/** `trusted` mimics the gateway (in-process capability); otherwise a direct, anonymous caller. */
async function request(baseUrl: string, method: string, route: string, body?: unknown, trusted = true) {
  const response = await fetch(baseUrl + route, {
    method,
    headers: { "Content-Type": "application/json", ...(trusted ? internalIdentityHeaders() : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, body: await response.json() as any };
}

async function withServer(fn: (baseUrl: string) => Promise<void>) {
  await new Promise<void>((resolve, reject) => leadService.server.listen(0, "127.0.0.1", (error?: Error) => (error ? reject(error) : resolve())));
  try {
    const address = leadService.server.address();
    if (!address || typeof address === "string") throw new Error("Server test non disponibile.");
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => leadService.server.close((error?: Error) => (error ? reject(error) : resolve())));
  }
}

async function seedLead(fields: Record<string, unknown>) {
  const now = new Date().toISOString();
  return leadStore.createLead({ id: leadStore.newId("lead"), fullName: "Seed", status: "Da contattare", closingOutcome: "open", notes: "",
    documents: { items: [] }, payments: { items: [] }, callAttempts: 0, createdAt: now, updatedAt: now, ...fields }, []);
}

async function seedCustomer(phone: string, email = "") {
  return customerStore.findOrCreateCustomerByContact({ phone, email, fullName: "Cliente seed" });
}

function phoneKeyChecks() {
  const { phonesMatch, validateCorrectedPhone } = phoneIdentity;
  delete process.env.PHONE_DEFAULT_COUNTRY_CODE;
  // Without an explicit default country, no national number is merged with an international one.
  assert.ok(phonesMatch("+39 333 1234567", "0039 333 1234567"), "+ and 00 are the same international prefix");
  assert.ok(phonesMatch("+39 333 1234567", "393331234567"), "WhatsApp wa_id digits match the international form");
  assert.ok(phonesMatch("+44 7911 123456", "447911123456"));
  for (const national of ["333 1234567", "06 1234567", "3331234567"]) {
    assert.ok(!phonesMatch("+39 " + national, national), "shape alone does not identify Italy: " + national);
  }
  assert.ok(!phonesMatch("+44 7911 123456", "07911 123456"));
  assert.ok(phonesMatch("333 1234567", "3331234567"), "two national forms still match by digits");
  process.env.PHONE_DEFAULT_COUNTRY_CODE = "39";
  try {
    assert.ok(phonesMatch("+39 333 1234567", "333 1234567"), "explicit default country +39");
    assert.ok(phonesMatch("+39 06 1234567", "06 1234567"));
    assert.ok(!phonesMatch("+44 7911 123456", "07911 123456"), "a national number is never equated to a foreign prefix");
    assert.ok(!phonesMatch("+41 333 1234567", "333 1234567"), "only the configured country is assumed");
    assert.ok(!phonesMatch("+39 12345", "12345"), "non Italian-shaped national numbers are not equated");
  } finally { delete process.env.PHONE_DEFAULT_COUNTRY_CODE; }
  process.env.PHONE_DEFAULT_COUNTRY_CODE = "44";
  try { assert.ok(!phonesMatch("+39 333 1234567", "333 1234567"), "unsupported default country disables the rule"); }
  finally { delete process.env.PHONE_DEFAULT_COUNTRY_CODE; }
  assert.equal(validateCorrectedPhone("333 1234567").ok, false, "a correction without country prefix is ambiguous");
  assert.equal(validateCorrectedPhone("+39 333 1234567").ok, true);
  assert.equal(validateCorrectedPhone("0044 7911 123456").ok, true);
  console.log("PASS phone keys: +/00/wa_id equal; national = +39 only with PHONE_DEFAULT_COUNTRY_CODE=39; foreign/ambiguous never merged");
}

async function partialFailureChecks() {
  resetDb();
  const customer = await seedCustomer("+39 333 5550001");
  const lead = await seedLead({ phone: "+39 333 5550001", customerId: customer!.id });
  const plan = await correction.planLeadPhoneCorrection(lead, "+39 333 5550002", undefined);
  assert.ok(plan.ok && plan.updateCustomer, "sole lead with aligned customer: customer follows automatically");
  if (!plan.ok) return;
  const real = { setLeadPhone: leadStore.setLeadPhoneIfUnchanged, setCustomerPhone: customerStore.setCustomerPhoneIfUnchanged, appendActivity: async () => {} };
  const silence = console.error; console.error = () => {};
  try {
    await assert.rejects(correction.applyLeadPhoneCorrection(plan, lead.id, {}, { ...real, setLeadPhone: async () => { throw new Error("db down"); } }), /nessuna modifica applicata/);
    assert.equal((await customerStore.getCustomerById(customer!.id))!.phone, "+39 333 5550001", "customer restored when the lead write fails");
    await assert.rejects(correction.applyLeadPhoneCorrection(plan, lead.id, {}, { ...real, appendActivity: async () => { throw new Error("audit down"); } }), /Audit non disponibile/);
    assert.equal((await leadStore.getLeadById(lead.id)).phone, "+39 333 5550001", "lead restored when the audit cannot be written");
    assert.equal((await customerStore.getCustomerById(customer!.id))!.phone, "+39 333 5550001", "customer restored when the audit cannot be written");
    let calls = 0;
    const brokenUndo = { ...real, setCustomerPhone: async (...args: [string, string, string, string]) => (++calls === 1 ? real.setCustomerPhone(...args) : false), setLeadPhone: async () => { throw new Error("db down"); } };
    await assert.rejects(correction.applyLeadPhoneCorrection(plan, lead.id, {}, brokenUndo), (error: any) => error.incoherent === true && /verificare manualmente/.test(error.message));
  } finally { console.error = silence; }
  console.log("PASS partial failures are compensated; an impossible rollback is reported as incoherent, never as success");
}

async function main() {
  phoneKeyChecks();
  await partialFailureChecks();
  resetDb();
  await withServer(async (baseUrl) => {
    // --- Admin-only phone correction --------------------------------------------------------
    const created = await request(baseUrl, "POST", "/leads", { fullName: "Mario Rossi", phone: "+39 333 1112222", __creator: ADMIN });
    assert.equal(created.status, 201);
    const lead = created.body;
    const other = await request(baseUrl, "POST", "/leads", { fullName: "Luigi Bianchi", phone: "+39 333 3334444", __creator: ADMIN });
    assert.equal(other.status, 201);

    const forged = await request(baseUrl, "PATCH", `/leads/${lead.id}`, { phone: "+39 333 9998888", __contactActor: ADMIN }, false);
    assert.equal(forged.status, 403, "a direct caller cannot claim an admin identity in the body");
    const operator = await request(baseUrl, "PATCH", `/leads/${lead.id}`, { phone: "+39 333 9998888", __contactActor: OPERATOR });
    assert.equal(operator.status, 403);
    assert.equal((await request(baseUrl, "PATCH", `/leads/${lead.id}`, { phone: "333 9998888", __contactActor: ADMIN })).status, 400, "national format is ambiguous");
    assert.equal((await request(baseUrl, "PATCH", `/leads/${lead.id}`, { phone: "+39 333 9998888", notes: "x", __contactActor: ADMIN })).status, 400, "phone is corrected alone");
    const conflict = await request(baseUrl, "PATCH", `/leads/${lead.id}`, { phone: "0039 333 3334444", __contactActor: ADMIN });
    assert.equal(conflict.status, 409, "equivalent format of another person's number is a conflict");
    assert.equal(conflict.body.code, "phone_conflict_lead");
    assert.deepEqual(conflict.body.conflictLeadIds, [other.body.id]);
    assert.equal((await leadStore.getLeadById(lead.id)).phone, "+39 333 1112222", "refused corrections have no side effects");

    const changed = await request(baseUrl, "PATCH", `/leads/${lead.id}`, { phone: "+39 333 9998888", __contactActor: ADMIN, actor: "spoofed" });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.id, lead.id);
    assert.equal(changed.body.customerId, lead.customerId, "leadId and customerId are stable");
    assert.equal((await customerStore.getCustomerById(lead.customerId))!.phone, "+39 333 9998888", "sole, aligned customer follows the correction");
    const audit = (await leadStore.getTimelineByLeadId(lead.id)).filter((row: any) => row.type === "lead_phone_changed");
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actor, ADMIN.username, "author is the verified actor, not the client actor field");
    assert.deepEqual(audit[0].meta, { previousPhone: "+39 333 1112222", newPhone: "+39 333 9998888", changedById: ADMIN.id, changedByRole: "admin",
      customerId: lead.customerId, customerUpdated: true, previousCustomerPhone: "+39 333 1112222" });
    const noop = await request(baseUrl, "PATCH", `/leads/${lead.id}`, { phone: "+39 333 9998888", __contactActor: ADMIN });
    assert.equal(noop.status, 200);
    assert.equal((await leadStore.getTimelineByLeadId(lead.id)).filter((row: any) => row.type === "lead_phone_changed").length, 1, "no-op is not audited");

    // WhatsApp inbound (wa_id digits) from the corrected number resolves to the same lead/customer.
    const inbound = await customerRoutes.resolveLeadAssociationForPhone("393339998888");
    assert.deepEqual({ customerId: inbound.customerId, leadId: inbound.leadId }, { customerId: lead.customerId, leadId: lead.id });
    const outbound = await leadStore.getLeadById(lead.id);
    assert.equal(outbound.phone, "+39 333 9998888", "calls and outbound messages use the corrected lead phone");
    console.log("PASS correction: admin only, forged identity ignored, conflict without merge, customer follows, audited, WhatsApp resolves");

    // --- Shared or discordant customer: explicit choice --------------------------------------
    const shared = await seedCustomer("+39 347 1000001");
    const a = await seedLead({ phone: "+39 347 1000001", customerId: shared!.id });
    await seedLead({ phone: "+39 347 1000001", customerId: shared!.id, closingOutcome: "lost", status: "Perso" });
    const choice = await request(baseUrl, "PATCH", `/leads/${a.id}`, { phone: "+39 347 1000002", __contactActor: ADMIN });
    assert.equal(choice.status, 409);
    assert.equal(choice.body.code, "customer_choice_required");
    assert.equal(choice.body.impact.otherLeadCount, 1);
    assert.equal((await leadStore.getLeadById(a.id)).phone, "+39 347 1000001");
    const leadOnly = await request(baseUrl, "PATCH", `/leads/${a.id}`, { phone: "+39 347 1000002", customerPhoneScope: "lead_only", __contactActor: ADMIN });
    assert.equal(leadOnly.status, 200);
    assert.equal((await customerStore.getCustomerById(shared!.id))!.phone, "+39 347 1000001", "lead_only leaves the shared customer untouched");

    const discordantCustomer = await seedCustomer("+39 348 2000001");
    const d = await seedLead({ phone: "+39 348 2000009", customerId: discordantCustomer!.id });
    const discordant = await request(baseUrl, "PATCH", `/leads/${d.id}`, { phone: "+39 348 2000002", __contactActor: ADMIN });
    assert.equal(discordant.status, 409);
    assert.equal(discordant.body.impact.customerPhoneDiffers, true);
    const both = await request(baseUrl, "PATCH", `/leads/${d.id}`, { phone: "+39 348 2000002", customerPhoneScope: "lead_and_customer", __contactActor: ADMIN });
    assert.equal(both.status, 200);
    assert.equal((await customerStore.getCustomerById(discordantCustomer!.id))!.phone, "+39 348 2000002");

    await seedCustomer("+39 349 3000001");
    const lonely = await seedLead({ phone: "+39 349 3000099" });
    const customerClash = await request(baseUrl, "PATCH", `/leads/${lonely.id}`, { phone: "+39 349 3000001", __contactActor: ADMIN });
    assert.equal(customerClash.status, 409);
    assert.equal(customerClash.body.code, "phone_conflict_customer");
    console.log("PASS shared/discordant customer needs an explicit choice; another customer's number is a conflict");

    // --- Duplicate on creation ----------------------------------------------------------------
    const ambiguous = await request(baseUrl, "POST", "/leads", { fullName: "Senza paese", phone: "333 3334444", __creator: ADMIN });
    assert.equal(ambiguous.status, 201, "without a configured default country a national number is a separate contact");
    await leadStore.saveLead({ ...(await leadStore.getLeadById(ambiguous.body.id)), closingOutcome: "lost", status: "Perso" });
    process.env.PHONE_DEFAULT_COUNTRY_CODE = "39";
    const before = (await leadStore.listLeads()).length;
    const dedup = await request(baseUrl, "POST", "/leads", { fullName: "Nome Diverso", phone: "333 3334444", __creator: OPERATOR });
    delete process.env.PHONE_DEFAULT_COUNTRY_CODE;
    assert.equal(dedup.status, 200, "with PHONE_DEFAULT_COUNTRY_CODE=39 the national form of a +39 number is the same contact");
    assert.equal(dedup.body.mode, "deduplicated");
    assert.equal(dedup.body.matchedBy, "phone");
    assert.equal(dedup.body.lead.id, other.body.id);
    assert.equal(dedup.body.lead.fullName, "Luigi Bianchi", "a different name never overwrites the existing one");
    assert.equal(dedup.body.lead.status, other.body.status, "deduplication does not advance the practice");
    assert.equal((await leadStore.listLeads()).length, before, "no new record is created");

    const reserved = await leadStore.getLeadById(other.body.id);
    reserved.status = "Pronta per chiusura"; reserved.closingOutcome = "won"; reserved.notes = "nota originale";
    await leadStore.saveLead(reserved);
    const snapshot = JSON.stringify(await leadStore.getLeadById(other.body.id));
    for (const [label, creator, trusted] of [["operator", OPERATOR, true], ["forged admin, direct", ADMIN, false]] as const) {
      const blocked = await request(baseUrl, "POST", "/leads", { fullName: "Altro Nome", phone: "+39 333 3334444", email: "nuova@example.test", notes: "nota operatore", __creator: creator }, trusted);
      assert.equal(blocked.status, 409, label);
      assert.equal(blocked.body.code, "duplicate_admin_reserved");
      assert.equal(blocked.body.lead, undefined, "no data of the admin-reserved practice");
      assert.ok(!JSON.stringify(blocked.body).includes("Luigi"), "not even the name");
    }
    assert.equal(JSON.stringify(await leadStore.getLeadById(other.body.id)), snapshot, "notes, customer and every other field untouched");
    const adminDedup = await request(baseUrl, "POST", "/leads", { fullName: "Altro Nome", phone: "+39 333 3334444", __creator: ADMIN });
    assert.equal(adminDedup.status, 200);

    const byPhone = await request(baseUrl, "POST", "/leads", { fullName: "Telefono A", phone: "+39 340 4000001", __creator: ADMIN });
    const byEmail = await request(baseUrl, "POST", "/leads", { fullName: "Email B", phone: "+39 340 4000002", email: "b@example.test", __creator: ADMIN });
    assert.equal(byPhone.status, 201); assert.equal(byEmail.status, 201);
    const count = (await leadStore.listLeads()).length;
    const split = await request(baseUrl, "POST", "/leads", { fullName: "Misto", phone: "+39 340 4000001", email: "b@example.test", __creator: ADMIN });
    assert.equal(split.status, 409);
    assert.equal(split.body.code, "contact_conflict");
    assert.equal((await leadStore.listLeads()).length, count, "no record chosen, created or modified");

    // Returning customer: old sale closed 100% (assigned, with notes), new opportunity created.
    const closedSale = await seedLead({ phone: "+39 335 6000001", fullName: "Vendita chiusa", status: "Chiusa 100%", closingOutcome: "won", assignedTo: "operatore.test", notes: "storico" });
    const reopened = await request(baseUrl, "POST", "/leads", { fullName: "Nuova richiesta", phone: "+39 335 6000001", __creator: OPERATOR });
    assert.equal(reopened.status, 201, "a closed sale does not absorb a new opportunity");
    const listed = (await request(baseUrl, "GET", "/leads?view=summary")).body as any[];
    assert.ok(listed.some((row) => row.id === reopened.body.id), "the open opportunity is the row listed for this contact");
    assert.ok(!listed.some((row) => row.id === closedSale.id), "one row per contact (existing compaction kept)");
    console.log("PASS list compaction: an open opportunity is never hidden behind a closed practice of the same contact");

    await seedLead({ phone: "+44 7911 123456", fullName: "UK" });
    const foreign = await request(baseUrl, "POST", "/leads", { fullName: "Nazionale", phone: "07911 123456", __creator: ADMIN });
    assert.equal(foreign.status, 201, "a national number is not assumed to be the +44 one");
    console.log("PASS creation: same matching as correction; reserved duplicate hidden and untouched; split phone/email is a conflict");
  });
}

main()
  .then(() => { cleanupDb(); console.log("All lead-contact checks passed."); })
  .catch((error) => { cleanupDb(); console.error(error); process.exitCode = 1; });
