import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getMongoDb, isMongoEnabled } from "../common/mongo";
import { emptyMonitorState, MonitorState } from "./threecx-normalizer";

export interface MonitorStore {
  claim(): Promise<MonitorState | null>;
  renew(): Promise<void>;
  save(state: MonitorState): Promise<void>;
  hasFinal(callId: string): Promise<boolean>;
  release(): Promise<void>;
}

/** One durable checkpoint/outbox and one expiring leader lease per PBX.
 * Mongo's _id uniqueness prevents two replicas from owning the listener simultaneously.
 * JSON is for local development; its short-lived lock protects the lease read/modify/write.
 */
export function createMonitorStore(pbx: string, filename = path.join(__dirname, "../../data/threecx-monitor.json")): MonitorStore {
  const owner = randomUUID();
  const id = "callcontrol:" + pbx;
  const leaseMs = 45000;
  const finalId = (callId: string) => id + ":" + callId;
  const local = <T>(run: (row: any) => { row: any; result: T }): T => {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    // Do not steal an abandoned lock: fail closed and let an operator inspect the local fixture.
    const lock = fs.openSync(filename + ".lock", "wx");
    try {
      const previous = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, "utf8")) : { _id: id, state: emptyMonitorState() };
      if (previous._id !== id) throw new Error("Monitor checkpoint PBX mismatch");
      const { row, result } = run(previous);
      const temp = filename + "." + owner + ".tmp";
      fs.writeFileSync(temp, JSON.stringify(row), { mode: 0o600 });
      fs.renameSync(temp, filename);
      return result;
    } finally { fs.closeSync(lock); fs.unlinkSync(filename + ".lock"); }
  };
  return {
    async renew() {
      const now = Date.now();
      if (!isMongoEnabled()) return local(row => {
        if (row.owner !== owner || row.leaseUntil <= now) throw new Error("Monitor lease lost");
        return { row: { ...row, leaseUntil: now + leaseMs }, result: undefined };
      });
      const db = await getMongoDb();
      const result = await db.collection("threecxMonitor").updateOne(
        { _id: id, owner, leaseUntil: { $gt: now } }, { $set: { leaseUntil: now + leaseMs } }
      );
      if (!result.matchedCount) throw new Error("Monitor lease lost");
    },
    async claim() {
      const now = Date.now();
      if (!isMongoEnabled()) return local(row => {
        if (row.owner && row.owner !== owner && row.leaseUntil > now) return { row, result: null };
        return { row: { ...row, owner, leaseUntil: now + leaseMs }, result: { ...row.state, finals: Object.fromEntries(Object.entries(row.state.finals || {}).filter(([, value]: any) => !value.delivered)) } };
      });
      const db = await getMongoDb();
      try {
        const row = await db.collection("threecxMonitor").findOneAndUpdate(
          { _id: id, $or: [{ owner }, { leaseUntil: { $lte: now } }, { owner: { $exists: false } }] },
          { $set: { owner, leaseUntil: now + leaseMs }, $setOnInsert: { state: emptyMonitorState() } },
          { upsert: true, returnDocument: "after" }
        );
        if (!row) return null;
        const pending = await db.collection("threecxFinalCalls").find({ pbx: id, delivered: false }).toArray();
        return { ...row.state, finals: Object.fromEntries(pending.map(item => [item.callId, { event: item.event, delivered: false }])) };
      } catch (error: any) { if (error.code === 11000) return null; throw error; }
    },
    async save(state) {
      const now = Date.now();
      if (!isMongoEnabled()) return local(row => {
        if (row.owner !== owner || row.leaseUntil <= now) throw new Error("Monitor lease lost");
        return { row: { ...row, state: { ...state, finals: { ...row.state.finals, ...state.finals } }, leaseUntil: now + leaseMs }, result: undefined };
      });
      const db = await getMongoDb();
      // Renew/check ownership before touching the outbox; native call ids have a unique _id.
      const lease = await db.collection("threecxMonitor").updateOne({ _id: id, owner, leaseUntil: { $gt: now } }, { $set: { leaseUntil: now + leaseMs } });
      if (!lease.matchedCount) throw new Error("Monitor lease lost");
      for (const [callId, final] of Object.entries(state.finals)) await db.collection("threecxFinalCalls").updateOne(
        { _id: finalId(callId) }, { $set: { pbx: id, callId, ...final } }, { upsert: true }
      );
      const result = await db.collection("threecxMonitor").updateOne(
        { _id: id, owner, leaseUntil: { $gt: now } }, { $set: { state: { calls: state.calls, finals: {} }, leaseUntil: now + leaseMs } }
      );
      if (!result.matchedCount) throw new Error("Monitor lease lost");
    },
    async hasFinal(callId) {
      if (!isMongoEnabled()) return local(row => ({ row, result: Boolean(row.state?.finals?.[callId]) }));
      const db = await getMongoDb();
      return Boolean(await db.collection("threecxFinalCalls").findOne({ _id: finalId(callId) }, { projection: { _id: 1 } }));
    },
    async release() {
      if (!isMongoEnabled()) return local(row => ({ row: row.owner === owner ? { ...row, owner: null, leaseUntil: 0 } : row, result: undefined }));
      const db = await getMongoDb();
      await db.collection("threecxMonitor").updateOne({ _id: id, owner }, { $unset: { owner: "" }, $set: { leaseUntil: 0 } });
    }
  };
}
