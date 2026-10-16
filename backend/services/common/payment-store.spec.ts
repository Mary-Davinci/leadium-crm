import assert from "node:assert/strict";
import { saveLead, savePaymentPlan } from "./leadStore";
import * as mongo from "./mongo";

async function main() {
  const oldEnabled = mongo.isMongoEnabled, oldDb = mongo.getMongoDb;
  let stored: any = { _id: "lead-mongo", id: "lead-mongo", payments: { items: [], version: 0 }, status: "In contatto", notes: "Non perdere altri campi" };
  const timeline: any[] = [];
  const db = { collection: (name: string) => name === "leads" ? {
    updateOne: async (filter: any, update: any) => {
      if (!update.$set.payments) { stored = { ...stored, ...update.$set }; return { matchedCount: 1 }; }
      const expected = filter["payments.version"] ?? 0;
      if (stored._id !== filter._id || stored.payments.version !== expected || (filter.status !== undefined && filter.status !== stored.status)) return { matchedCount: 0 };
      assert.deepEqual(Object.keys(update), ["$set"]);
      assert.deepEqual(Object.keys(update.$set).sort(), ["payments", "updatedAt"]);
      stored = { ...stored, ...update.$set };
      return { matchedCount: 1 };
    },
    replaceOne: async (filter: any) => { assert.ok(filter.$or || filter["payments.version"] !== undefined); return { matchedCount: 0 }; },
    findOne: async () => ({ ...stored })
  } : { insertOne: async (activity: any) => { timeline.push(activity); } } };
  (mongo as any).isMongoEnabled = () => true;
  (mongo as any).getMongoDb = async () => db;
  try {
    const first = { items: [{ id: "payment_deposit", amount: 500, receivedAmount: 500, verifiedAmount: 0 }], version: 1, audit: [{ username: "real-user", changes: [{ field: "receivedAmount", before: 0, after: 500 }] }] };
    const [a, b] = await Promise.all([savePaymentPlan("lead-mongo", 0, first, { id: "a" }), savePaymentPlan("lead-mongo", 0, { ...first, version: 2 }, { id: "b" })]);
    assert.equal([a, b].filter(Boolean).length, 1);
    assert.equal(stored.payments.version, 1);
    assert.equal(stored.notes, "Non perdere altri campi");
    assert.equal(stored.payments.audit[0].username, "real-user");
    assert.equal(stored.payments.items[0].receivedAmount, 500);
    assert.equal(timeline.length, 1);
    console.log("PASS Mongo contract: compare-and-set, incasso e audit nello stesso update, nessuna sostituzione degli altri campi");
    assert.equal(await savePaymentPlan("lead-mongo", 1, { ...first, version: 2 }, { id: "closed-race" }, "Chiusa 100%"), null);
    assert.equal(stored.payments.version, 1);
    const second = await savePaymentPlan("lead-mongo", 1, { ...first, version: 2 }, { id: "c" });
    assert.equal(second.payments.version, 2);
    assert.equal(timeline.length, 2);
    console.log("PASS Mongo contract: reload e versione successiva");
    const stale = { id: "lead-mongo", notes: "Nota aggiornata", payments: { version: 0, items: [] } };
    await saveLead(stale);
    assert.equal(stored.payments.version, 2); assert.equal(stored.payments.items[0].receivedAmount, 500);
    assert.equal(stored.notes, "Nota aggiornata");
    console.log("PASS Mongo contract: un salvataggio anagrafico obsoleto preserva incasso e audit");
  } finally {
    (mongo as any).isMongoEnabled = oldEnabled;
    (mongo as any).getMongoDb = oldDb;
  }
}
main().catch(error => { console.error(error); process.exit(1); });
