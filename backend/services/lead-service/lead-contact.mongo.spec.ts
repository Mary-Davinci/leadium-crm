/**
 * Contact correction against a real, ISOLATED MongoDB (the production persistence path).
 * Not part of `npm test` (needs a disposable server). Reproducible run:
 *   docker run -d --rm --name leadium-it-mongo -p 127.0.0.1:27999:27017 mongo:7
 *   npm run build && LEADIUM_MONGO_IT_URI=mongodb://127.0.0.1:27999 node dist/services/lead-service/lead-contact.mongo.spec.js
 *   docker stop leadium-it-mongo
 * Refuses any non-loopback URI; uses a throwaway database that is dropped at the end.
 */
import assert from "node:assert/strict";

const uri = String(process.env.LEADIUM_MONGO_IT_URI || "");
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(uri)) {
  console.error("Refusing to run: LEADIUM_MONGO_IT_URI must be a loopback mongodb:// URI of a disposable server.");
  process.exit(2);
}
const DB_NAME = "leadium_it_" + process.pid + "_" + Date.now();
// Set before any module loads backend/.env (loadEnv never overrides existing values).
Object.assign(process.env, {
  MONGODB_URI: uri, MONGODB_DB_NAME: DB_NAME, NODE_ENV: "integration",
  LEAD_SERVICE_PORT: "0", INTERNAL_SERVICE_HOST: "127.0.0.1",
  WORKFLOW_SERVICE_URL: "http://127.0.0.1:9", WHATSAPP_SERVICE_URL: "http://127.0.0.1:9",
  WHATSAPP_AUTOMATION_ENABLED: "false", META_CRM_SYNC_ENABLED: "false",
  META_ACCESS_TOKEN: "", WHATSAPP_ACCESS_TOKEN: "", WHATSAPP_APP_SECRET: "", SLA_TASK_INTERVAL_MS: "3600000"
});
delete process.env.PHONE_DEFAULT_COUNTRY_CODE;

const mongo = require("../common/mongo") as typeof import("../common/mongo");
const leadStore = require("../common/leadStore") as typeof import("../common/leadStore");
const customerStore = require("../common/customerStore") as typeof import("../common/customerStore");
const correction = require("../common/contactCorrection") as typeof import("../common/contactCorrection");
const customerRoutes = require("./customer-routes") as typeof import("./customer-routes");
const { internalIdentityHeaders } = require("../common/internalCapability") as typeof import("../common/internalCapability");

const ADMIN = { id: "u-admin", username: "admin.it", role: "admin" };
const OPERATOR = { id: "u-op", username: "operatore.it", role: "operatore" };
let seq = 0;

async function db() { return (await mongo.getMongoDb())!; }
async function rawLead(id: string) { return (await db()).collection("leads").findOne({ _id: id }); }
async function rawCustomer(id: string) { return (await db()).collection("customers").findOne({ _id: id }); }
async function activities(leadId: string, type: string) { return (await db()).collection("activities").find({ leadId, type }).toArray(); }

async function seed(phone: string, extra: Record<string, unknown> = {}, customerPhone: string | null = phone) {
  const now = new Date().toISOString();
  const customer = customerPhone === null ? null : await customerStore.findOrCreateCustomerByContact({ phone: customerPhone, email: "", fullName: "Cliente IT" });
  const lead = await leadStore.createLead({ id: `lead_it_${++seq}`, fullName: "Lead IT " + seq, phone, status: "Da contattare", closingOutcome: "open",
    notes: "", documents: { items: [] }, payments: { items: [] }, callAttempts: 0, createdAt: now, updatedAt: now, customerId: customer?.id || null, ...extra }, []);
  return { lead, customer };
}

