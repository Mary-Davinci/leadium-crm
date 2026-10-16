import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.NODE_ENV = "test";
process.env.META_CRM_SYNC_ENABLED = "false";
const dbFile = path.join(os.tmpdir(), "leadium-payment-editing-" + process.pid + ".json");
process.env.JSON_DB_FILE = dbFile;
process.env.MONGODB_URI = "";
process.env.MONGO_URL = "";
const leadService = require("./server");
const store = require("../common/leadStore");
let base: string, gateway: any;
let count = 0;
const users: any = { operatore: "payment-operator", admin: "payment-admin", super_admin: "payment-super" };
async function listen(server: any) { await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); return "http://127.0.0.1:" + server.address().port; }
async function request(method: string, route: string, body?: any, role = "operatore", raw?: string) {
  const response = await fetch(base + route, { method, headers: { "Content-Type": "application/json", Authorization: "Bearer " + users[role] }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  return { status: response.status, body: await response.json() as any };
}
async function seed(status = "In contatto", items?: any[]) {
  const now = new Date().toISOString();
  const lead = { id: store.newId("payment"), fullName: "Cliente pagamento", phone: "+393331234567", status, createdAt: now, updatedAt: now,
    payments: { items: items || [{ id: "payment_deposit", amount: 300, status: "pending" }, { id: "payment_balance", amount: 900, status: "pending" }] }, documents: { items: [] } };
  await store.createLead(lead); return lead;
}
function amounts(total: any = 2000, deposit: any = 500) { return { version: 0, total, items: [{ id: "payment_deposit", amount: deposit, status: "pending" }, { id: "payment_balance", amount: typeof total === "number" && typeof deposit === "number" ? Math.round((total - deposit) * 100) / 100 : 1500, status: "pending" }] }; }
async function test(name: string, fn: () => Promise<void>) { await fn(); count++; console.log("PASS " + name); }
async function main() {
  fs.writeFileSync(dbFile, JSON.stringify({ leads: [], activities: [], tasks: [], customers: [], purchases: [], callLogs: [] }));
  const leadUrl = await listen(leadService.server);
  process.env.LEAD_SERVICE_URL = leadUrl;
  gateway = require("../api-gateway/server");
  for (const role of Object.keys(users)) gateway.__setTestSession(users[role], { id: "id-" + role, username: "real-" + role, name: role, role });
  base = await listen(gateway.server);
  try {
    await test("matrice permessi: 3 ruoli x 3 stati x 2 rotte", async () => {
      for (const role of Object.keys(users)) for (const status of ["In contatto", "Pronta per chiusura", "Chiusa 100%"]) for (const dedicated of [false, true]) {
        const lead = await seed(status); const result = await request("PATCH", "/api/leads/" + lead.id + (dedicated ? "/payments/payment_deposit" : ""), dedicated ? { status: "received", actor: "falso" } : { payments: amounts(), actor: "falso", __paymentActor: { id: "fake", username: "fake", role: "admin" } }, role);
        const allowed = role !== "operatore" || status === "In contatto";
        assert.equal(result.status, allowed ? 200 : 403, JSON.stringify({ role, status, dedicated, result }));
        const stored = await store.getLeadById(lead.id);
        assert.equal(stored.payments.audit?.length || 0, allowed ? 1 : 0);
        if (allowed) assert.equal(stored.payments.audit[0].username, "real-" + role);
      }
    });
    await test("reload e isolamento tra pratiche; audit reale prima/dopo e motivo", async () => {
      const a = await seed(), b = await seed();
      const saved = await request("PATCH", "/api/leads/" + a.id, { payments: amounts(1200.37, 300.12), paymentReason: "Accordo cliente", actor: "spoof" });
      assert.equal(saved.status, 200, JSON.stringify(saved));
      const reload = await request("GET", "/api/leads/" + a.id);
      assert.equal(reload.body.lead.payments.items[0].amount, 300.12);
      assert.equal(reload.body.lead.payments.items[1].amount, 900.25);
      const disk = JSON.parse(fs.readFileSync(dbFile, "utf8"));
      assert.equal(disk.leads.find((row: any) => row.id === a.id).payments.items[0].amount, 300.12);
      assert.equal((await store.getLeadById(b.id)).payments.items[0].amount, 300);
      const event = reload.body.timeline.find((row: any) => row.type === "payments_updated");
      assert.equal(event.actor, "real-operatore"); assert.equal(event.meta.reason, "Accordo cliente");
      const audit = reload.body.lead.payments.audit[0];
      assert.equal(audit.userId, "id-operatore"); assert.ok(Number.isFinite(Date.parse(audit.at)));
      assert.ok(audit.changes.some((row: any) => row.field === "payment_deposit.amount" && row.before === 300 && row.after === 300.12));
    });
    await test("invalidi API: negativi, NaN/null, Infinity, centesimi, stati e totale incoerente", async () => {
      for (const input of [amounts(100, 101), amounts(NaN, 10), amounts(Infinity, 10), amounts(10, "bad"), amounts(10, 0.001), { ...amounts(), total: 999 }, { ...amounts(), items: amounts().items.map(row => ({ ...row, status: "invalid" })) }]) {
        const lead = await seed(); const response = await request("PATCH", "/api/leads/" + lead.id, { payments: input });
        assert.equal(response.status, 400, JSON.stringify(response)); assert.equal((await store.getLeadById(lead.id)).payments.version, undefined);
      }
      const lead = await seed(); const raw = '{"payments":{"version":0,"total":1e999,"items":[{"id":"payment_deposit","amount":1e999,"status":"pending"},{"id":"payment_balance","amount":0,"status":"pending"}]}}';
      assert.equal((await request("PATCH", "/api/leads/" + lead.id, undefined, "operatore", raw)).status, 400);
    });
    await test("legacy received/verified bloccate senza perdita degli importi storici", async () => {
      for (const status of ["received", "verified"]) {
        const lead = await seed("In contatto", [{ id: "payment_deposit", amount: 300, status }, { id: "payment_balance", amount: 900, status: "pending" }]);
        const before = JSON.stringify((await store.getLeadById(lead.id)).payments);
        assert.equal((await request("PATCH", "/api/leads/" + lead.id, { payments: amounts() }, "admin")).status, 409);
        assert.equal(JSON.stringify((await store.getLeadById(lead.id)).payments), before);
        const response = await request("GET", "/api/leads/" + lead.id);
        assert.equal(response.body.lead.payments.items[0].receivedAmount, 300);
        assert.equal(response.body.lead.payments.items[0].verifiedAmount, status === "verified" ? 300 : 0);
      }
    });
    await test("registrazione e verifica incasso; saldo modificabile senza cambiare il ricevuto", async () => {
      const lead = await seed();
      assert.equal((await request("PATCH", "/api/leads/" + lead.id + "/payments/payment_deposit", { status: "received" })).status, 200);
      assert.equal((await request("PATCH", "/api/leads/" + lead.id + "/payments/payment_deposit", { status: "verified" })).status, 200);
      const current = (await request("GET", "/api/leads/" + lead.id)).body.lead.payments;
      const next = { ...current, total: 2300, items: current.items.map((row: any) => row.id === "payment_balance" ? { ...row, amount: 2000 } : row) };
      const updated = await request("PATCH", "/api/leads/" + lead.id, { payments: next });
      assert.equal(updated.status, 200, JSON.stringify(updated)); assert.equal(updated.body.payments.items[0].receivedAmount, 300);
      assert.equal(updated.body.payments.items[0].verifiedAmount, 300);
      assert.equal((await request("PATCH", "/api/leads/" + lead.id + "/payments/payment_deposit", { status: "pending" })).status, 409);
    });
    await test("zero non ricevibile/verificabile da entrambe le rotte", async () => {
      for (const status of ["received", "verified"]) {
        const lead = await seed("In contatto", [{ id: "payment_deposit", amount: 0, status: "pending" }, { id: "payment_balance", amount: 0, status: "pending" }]);
        assert.equal((await request("PATCH", "/api/leads/" + lead.id + "/payments/payment_deposit", { status })).status, 400);
        const plan = amounts(0, 0); plan.items[0].status = status;
        assert.equal((await request("PATCH", "/api/leads/" + lead.id, { payments: plan })).status, 400);
      }
    });
    await test("doppio invio idempotente e conflitto concorrenza senza audit duplicato", async () => {
      const lead = await seed(); const body = { payments: amounts() };
      const result = await Promise.all([request("PATCH", "/api/leads/" + lead.id, body), request("PATCH", "/api/leads/" + lead.id, body)]);
      assert.ok(result.every(row => row.status === 200), JSON.stringify(result));
      const stored = await store.getLeadById(lead.id); assert.equal(stored.payments.audit.length, 1);
      assert.equal((await store.getTimelineByLeadId(lead.id)).filter((row: any) => row.type === "payments_updated").length, 1);
      assert.equal((await request("PATCH", "/api/leads/" + lead.id, { payments: amounts(3000, 500) })).status, 409);
      assert.equal((await store.getLeadById(lead.id)).payments.items[1].amount, 1500);
    });
    await test("sessione richiesta sul gateway e sulla rotta interna pagamenti", async () => {
      const lead = await seed(); const external = await fetch(base + "/api/leads/" + lead.id, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ payments: amounts() }) });
      assert.equal(external.status, 401);
      const direct = await fetch(leadUrl + "/leads/" + lead.id, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ payments: amounts() }) }); assert.equal(direct.status, 401);
    });
    await test("alias slash non bypassano permessi o identita sessione", async () => {
      for (const suffix of ["/payments/payment_deposit/", "//payments//payment_deposit"]) {
        const lead = await seed("Chiusa 100%");
        const response = await request("PATCH", "/api/leads/" + lead.id + suffix, { status: "received", __paymentActor: { id: "fake", username: "fake", role: "admin" } });
        assert.equal(response.status, 403);
      }
    });
    await test("creazione non puo inizializzare incassi o importi invalidi", async () => {
      for (const payment of [{ amount: -1, status: "pending" }, { amount: 100, status: "verified" }, { amount: 100, status: "pending", receivedAmount: 100 }]) {
        const response = await request("POST", "/api/leads", { fullName: "Invalido", phone: "+393339999999", payments: { items: [{ id: "payment_deposit", ...payment }] } });
        assert.equal(response.status, 400);
      }
    });
    await test("un salvataggio anagrafico obsoleto non cancella piano o audit nuovi", async () => {
      const lead = await seed(); const stale = await store.getLeadById(lead.id);
      assert.equal((await request("PATCH", "/api/leads/" + lead.id, { payments: amounts() })).status, 200);
      stale.notes = "Nota parallela";
      await store.saveLead(stale);
      const saved = await store.getLeadById(lead.id);
      assert.equal(saved.notes, "Nota parallela"); assert.equal(saved.payments.version, 1);
      assert.equal(saved.payments.audit.length, 1); assert.equal(saved.payments.items[0].amount, 500);
    });
    console.log("All " + count + " payment-editing integration groups passed.");
  } finally {
    await new Promise<void>(resolve => gateway.server.close(() => resolve()));
    await new Promise<void>(resolve => leadService.server.close(() => resolve()));
    fs.unlinkSync(dbFile);
  }
}
main().catch(error => { console.error(error); process.exit(1); });
