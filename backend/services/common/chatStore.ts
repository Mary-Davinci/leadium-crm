import fs from "fs";
import path from "path";
import { isMongoEnabled, getMongoDb } from "./mongo";
import { newId } from "./jsonStore";

const CHAT_DB_FILE = process.env.WHATSAPP_DB_FILE
  ? path.resolve(process.env.WHATSAPP_DB_FILE)
  : path.join(__dirname, "..", "..", "data", "whatsapp.json");
let mongoIndexesReady = false;

const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

function normalizePhone(phone: string) {
  return String(phone || "").replace(/\D+/g, "");
}

function normalizeMessageStatus(status: unknown) {
  const value = String(status || "").trim().toLowerCase();
  if (value === "read") return "read";
  if (value === "delivered") return "delivered";
  if (value === "failed") return "failed";
  if (value === "simulated") return "simulated";
  if (value === "received") return "received";
  return "sent";
}

function ensureLocalFile() {
  const dir = path.dirname(CHAT_DB_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(CHAT_DB_FILE)) {
    fs.writeFileSync(CHAT_DB_FILE, JSON.stringify({ conversations: [], messages: [] }, null, 2), "utf8");
  }
}

function readLocal() {
  ensureLocalFile();
  const raw = fs.readFileSync(CHAT_DB_FILE, "utf8");
  try {
    const parsed = JSON.parse(raw);
    return {
      conversations: Array.isArray(parsed.conversations) ? parsed.conversations : [],
      messages: Array.isArray(parsed.messages) ? parsed.messages : []
    };
  } catch {
    return { conversations: [], messages: [] };
  }
}

function writeLocal(data: any) {
  ensureLocalFile();
  fs.writeFileSync(CHAT_DB_FILE, JSON.stringify(data, null, 2), "utf8");
}

async function ensureMongoIndexes() {
  if (!isMongoEnabled() || mongoIndexesReady) return;
  const db = await getMongoDb();
  await Promise.all([
    db.collection("wa_conversations").createIndex({ phoneNormalized: 1 }),
    db.collection("wa_conversations").createIndex({ lastMessageAt: -1 }),
    db.collection("wa_conversations").createIndex({ assignedTo: 1, status: 1 }),
    db.collection("wa_conversations").createIndex({ customerId: 1 }),
    db.collection("wa_messages").createIndex({ conversationId: 1, createdAt: -1 }),
    db.collection("wa_messages").createIndex({ providerMessageId: 1 })
  ]);
  mongoIndexesReady = true;
}

function toIsoDate(value: unknown) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function computeSessionMeta(conversation: any) {
  const replyWindowExpiresAt = toIsoDate(conversation.replyWindowExpiresAt);
  const expiresAtMs = replyWindowExpiresAt ? new Date(replyWindowExpiresAt).getTime() : 0;
  const now = Date.now();
  return {
    replyWindowExpiresAt: replyWindowExpiresAt || null,
    hasOpenSession: Boolean(expiresAtMs && expiresAtMs > now),
    channel: String(conversation.channel || conversation.source || "whatsapp")
  };
}

function normalizeConversation(doc: any) {
  if (!doc) return null;
  const out = { ...doc };
  if (!out.id) out.id = String(out._id);
  delete out._id;
  delete out.phoneNormalized;
  return { ...out, ...computeSessionMeta(out) };
}

function normalizeMessage(doc: any) {
  if (!doc) return null;
  const out = { ...doc };
  if (!out.id) out.id = String(out._id);
  delete out._id;
  return out;
}

export async function listConversations() {
  if (!isMongoEnabled()) {
    return readLocal()
      .conversations.sort((a: any, b: any) => new Date(b.lastMessageAt || 0).getTime() - new Date(a.lastMessageAt || 0).getTime())
      .map(normalizeConversation);
  }
  await ensureMongoIndexes();
  const db = await getMongoDb();
  const docs = await db.collection("wa_conversations").find({}).sort({ lastMessageAt: -1 }).toArray();
  return docs.map(normalizeConversation);
}

export async function getConversationById(conversationId: string) {
  if (!isMongoEnabled()) return normalizeConversation(readLocal().conversations.find((c: any) => c.id === conversationId) || null);
  await ensureMongoIndexes();
  const db = await getMongoDb();
  const doc = await db.collection("wa_conversations").findOne({ _id: conversationId });
  return normalizeConversation(doc);
}

