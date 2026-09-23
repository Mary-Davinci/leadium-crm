import { getMongoDb, isMongoEnabled } from "./mongo";
import { newId, readDb, writeDb } from "./jsonStore";

export type CallOutcome =
  | "completed"
  | "no_answer"
  | "busy"
  | "call_back"
  | "interested"
  | "not_interested"
  | "quote_required"
  | "quote_sent"
  | "appointment_set"
  | "other";

export type CallLogRecord = {
  id: string;
  leadId: string;
  startedAt: string;
  endedAt?: string;
  outcome: CallOutcome;
  actor: string;
  note?: string;
  idempotencyKey?: string;
  callbackReason?: string | null;
  source?: string;
};

function fromCallDoc(doc: any): CallLogRecord | null {
  if (!doc) return null;
  const item = { ...doc };
  if (!item.id) item.id = String(item._id);
  delete item._id;
  return item as CallLogRecord;
}

function toCallDoc(item: CallLogRecord) {
  return { ...item, _id: item.id };
}

export async function listCallLogsByLeadId(leadId: string) {
  if (!isMongoEnabled()) {
    const rows = readDb().callLogs || [];
    return rows
      .filter((item: CallLogRecord) => item.leadId === leadId)
      .sort((a: CallLogRecord, b: CallLogRecord) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  }
  const db = await getMongoDb();
  const docs = await db.collection("callLogs").find({ leadId }).sort({ startedAt: -1 }).toArray();
  return docs.map((doc) => fromCallDoc(doc)).filter(Boolean) as CallLogRecord[];
}

export async function listCallLogs(limit = 200) {
  const safeLimit = Math.max(1, Math.min(Number(limit || 200), 1000));
  if (!isMongoEnabled()) {
    const rows = readDb().callLogs || [];
    return rows
      .slice()
      .sort((a: CallLogRecord, b: CallLogRecord) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
      .slice(0, safeLimit);
  }
  const db = await getMongoDb();
  const docs = await db.collection("callLogs").find({}).sort({ startedAt: -1 }).limit(safeLimit).toArray();
  return docs.map((doc) => fromCallDoc(doc)).filter(Boolean) as CallLogRecord[];
}

// listCallLogs caps at 1000 (a UI-feed safeguard); a report needs the full history for its own
// date-range filter to be meaningful, not a silent recency cap on top of it.
export async function listAllCallLogs() {
  if (!isMongoEnabled()) {
    const rows = readDb().callLogs || [];
    return rows.slice().sort((a: CallLogRecord, b: CallLogRecord) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  }
  const db = await getMongoDb();
  const docs = await db.collection("callLogs").find({}).sort({ startedAt: -1 }).toArray();
  return docs.map((doc) => fromCallDoc(doc)).filter(Boolean) as CallLogRecord[];
}

export async function createCallLog(input: Omit<CallLogRecord, "id">) {
  const item: CallLogRecord = {
    id: newId("call"),
    ...input
  };

  if (!isMongoEnabled()) {
    const db = readDb();
    const rows = Array.isArray(db.callLogs) ? db.callLogs : [];
    rows.push(item);
    db.callLogs = rows;
    writeDb(db);
    return item;
  }

  const db = await getMongoDb();
  await db.collection("callLogs").insertOne(toCallDoc(item));
  return item;
}

export async function findCallLogByIdempotencyKey(leadId: string, idempotencyKey: string) {
  if (!leadId || !idempotencyKey) return null;

  if (!isMongoEnabled()) {
    const rows = (readDb().callLogs || []) as CallLogRecord[];
    return rows.find((item) => item.leadId === leadId && item.idempotencyKey === idempotencyKey) || null;
  }

  const db = await getMongoDb();
  const doc = await db.collection("callLogs").findOne({ leadId, idempotencyKey });
  return fromCallDoc(doc);
}

export async function getLatestCallMapByLeadIds(leadIds: string[]) {
  const ids = Array.from(new Set((leadIds || []).filter(Boolean)));
  const map = new Map<string, CallLogRecord>();
  if (!ids.length) return map;

  if (!isMongoEnabled()) {
    const rows = (readDb().callLogs || []) as CallLogRecord[];
    rows
      .filter((item) => ids.includes(item.leadId))
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
      .forEach((item) => {
        if (!map.has(item.leadId)) map.set(item.leadId, item);
      });
    return map;
  }

  const db = await getMongoDb();
  const docs = await db
    .collection("callLogs")
    .aggregate([
      { $match: { leadId: { $in: ids } } },
      { $sort: { startedAt: -1 } },
      { $group: { _id: "$leadId", doc: { $first: "$$ROOT" } } }
    ])
    .toArray();

  docs.forEach((row) => {
    const item = fromCallDoc(row.doc);
    if (item) map.set(String(row._id), item);
  });

  return map;
}
