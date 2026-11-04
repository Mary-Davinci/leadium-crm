import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getMongoDb, isMongoEnabled } from "./mongo";

/** Customer email shown in Leadium: replies read from the company mailbox and the mails sent from the CRM. */
export type MailRecord = {
  id: string;
  messageId: string;
  direction: "inbound" | "outbound";
  from: string;
  fromName: string;
  to: string;
  subject: string;
  text: string;
  receivedAt: string;
  inReplyTo: string;
  references: string[];
  leadId: string | null;
  attachments: Array<{ filename: string; mimeType: string; size: number }>;
  readAt: string | null;
  readBy: string;
  sentBy: string;
};

export type InboxSyncState = { uidValidity?: string; lastUid?: number; lastSyncAt?: string | null; lastError?: string | null };

const MAIL_DB_FILE = process.env.MAIL_DB_FILE
  ? path.resolve(process.env.MAIL_DB_FILE)
  : path.join(__dirname, "..", "..", "data", "mail.json");

type LocalMail = { messages: MailRecord[]; sync: InboxSyncState };

function readLocal(): LocalMail {
  try {
    const parsed = JSON.parse(fs.readFileSync(MAIL_DB_FILE, "utf8"));
    return { messages: Array.isArray(parsed.messages) ? parsed.messages : [], sync: parsed.sync || {} };
  } catch {
    return { messages: [], sync: {} };
  }
}

function writeLocal(data: LocalMail) {
  fs.mkdirSync(path.dirname(MAIL_DB_FILE), { recursive: true });
  fs.writeFileSync(MAIL_DB_FILE, JSON.stringify(data, null, 2), "utf8");
}

/** Stable per message: a second instance or a re-read of the mailbox finds the same record. */
export function mailRecordId(messageId: string) {
  return "mail_" + crypto.createHash("sha256").update(messageId).digest("hex").slice(0, 32);
}

const fromDoc = (doc: any): MailRecord => { const { _id, ...rest } = doc; return rest as MailRecord; };

/** False when the message was already stored: only the first reader acts on a new email. */
export async function saveMailIfNew(record: MailRecord) {
  if (!isMongoEnabled()) {
    const data = readLocal();
    if (data.messages.some((row) => row.id === record.id)) return false;
    data.messages.push(record);
    writeLocal(data);
    return true;
  }
  const db = await getMongoDb();
  try {
    await db.collection("mail_messages").insertOne({ ...record, _id: record.id } as any);
    return true;
  } catch (error: any) {
    if (error?.code === 11000) return false;
    throw error;
  }
}

export async function listMail(limit = 500): Promise<MailRecord[]> {
  if (!isMongoEnabled()) {
    return readLocal().messages.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, limit);
  }
  const db = await getMongoDb();
  return (await db.collection("mail_messages").find({}).sort({ receivedAt: -1 }).limit(limit).toArray()).map(fromDoc);
}

export async function getMail(id: string): Promise<MailRecord | null> {
  if (!isMongoEnabled()) return readLocal().messages.find((row) => row.id === id) || null;
  const db = await getMongoDb();
  const doc = await db.collection("mail_messages").findOne({ _id: id as any });
  return doc ? fromDoc(doc) : null;
}

export async function updateMail(id: string, patch: Partial<Pick<MailRecord, "readAt" | "readBy" | "leadId">>) {
  if (!isMongoEnabled()) {
    const data = readLocal();
    const row = data.messages.find((item) => item.id === id);
    if (!row) return null;
    Object.assign(row, patch);
    writeLocal(data);
    return row;
  }
  const db = await getMongoDb();
  await db.collection("mail_messages").updateOne({ _id: id as any }, { $set: patch });
  return getMail(id);
}

/** The practice a reply belongs to, from the mails it answers. */
export async function findLeadIdByMessageIds(messageIds: string[]) {
  const ids = messageIds.filter(Boolean);
  if (!ids.length) return null;
  if (!isMongoEnabled()) return readLocal().messages.find((row) => row.leadId && ids.includes(row.messageId))?.leadId || null;
  const db = await getMongoDb();
  const doc = await db.collection("mail_messages").findOne({ messageId: { $in: ids }, leadId: { $ne: null } });
  return doc?.leadId || null;
}

/** Linking one email to a practice links the sender's other unmatched emails too. */
export async function linkSenderToLead(from: string, leadId: string) {
  if (!isMongoEnabled()) {
    const data = readLocal();
    data.messages.filter((row) => row.from === from && !row.leadId).forEach((row) => { row.leadId = leadId; });
    writeLocal(data);
    return;
  }
  const db = await getMongoDb();
  await db.collection("mail_messages").updateMany({ from, leadId: null }, { $set: { leadId } });
}

export async function readInboxSync(): Promise<InboxSyncState> {
  if (!isMongoEnabled()) return readLocal().sync;
  const db = await getMongoDb();
  const doc = await db.collection("mail_sync").findOne({ _id: "inbox" as any });
  if (!doc) return {};
  const { _id, ...state } = doc;
  return state;
}

export async function writeInboxSync(patch: InboxSyncState) {
  if (!isMongoEnabled()) {
    const data = readLocal();
    data.sync = { ...data.sync, ...patch };
    writeLocal(data);
    return;
  }
  const db = await getMongoDb();
  await db.collection("mail_sync").updateOne({ _id: "inbox" as any }, { $set: patch }, { upsert: true });
}