async function main() {
  const leadService = require("./server") as typeof import("./server");
  if (!leadService.server.listening) await new Promise<void>(resolve => leadService.server.once("listening", () => resolve()));
  const address = leadService.server.address();
  if (!address || typeof address === "string") throw new Error("lead-service not listening");
  const base = `http://127.0.0.1:${address.port}`;
  const call = async (method: string, path: string, body: unknown, trusted = true) => {
    const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(trusted ? internalIdentityHeaders() : {}) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  assert.ok(mongo.isMongoEnabled(), "the Mongo path must be the one under test");

  // 1. Consistent lead + customer update, stable ids, audit in Mongo, WhatsApp recognition.
  const a = await seed("+39 333 1110001");
  const ok = await call("PATCH", `/leads/${a.lead.id}`, { phone: "+39 333 1110002", __contactActor: ADMIN });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const leadDoc = await rawLead(a.lead.id), customerDoc = await rawCustomer(a.customer!.id);
  assert.deepEqual([leadDoc!.phone, leadDoc!.phoneNormalized, leadDoc!.customerId], ["+39 333 1110002", "393331110002", a.customer!.id]);
  assert.deepEqual([customerDoc!.phone, customerDoc!.phoneNormalized], ["+39 333 1110002", "393331110002"]);
  const audit = await activities(a.lead.id, "lead_phone_changed");
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor, "admin.it");
  assert.equal(audit[0].meta.customerUpdated, true);
  assert.equal(audit[0].meta.previousCustomerPhone, "+39 333 1110001");
  const inbound = await customerRoutes.resolveLeadAssociationForPhone("393331110002");
  assert.deepEqual([inbound.customerId, inbound.leadId], [a.customer!.id, a.lead.id], "WhatsApp wa_id of the corrected number resolves to the same identity");
  assert.equal((await customerRoutes.resolveLeadAssociationForPhone("393331110001")).customerId, null, "old number no longer resolves (existing threads stay linked by leadId)");
  console.log("PASS mongo: lead+customer updated together, ids stable, audit stored, WhatsApp resolves the corrected number");

  // 2. Conflicts leave Mongo untouched; forged identity from a direct caller is ignored.
  const b = await seed("+39 333 2220001");
  const before = JSON.stringify([await rawLead(a.lead.id), await rawCustomer(a.customer!.id)]);
  assert.equal((await call("PATCH", `/leads/${a.lead.id}`, { phone: "0039 333 2220001", __contactActor: ADMIN })).body.code, "phone_conflict_lead");
  assert.equal((await call("PATCH", `/leads/${a.lead.id}`, { phone: "+39 333 9990009", __contactActor: ADMIN }, false)).status, 403);
  assert.equal((await call("PATCH", `/leads/${a.lead.id}`, { phone: "+39 333 9990009", __contactActor: OPERATOR })).status, 403);
  await seed("+39 333 3330009", {}, "+39 333 3330001");
  assert.equal((await call("PATCH", `/leads/${a.lead.id}`, { phone: "+39 333 3330001", __contactActor: ADMIN })).body.code, "phone_conflict_customer");
  assert.equal(JSON.stringify([await rawLead(a.lead.id), await rawCustomer(a.customer!.id)]), before, "no write on conflict");
  assert.equal((await activities(a.lead.id, "lead_phone_changed")).length, 1, "no audit on conflict");
  void b;
  console.log("PASS mongo: lead/customer conflicts and forged identities change nothing");

  const writer = { setLeadPhone: leadStore.setLeadPhoneIfUnchanged, setCustomerPhone: customerStore.setCustomerPhoneIfUnchanged,
    appendActivity: async (row: any) => leadStore.appendActivities([row]) };
  const quiet = console.error; console.error = () => {};
  try {
    // 3. Failure after the first write (customer done, lead write throws): customer restored, no audit.
    const c = await seed("+39 333 4440001");
    const planC = await correction.planLeadPhoneCorrection(c.lead, "+39 333 4440002", undefined);
    assert.ok(planC.ok && planC.updateCustomer);
    if (!planC.ok) return;
    await assert.rejects(correction.applyLeadPhoneCorrection(planC, c.lead.id, { leadId: c.lead.id, type: "lead_phone_changed" },
      { ...writer, setLeadPhone: async () => { throw new Error("write failed"); } }), /nessuna modifica applicata/);
    assert.equal((await rawCustomer(c.customer!.id))!.phone, "+39 333 4440001");
    assert.equal((await rawCustomer(c.customer!.id))!.phoneNormalized, "393334440001");
    assert.equal((await activities(c.lead.id, "lead_phone_changed")).length, 0);

    // 4. Concurrent edit of the lead between plan and apply: refused, customer restored.
    const planC2 = await correction.planLeadPhoneCorrection(await leadStore.getLeadById(c.lead.id), "+39 333 4440003", undefined);
    if (!planC2.ok) throw new Error("plan");
    await (await db()).collection("leads").updateOne({ _id: c.lead.id }, { $set: { phone: "+39 333 4449999", phoneNormalized: "393334449999" } });
    await assert.rejects(correction.applyLeadPhoneCorrection(planC2, c.lead.id, { leadId: c.lead.id, type: "lead_phone_changed" }, writer), /modificato nel frattempo/);
    assert.equal((await rawLead(c.lead.id))!.phone, "+39 333 4449999", "the concurrent value is kept");
    assert.equal((await rawCustomer(c.customer!.id))!.phone, "+39 333 4440001", "customer restored");
    assert.equal((await activities(c.lead.id, "lead_phone_changed")).length, 0);

    // 5. Compensation never overwrites a later change: reported as incoherent, later value kept.
    const d = await seed("+39 333 5550001");
    const planD = await correction.planLeadPhoneCorrection(d.lead, "+39 333 5550002", undefined);
    if (!planD.ok) throw new Error("plan");
    await assert.rejects(correction.applyLeadPhoneCorrection(planD, d.lead.id, { leadId: d.lead.id, type: "lead_phone_changed" }, { ...writer,
      setLeadPhone: async () => {
        await (await db()).collection("customers").updateOne({ _id: d.customer!.id }, { $set: { phone: "+39 333 5557777", phoneNormalized: "393335557777" } });
        throw new Error("write failed");
      } }), (error: any) => error.incoherent === true);
    assert.equal((await rawCustomer(d.customer!.id))!.phone, "+39 333 5557777", "later customer edit not overwritten by the rollback");
    assert.equal((await activities(d.lead.id, "lead_phone_changed")).length, 0);

    // 6. Audit write fails: both writes compensated, nothing recorded as done.
    const e = await seed("+39 333 6660001");
    const planE = await correction.planLeadPhoneCorrection(e.lead, "+39 333 6660002", undefined);
    if (!planE.ok) throw new Error("plan");
    await assert.rejects(correction.applyLeadPhoneCorrection(planE, e.lead.id, {}, { ...writer, appendActivity: async () => { throw new Error("audit down"); } }), /Audit non disponibile/);
    assert.equal((await rawLead(e.lead.id))!.phone, "+39 333 6660001");
    assert.equal((await rawLead(e.lead.id))!.phoneNormalized, "393336660001");
    assert.equal((await rawCustomer(e.customer!.id))!.phone, "+39 333 6660001");
  } finally { console.error = quiet; }
  console.log("PASS mongo: failure after first write, concurrent edit, non-overwriting compensation and audit failure");

  // 7. Shared customer needs a choice; lead_only leaves the customer (and WhatsApp recognition) as is.
  const shared = await seed("+39 333 7770001");
  await seed("+39 333 7770001", { status: "Perso", closingOutcome: "lost", customerId: shared.customer!.id }, null);
  assert.equal((await call("PATCH", `/leads/${shared.lead.id}`, { phone: "+39 333 7770002", __contactActor: ADMIN })).body.code, "customer_choice_required");
  assert.equal((await call("PATCH", `/leads/${shared.lead.id}`, { phone: "+39 333 7770002", customerPhoneScope: "lead_only", __contactActor: ADMIN })).status, 200);
  assert.equal((await rawCustomer(shared.customer!.id))!.phone, "+39 333 7770001");
  assert.equal((await customerRoutes.resolveLeadAssociationForPhone("393337770002")).customerId, null, "lead_only: new number not recognised for WhatsApp");
  assert.match((await activities(shared.lead.id, "lead_phone_changed"))[0].text, /NON modificata/);
  console.log("PASS mongo: shared customer requires explicit choice; lead_only is recorded as partial");

  // 8. Creation dedup on Mongo: reserved practice hidden and untouched; split phone/email conflict;
  //    national vs +39 merged only with the explicit default-country setting.
  const reserved = await seed("+39 333 8880001", { status: "Pronta per chiusura", closingOutcome: "won", notes: "originale" });
  const snapshot = JSON.stringify(await rawLead(reserved.lead.id));
  const blocked = await call("POST", "/leads", { fullName: "Altro", phone: "+39 333 8880001", notes: "x", __creator: OPERATOR });
  assert.equal(blocked.status, 409); assert.equal(blocked.body.lead, undefined);
  assert.equal(JSON.stringify(await rawLead(reserved.lead.id)), snapshot);
  await seed("+39 333 8880002"); await seed("+39 333 8880003", { email: "it@example.test" });
  assert.equal((await call("POST", "/leads", { fullName: "Misto", phone: "+39 333 8880002", email: "it@example.test", __creator: ADMIN })).body.code, "contact_conflict");
  const national = await call("POST", "/leads", { fullName: "Nazionale", phone: "333 8880002", __creator: ADMIN });
  assert.equal(national.status, 201, "without PHONE_DEFAULT_COUNTRY_CODE a national number is not merged");
  process.env.PHONE_DEFAULT_COUNTRY_CODE = "39";
  try {
    const merged = await call("POST", "/leads", { fullName: "Nazionale 2", phone: "333 8880003", __creator: ADMIN });
    assert.equal(merged.body.mode, "deduplicated", "with PHONE_DEFAULT_COUNTRY_CODE=39 the national form matches +39");
  } finally { delete process.env.PHONE_DEFAULT_COUNTRY_CODE; }
  console.log("PASS mongo: creation dedup hides reserved practice, split contact conflicts, country rule only when configured");
}

main()
  .then(async () => { await (await db()).dropDatabase(); console.log("All lead-contact Mongo integration checks passed (database dropped)."); process.exit(0); })
  .catch(async (error) => { console.error(error); try { await (await db()).dropDatabase(); } catch { /* best effort */ } process.exit(1); });