export async function listMessages(conversationId: string, limit = 100) {
  if (!isMongoEnabled()) {
    return readLocal()
      .messages.filter((m: any) => m.conversationId === conversationId)
      .sort((a: any, b: any) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      .slice(-limit);
  }
  await ensureMongoIndexes();
  const db = await getMongoDb();
  const docs = await db.collection("wa_messages").find({ conversationId }).sort({ createdAt: 1 }).limit(limit).toArray();
  return docs.map(normalizeMessage);
}

/**
 * Meta is documented to retry webhook delivery, and handleInboundWebhook used to call
 * appendMessage unconditionally for every message in the payload -- a retried delivery created a
 * duplicate message row with a new local id but the same providerMessageId. This lookup is the
 * idempotency check that closes that gap.
 */
export async function findMessageByProviderId(providerMessageId: string) {
  if (!providerMessageId) return null;
  if (!isMongoEnabled()) {
    return readLocal().messages.find((m: any) => m.providerMessageId === providerMessageId) || null;
  }
  await ensureMongoIndexes();
  const db = await getMongoDb();
  const doc = await db.collection("wa_messages").findOne({ providerMessageId });
  return normalizeMessage(doc);
}

export async function findConversationByPhone(phone: string) {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  if (!isMongoEnabled()) {
    return normalizeConversation(readLocal().conversations.find((c: any) => normalizePhone(c.phone) === normalized) || null);
  }
  await ensureMongoIndexes();
  const db = await getMongoDb();
  const doc = await db.collection("wa_conversations").findOne({ phoneNormalized: normalized });
  return normalizeConversation(doc);
}

// A Customer can in principle end up with more than one conversation record (e.g. they were
// first contacted on an old number, then a new one) -- listConversations is already sorted by
// lastMessageAt desc, so picking the first match here means "the most recently active one",
// a safe default tie-breaker rather than an arbitrary pick.
export async function findConversationByCustomerId(customerId: string) {
  const id = String(customerId || "").trim();
  if (!id) return null;
  const conversations = await listConversations();
  return conversations.find((c: any) => String(c.customerId || "") === id) || null;
}

async function saveConversation(conversation: any) {
  const now = new Date().toISOString();
  const payload = {
    channel: "whatsapp",
    status: "open",
    unreadCount: 0,
    lastInboundAt: null,
    lastOutboundAt: null,
    replyWindowExpiresAt: null,
    hasOpenSession: false,
    customerId: null,
    ...conversation,
    updatedAt: conversation.updatedAt || now
  };
  if (!isMongoEnabled()) {
    const local = readLocal();
    const idx = local.conversations.findIndex((c: any) => c.id === payload.id);
    if (idx >= 0) local.conversations[idx] = payload;
    else local.conversations.push(payload);
    writeLocal(local);
    return payload;
  }
  await ensureMongoIndexes();
  const db = await getMongoDb();
  const doc = { ...payload, _id: payload.id, phoneNormalized: normalizePhone(payload.phone) };
  await db.collection("wa_conversations").replaceOne({ _id: payload.id }, doc, { upsert: true });
  return payload;
}

export async function createOrUpdateConversation({
  phone,
  customerName = "",
  leadId = null,
  customerId = null,
  assignedTo = "",
  incrementUnread = false,
  lastMessagePreview = "",
  source = "whatsapp",
  status,
  lastInboundAt,
  lastOutboundAt,
  replyWindowExpiresAt
}: any) {
  const existing = await findConversationByPhone(phone);
  const now = new Date().toISOString();
  if (existing) {
    const nextReplyWindow = replyWindowExpiresAt !== undefined ? replyWindowExpiresAt : existing.replyWindowExpiresAt || null;
    const updated = {
      ...existing,
      customerName: customerName || existing.customerName || "",
      // leadId is sticky once set (a conversation never silently re-targets to a different
      // opportunity) -- enforced here, not just by caller convention, so a future caller can't
      // accidentally rebind an existing conversation by passing a different leadId. customerId is
      // filled in the same way but represents the person, who doesn't change, so backfilling it
      // on a legacy conversation is always safe regardless of which side wins.
      leadId: existing.leadId || leadId || null,
      customerId: customerId || existing.customerId || null,
      assignedTo: assignedTo !== undefined ? assignedTo : existing.assignedTo || "",
      status: status || existing.status || "open",
      channel: existing.channel || source || "whatsapp",
      unreadCount: incrementUnread ? (existing.unreadCount || 0) + 1 : existing.unreadCount || 0,
      lastMessagePreview: lastMessagePreview || existing.lastMessagePreview || "",
      lastInboundAt: lastInboundAt !== undefined ? lastInboundAt : existing.lastInboundAt || null,
      lastOutboundAt: lastOutboundAt !== undefined ? lastOutboundAt : existing.lastOutboundAt || null,
      replyWindowExpiresAt: nextReplyWindow,
      lastMessageAt: now,
      updatedAt: now
    };
    return saveConversation(updated);
  }
  const created = {
    id: newId("wa_conv"),
    phone,
    customerName: customerName || phone,
    leadId: leadId || null,
    customerId: customerId || null,
    assignedTo: assignedTo || "",
    status: status || "open",
    channel: source || "whatsapp",
    source,
    unreadCount: incrementUnread ? 1 : 0,
    lastMessagePreview: lastMessagePreview || "",
    lastInboundAt: lastInboundAt || null,
    lastOutboundAt: lastOutboundAt || null,
    replyWindowExpiresAt: replyWindowExpiresAt || null,
    lastMessageAt: now,
    createdAt: now,
    updatedAt: now
  };
  return saveConversation(created);
}

export async function appendMessage(message: any) {
  const createdAt = message.createdAt || new Date().toISOString();
  const payload = {
    id: message.id || newId("wa_msg"),
    conversationId: message.conversationId,
    direction: message.direction,
    text: message.text || "",
    status: normalizeMessageStatus(message.status || (message.direction === "inbound" ? "received" : "sent")),
    messageType: message.messageType || "text",
    templateKey: message.templateKey || "",
    templateName: message.templateName || "",
    from: message.from || "",
    to: message.to || "",
    providerMessageId: message.providerMessageId || "",
    agentName: message.agentName || "",
    // Additive: a message can reference one media attachment. Inbound carries what Meta's
    // webhook sends (mediaId/mimeType/filename/caption, no bytes -- Meta hosts the media, we
    // never proxy or store the binary); outbound carries a reference into this CRM's own
    // document storage (documentStorageKey) rather than a second, parallel file store.
    attachment: message.attachment || null,
    raw: message.raw || null,
    createdAt
  };
  if (!isMongoEnabled()) {
    const local = readLocal();
    local.messages.push(payload);
    writeLocal(local);
  } else {
    await ensureMongoIndexes();
    const db = await getMongoDb();
    await db.collection("wa_messages").insertOne({ ...payload, _id: payload.id });
  }

  const conversation = await getConversationById(payload.conversationId);
  if (conversation) {
    const sessionUpdate =
      payload.direction === "inbound"
        ? {
            unreadCount: Number(conversation.unreadCount || 0) + 1,
            lastInboundAt: createdAt,
            replyWindowExpiresAt: new Date(new Date(createdAt).getTime() + REPLY_WINDOW_MS).toISOString()
          }
        : {
            lastOutboundAt: createdAt
          };
    await saveConversation({
      ...conversation,
      lastMessagePreview: payload.text || conversation.lastMessagePreview || "",
      lastMessageAt: createdAt,
      updatedAt: createdAt,
      ...sessionUpdate
    });
  }
  return payload;
}

export async function markConversationRead(conversationId: string) {
  const conversation = await getConversationById(conversationId);
  if (!conversation) return null;
  conversation.unreadCount = 0;
  conversation.updatedAt = new Date().toISOString();
  return saveConversation(conversation);
}

export async function updateConversation(conversationId: string, patch: any) {
  const conversation = await getConversationById(conversationId);
  if (!conversation) return null;
  return saveConversation({
    ...conversation,
    ...patch,
    updatedAt: new Date().toISOString()
  });
}

export async function updateMessageStatusByProviderId(providerMessageId: string, status: string) {
  if (!providerMessageId) return 0;
  const normalizedStatus = normalizeMessageStatus(status);
  if (!isMongoEnabled()) {
    const local = readLocal();
    let count = 0;
    local.messages = local.messages.map((m: any) => {
      if (m.providerMessageId === providerMessageId) {
        count += 1;
        return { ...m, status: normalizedStatus };
      }
      return m;
    });
    writeLocal(local);
    return count;
  }
  await ensureMongoIndexes();
  const db = await getMongoDb();
  const res = await db.collection("wa_messages").updateMany({ providerMessageId }, { $set: { status: normalizedStatus } });
  return res.modifiedCount || 0;
}
