// @ts-nocheck
require("../../loadEnv");

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  listConversations,
  getConversationById,
  listMessages,
  createOrUpdateConversation,
  appendMessage,
  findMessageByProviderId,
  findConversationByPhone,
  findConversationByCustomerId,
  markConversationRead,
  updateConversation,
  updateMessageStatusByProviderId
} = require("../common/chatStore");

const HOST = "0.0.0.0";
const PORT = Number(process.env.WHATSAPP_SERVICE_PORT || 4306);
const LEAD_URL = process.env.LEAD_SERVICE_URL || "http://localhost:4301";
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || "dev_whatsapp_token";
const APP_SECRET = process.env.WHATSAPP_APP_SECRET || process.env.META_APP_SECRET || "";
if (!APP_SECRET && process.env.NODE_ENV !== "test") {
  console.warn(
    "[whatsapp-service] WHATSAPP_APP_SECRET/META_APP_SECRET non configurato: le richieste in ingresso su /webhook non vengono verificate tramite X-Hub-Signature-256. Da configurare prima di collegare un numero reale."
  );
}
const WA_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || "";
const WA_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "";
const WA_GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || "v25.0";
const WA_TEMPLATE_CONFIG_PATH =
  process.env.WHATSAPP_TEMPLATE_CONFIG_PATH || path.join(__dirname, "..", "..", "config", "whatsapp-templates.json");

const DEFAULT_TEMPLATE_CONFIG = [
  {
    key: "reopen_contact",
    name: "reopen_contact",
    label: "Ricontatto pratica",
    body: "Ciao, ti ricontattiamo per aggiornarti sulla tua pratica.",
    category: "followup",
    suggestionTag: "task"
  },
  {
    key: "request_documents",
    name: "request_documents",
    label: "Richiesta documenti",
    body: "Ciao, ci servono i documenti mancanti per proseguire con la pratica.",
    category: "utility",
    suggestionTag: "documents"
  },
  {
    key: "payment_followup",
    name: "payment_followup",
    label: "Promemoria pagamento",
    body: "Ciao, ti contattiamo per il pagamento in sospeso della tua pratica.",
    category: "utility",
    suggestionTag: "payments"
  },
  {
    key: "booking_update",
    name: "booking_update",
    label: "Aggiornamento prenotazione",
    body: "Ciao, abbiamo un aggiornamento sulla tua prenotazione.",
    category: "utility",
    suggestionTag: "generic"
  },
  {
    key: "reschedule_callback",
    name: "reschedule_callback",
    label: "Ricontattami",
    body: "Ciao, se preferisci essere richiamato in un altro momento facci sapere quando: ti richiamiamo noi.",
    category: "followup",
    suggestionTag: "callback"
  },
  {
    key: "not_interested_ack",
    name: "not_interested_ack",
    label: "Non interessato",
    body: "Ciao, grazie per averci contattato. Se in futuro dovessi essere di nuovo interessato, siamo a disposizione.",
    category: "followup",
    suggestionTag: "not_interested"
  }
];

function loadTemplateConfig() {
  try {
    if (WA_TEMPLATE_CONFIG_PATH && fs.existsSync(WA_TEMPLATE_CONFIG_PATH)) {
      const fileRaw = fs.readFileSync(WA_TEMPLATE_CONFIG_PATH, "utf8");
      const fileParsed = JSON.parse(fileRaw);
      if (Array.isArray(fileParsed)) {
        const normalizedFromFile = fileParsed
          .map((item) => ({
            key: String(item?.key || item?.name || "").trim(),
            name: String(item?.name || item?.key || "").trim(),
            label: String(item?.label || item?.name || item?.key || "").trim(),
            body: String(item?.body || "").trim(),
            category: String(item?.category || "utility").trim().toLowerCase() === "followup" ? "followup" : "utility",
            suggestionTag: String(item?.suggestionTag || "generic").trim().toLowerCase()
          }))
          .filter((item) => item.key && item.name && item.label);
        if (normalizedFromFile.length) return normalizedFromFile;
      }
    }
  } catch {
    // Fallback to env/default below.
  }
  const raw = String(process.env.WHATSAPP_TEMPLATE_CONFIG_JSON || "").trim();
  if (!raw) return DEFAULT_TEMPLATE_CONFIG;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_TEMPLATE_CONFIG;
    const normalized = parsed
      .map((item) => ({
        key: String(item?.key || item?.name || "").trim(),
        name: String(item?.name || item?.key || "").trim(),
        label: String(item?.label || item?.name || item?.key || "").trim(),
        body: String(item?.body || "").trim(),
        category: String(item?.category || "utility").trim().toLowerCase() === "followup" ? "followup" : "utility",
        suggestionTag: String(item?.suggestionTag || "generic").trim().toLowerCase()
      }))
      .filter((item) => item.key && item.name && item.label);
    return normalized.length ? normalized : DEFAULT_TEMPLATE_CONFIG;
  } catch {
    return DEFAULT_TEMPLATE_CONFIG;
  }
}

const TEMPLATE_CONFIG = loadTemplateConfig();

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 2_000_000) {
        reject(new Error("Body too large"));
      }
    });
    req.on("end", () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (error) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 2_000_000) {
        reject(new Error("Body too large"));
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// Meta signs every webhook delivery with X-Hub-Signature-256 (HMAC-SHA256 of the raw body,
// keyed with the app secret from the Meta app config). Without this check, anyone who discovers
// the webhook URL could POST forged inbound messages/status events. Skipped only when
// WHATSAPP_APP_SECRET isn't configured (local/dev/test), matching how WA_ACCESS_TOKEN missing
// falls back to simulated send mode elsewhere in this file.
function isValidWebhookSignature(rawBody, signatureHeader) {
  if (!APP_SECRET) return true;
  const header = String(signatureHeader || "");
  if (!header.startsWith("sha256=")) return false;
  const provided = header.slice("sha256=".length);
  const expected = crypto.createHmac("sha256", APP_SECRET).update(rawBody, "utf8").digest("hex");
  const providedBuffer = Buffer.from(provided, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  if (providedBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

function routeMatch(pathname, pattern) {
  const pathSegments = pathname.split("/").filter(Boolean);
  const patternSegments = pattern.split("/").filter(Boolean);
  if (pathSegments.length !== patternSegments.length) return null;

  const params = {};
  for (let i = 0; i < patternSegments.length; i += 1) {
    const current = patternSegments[i];
    const value = pathSegments[i];
    if (current.startsWith(":")) {
      params[current.slice(1)] = decodeURIComponent(value);
      continue;
    }
    if (current !== value) return null;
  }
  return params;
}

function extractInboundText(message) {
  if (!message) return "";
  if (message.text && message.text.body) return message.text.body;
  if (message.button && message.button.text) return message.button.text;
  if (message.interactive && message.interactive.button_reply && message.interactive.button_reply.title) {
    return message.interactive.button_reply.title;
  }
  if (message.interactive && message.interactive.list_reply && message.interactive.list_reply.title) {
    return message.interactive.list_reply.title;
  }
  if (message.type && message[message.type] && message[message.type].caption) {
    return message[message.type].caption;
  }
  return `[${message.type || "message"}]`;
}

// Meta's webhook never sends attachment bytes -- only a mediaId that must later be resolved via
// the (real, official) Media Graph API endpoint. We only ever store this reference metadata, never
// proxy or persist the binary ourselves.
const INBOUND_MEDIA_TYPES = new Set(["image", "document", "audio", "video", "sticker"]);

function extractInboundAttachment(message) {
  if (!message || !INBOUND_MEDIA_TYPES.has(message.type)) return null;
  const media = message[message.type] || {};
  if (!media.id) return null;
  return {
    direction: "inbound",
    mediaType: message.type,
    mediaId: media.id,
    mimeType: media.mime_type || "",
    filename: media.filename || "",
    caption: media.caption || "",
    sha256: media.sha256 || ""
  };
}

function getReplyWindowExpiresAt(createdAt) {
  return new Date(new Date(createdAt || Date.now()).getTime() + 24 * 60 * 60 * 1000).toISOString();
}

const CUSTOMER_ACTION_LABELS = {
  callback_request: "Il cliente ha richiesto di essere ricontattato via WhatsApp.",
  not_interested: "Il cliente ha indicato via WhatsApp di non essere interessato."
};

// Maps a real Meta interactive button/list reply id to a known structured action. No real
// template with quick-reply buttons is registered on Meta this session, so this path is built but
// never exercised with real credentials -- whoever registers the template must use these exact
// button ids (this CRM's own convention, not a Meta requirement).
const CUSTOMER_ACTION_BUTTON_IDS = {
  action_callback_request: "callback_request",
  action_not_interested: "not_interested"
};

function extractCustomerActionFromMessage(message) {
  const buttonId = (message && message.interactive && message.interactive.button_reply && message.interactive.button_reply.id) ||
    (message && message.interactive && message.interactive.list_reply && message.interactive.list_reply.id) ||
    (message && message.button && message.button.payload) ||
    "";
  return CUSTOMER_ACTION_BUTTON_IDS[buttonId] || null;
}

async function createLeadActivity(leadId, type, text, meta = {}) {
  try {
    await fetch(`${LEAD_URL}/leads/${leadId}/activities`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, text, actor: "whatsapp_customer_action", meta })
    });
  } catch (error) {
    // Best-effort: the conversation/message record is the source of truth for the raw signal
    // even if the lead-service activity write fails transiently.
  }
}

async function createLeadTask(leadId, input) {
  try {
    await fetch(`${LEAD_URL}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leadId, source: "whatsapp_customer_action", ...input })
    });
  } catch (error) {}
}

/**
 * Side effects for a recognized structured customer action, applied to an already-resolved lead.
 *
 * RICONTATTAMI (callback_request): always safe to act on -- activity + a review task. No date/time
 * is invented; the task explicitly asks the operator to agree one with the customer.
 *
 * NON INTERESSATO (not_interested): deliberately does NOT auto-close the lead. The workflow's
 * valid status transitions differ by the lead's current status (see workflow.ts FLOW -- e.g. a
 * lead already "Contatto interessato" has no direct NOT_INTERESTED transition, only LOST, which
 * requires an explicit lossReason this raw signal doesn't supply). Auto-picking a transition or a
 * reason would be putting words in the customer's mouth. This is exactly the "requires a product
 * decision" branch: activity + operator-review task, same shape as the callback action, left for
 * the operator to close with the correct structured reason.
 */
async function applyCustomerActionEffects(leadId, action) {
  if (!leadId) return;
  const label = CUSTOMER_ACTION_LABELS[action];
  if (!label) return;
  await createLeadActivity(leadId, "whatsapp_customer_action", label, { action });
  await createLeadTask(leadId, {
    kind: action === "callback_request" ? "callback_reminder" : "customer_not_interested_review",
    title: action === "callback_request" ? "Richiamare il cliente (richiesta via WhatsApp)" : "Verificare interesse cliente (segnalato via WhatsApp)",
    description:
      action === "callback_request"
        ? "Il cliente ha chiesto di essere ricontattato via WhatsApp. Nessuna data/ora e stata specificata: da concordare al richiamo."
        : "Il cliente ha indicato via WhatsApp di non essere interessato. Verificare ed eventualmente chiudere la pratica con il motivo corretto.",
    priority: 60
  });
}

function buildTemplateText(templateKey, fallbackText = "") {
  const match =
    TEMPLATE_CONFIG.find((item) => item.key === String(templateKey || "").trim()) ||
    TEMPLATE_CONFIG.find((item) => item.name === String(templateKey || "").trim());
  return match?.body || fallbackText || "Messaggio template WhatsApp.";
}

function resolveTemplate(templateKey, templateName) {
  const normalizedKey = String(templateKey || "").trim();
  const normalizedName = String(templateName || "").trim();
  return (
    TEMPLATE_CONFIG.find((item) => item.key === normalizedKey) ||
    TEMPLATE_CONFIG.find((item) => item.name === normalizedName) ||
    TEMPLATE_CONFIG.find((item) => item.name === normalizedKey) ||
    TEMPLATE_CONFIG.find((item) => item.key === normalizedName) ||
    null
  );
}

async function upsertLeadFromChat({ phone, customerName, text }) {
  if (!phone) return null;
  try {
    const res = await fetch(`${LEAD_URL}/internal/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "whatsapp_chat",
        fullName: customerName || `WhatsApp ${phone}`,
        phone,
        notes: `Messaggio WhatsApp: ${text}`
      })
    });
    if (!res.ok) return null;
    const payload = await res.json();
    return payload && payload.lead ? payload.lead : null;
  } catch (error) {
    return null;
  }
}

/**
 * Deterministic Customer/Lead resolution for a phone number (see
 * lead-service/customer-routes.ts:resolveLeadAssociationForPhone for the exact rule). A Customer
 * can have N leads now, so this never guesses among several plausible opportunities -- it either
 * finds exactly one sensible candidate or leaves leadId null (ambiguous, ownership stays at the
 * Customer level until an operator claims a specific lead from the practice).
 *
 * `skipCreate: true` is used when the conversation already has a leadId and we only need to
 * backfill customerId -- in that case we must NOT fall back to creating a brand-new lead just
 * because the customer lookup came back empty (e.g. a legacy lead created before customerId
 * existed); the existing leadId is preserved by the caller regardless.
 */
async function resolveConversationIdentity(phone, customerName, text, options = {}) {
  let resolution = { customerId: null, leadId: null, ambiguous: false, candidateLeadIds: [] };
  try {
    const res = await fetch(`${LEAD_URL}/internal/lead-association?phone=${encodeURIComponent(phone)}`);
    if (res.ok) resolution = await res.json();
  } catch (error) {
    // Lead-service unreachable: fail safe to "unresolved" rather than guessing.
  }
  if (resolution.customerId || options.skipCreate) return resolution;
  // No Customer at all for this phone yet -- this is a brand new contact, so creating a lead
  // (which also creates the Customer) is the existing, correct ingest behavior, not a guess.
  const lead = await upsertLeadFromChat({ phone, customerName, text });
  if (!lead) return resolution;
  return { customerId: lead.customerId || null, leadId: lead.id || null, ambiguous: false, candidateLeadIds: lead.id ? [lead.id] : [] };
}

async function ensureConversationLead(conversation, text = "") {
  if (!conversation) return conversation;
  if (conversation.leadId) {
    if (conversation.customerId) return conversation;
    const identity = await resolveConversationIdentity(conversation.phone, conversation.customerName, text, { skipCreate: true });
    if (!identity.customerId) return conversation;
    return createOrUpdateConversation({
      phone: conversation.phone,
      customerName: conversation.customerName || conversation.phone,
      leadId: conversation.leadId,
      customerId: identity.customerId,
      assignedTo: conversation.assignedTo || "",
      incrementUnread: false,
      lastMessagePreview: conversation.lastMessagePreview || "",
      source: conversation.source || "whatsapp"
    });
  }
  const identity = await resolveConversationIdentity(
    conversation.phone,
    conversation.customerName || conversation.phone,
    text || conversation.lastMessagePreview || "Conversazione WhatsApp collegata al CRM."
  );
  if (!identity.leadId && !identity.customerId) return conversation;
  return createOrUpdateConversation({
    phone: conversation.phone,
    customerName: conversation.customerName || conversation.phone,
    leadId: identity.leadId,
    customerId: identity.customerId,
    assignedTo: conversation.assignedTo || "",
    incrementUnread: false,
    lastMessagePreview: conversation.lastMessagePreview || "",
    source: conversation.source || "whatsapp"
  });
}

async function handleInboundWebhook(payload) {
  const entryList = Array.isArray(payload.entry) ? payload.entry : [];
  let messageCount = 0;
  let statusCount = 0;

  for (const entry of entryList) {
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change.value || {};
      const contacts = Array.isArray(value.contacts) ? value.contacts : [];
      const messages = Array.isArray(value.messages) ? value.messages : [];
      const statuses = Array.isArray(value.statuses) ? value.statuses : [];

      for (const status of statuses) {
        if (status && status.id && status.status) {
          statusCount += await updateMessageStatusByProviderId(status.id, status.status);
        }
      }

      for (const message of messages) {
        const providerMessageId = message.id || "";
        // Meta is documented to retry webhook delivery; without this check a retried delivery
        // would create a duplicate message (and double-count unreadCount / bump the reply window
        // a second time for nothing).
        if (providerMessageId) {
          const existingMessage = await findMessageByProviderId(providerMessageId);
          if (existingMessage) continue;
        }

        const from = message.from || "";
        const contact = contacts.find((c) => c.wa_id === from) || contacts[0] || {};
        const customerName = (contact.profile && contact.profile.name) || "";
        const text = extractInboundText(message);
        const attachment = extractInboundAttachment(message);
        const createdAt = message.timestamp ? new Date(Number(message.timestamp) * 1000).toISOString() : new Date().toISOString();
        const identity = await resolveConversationIdentity(from, customerName, text);

        const conversation = await createOrUpdateConversation({
          phone: from,
          customerName,
          leadId: identity.leadId,
          customerId: identity.customerId,
          incrementUnread: false,
          lastMessagePreview: text,
          lastInboundAt: createdAt,
          replyWindowExpiresAt: getReplyWindowExpiresAt(createdAt),
          source: "whatsapp"
        });

        await appendMessage({
          conversationId: conversation.id,
          direction: "inbound",
          text,
          status: "received",
          messageType: message.type || "text",
          from,
          to: value.metadata ? value.metadata.display_phone_number || "" : "",
          providerMessageId,
          attachment,
          raw: message,
          createdAt
        });
        messageCount += 1;

        const customerAction = extractCustomerActionFromMessage(message);
        if (customerAction) {
          await applyCustomerActionEffects(conversation.leadId, customerAction);
        }
      }
    }
  }

  return { messageCount, statusCount };
}

async function sendViaMeta(to, text) {
  if (!WA_ACCESS_TOKEN || !WA_PHONE_NUMBER_ID) {
    return { simulated: true, providerMessageId: `sim_${Date.now()}` };
  }

  const url = `https://graph.facebook.com/${WA_GRAPH_VERSION}/${encodeURIComponent(WA_PHONE_NUMBER_ID)}/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${WA_ACCESS_TOKEN}`
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text }
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Meta send failed (${response.status}): ${errText}`);
  }
  const payload = await response.json();
  const providerMessageId =
    payload && Array.isArray(payload.messages) && payload.messages[0] ? payload.messages[0].id : `wa_${Date.now()}`;
  return { simulated: false, providerMessageId };
}

async function sendTemplateViaMeta(to, templateName) {
  if (!WA_ACCESS_TOKEN || !WA_PHONE_NUMBER_ID) {
    return { simulated: true, providerMessageId: `sim_tpl_${Date.now()}` };
  }

  const url = `https://graph.facebook.com/${WA_GRAPH_VERSION}/${encodeURIComponent(WA_PHONE_NUMBER_ID)}/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${WA_ACCESS_TOKEN}`
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: templateName,
        language: { code: "it" }
      }
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Meta template send failed (${response.status}): ${errText}`);
  }
  const payload = await response.json();
  const providerMessageId =
    payload && Array.isArray(payload.messages) && payload.messages[0] ? payload.messages[0].id : `wa_tpl_${Date.now()}`;
  return { simulated: false, providerMessageId };
}

// Sends a document/image already stored in this CRM's own Document Storage (Backblaze B2) by
// reference -- Meta's Cloud API accepts a public "link" for outbound media, so the same presigned
// download URL the Pratica page already uses to open a document is reused here rather than
// re-uploading the file to Meta's separate Media endpoint (which would need its own integration
// this session doesn't build). Never invoked with real credentials in this session.
async function sendAttachmentViaMeta(to, attachment) {
  if (!WA_ACCESS_TOKEN || !WA_PHONE_NUMBER_ID) {
    return { simulated: true, providerMessageId: `sim_att_${Date.now()}` };
  }
  const mediaType = attachment.mimeType && String(attachment.mimeType).startsWith("image/") ? "image" : "document";
  const url = `https://graph.facebook.com/${WA_GRAPH_VERSION}/${encodeURIComponent(WA_PHONE_NUMBER_ID)}/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${WA_ACCESS_TOKEN}`
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: mediaType,
      [mediaType]: {
        link: attachment.url,
        filename: mediaType === "document" ? attachment.filename || "documento" : undefined,
        caption: attachment.caption || undefined
      }
    })
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Meta attachment send failed (${response.status}): ${errText}`);
  }
  const payload = await response.json();
  const providerMessageId =
    payload && Array.isArray(payload.messages) && payload.messages[0] ? payload.messages[0].id : `wa_att_${Date.now()}`;
  return { simulated: false, providerMessageId };
}

async function createOutboundConversation({ conversation, to, customerName, agentName, text }) {
  if (!conversation) {
    const identity = await resolveConversationIdentity(to, customerName || to, text);
    return createOrUpdateConversation({
      phone: to,
      customerName: customerName || to,
      leadId: identity.leadId,
      customerId: identity.customerId,
      assignedTo: agentName || "",
      incrementUnread: false,
      lastMessagePreview: text,
      source: "whatsapp"
    });
  }
  const hydratedConversation = await ensureConversationLead(conversation, text);
  return createOrUpdateConversation({
    phone: hydratedConversation.phone,
    customerName: hydratedConversation.customerName || "",
    leadId: hydratedConversation.leadId || null,
    customerId: hydratedConversation.customerId || null,
    assignedTo: agentName || hydratedConversation.assignedTo || "",
    incrementUnread: false,
    lastMessagePreview: text,
    source: hydratedConversation.source || "whatsapp"
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const method = req.method || "GET";
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = decodeURIComponent(url.pathname);

    if (method === "GET" && pathname === "/health") {
      sendJson(res, 200, { ok: true, service: "whatsapp-service" });
      return;
    }

    if (method === "GET" && pathname === "/conversations") {
      const customerId = String(url.searchParams.get("customerId") || "").trim();
      const leadId = String(url.searchParams.get("leadId") || "").trim();
      let conversations = await listConversations();
      if (customerId) conversations = conversations.filter((c) => String(c.customerId || "") === customerId);
      else if (leadId) conversations = conversations.filter((c) => String(c.leadId || "") === leadId);
      sendJson(res, 200, conversations);
      return;
    }

    // Used by the Pratica "open WhatsApp" action: returns the existing conversation for this
    // Customer if there is one (never re-resolves/guesses -- the caller already knows the exact
    // leadId/customerId from the practice it's looking at), otherwise creates an empty one (no
    // message sent yet, nothing simulated) so the operator lands in the chat ready to compose.
    if (method === "POST" && pathname === "/conversations/ensure") {
      const body = await parseBody(req);
      const phone = String(body.phone || "").trim();
      if (!phone) {
        sendJson(res, 400, { error: "phone obbligatorio." });
        return;
      }
      const existing = await findConversationByPhone(phone);
      if (existing) {
        sendJson(res, 200, existing);
        return;
      }
      const leadId = body.leadId ? String(body.leadId).trim() : null;
      const customerId = body.customerId ? String(body.customerId).trim() : null;
      const customerName = String(body.customerName || phone).trim();
      const conversation = await createOrUpdateConversation({
        phone,
        customerName,
        leadId,
        customerId,
        assignedTo: "",
        incrementUnread: false,
        lastMessagePreview: "",
        source: "whatsapp"
      });
      sendJson(res, 200, conversation);
      return;
    }

    // Structured customer-action processor: lets "RICONTATTAMI"/"NON INTERESSATO" be exercised
    // via a simulated/internal payload without needing a real Meta interactive-button template
    // (none is registered this session). The same effects also fire automatically from a real
    // webhook button reply, once one exists -- see extractCustomerActionFromMessage.
    if (method === "POST" && pathname === "/customer-actions") {
      const body = await parseBody(req);
      const phone = String(body.phone || "").trim();
      const action = String(body.action || "").trim();
      const customerName = String(body.customerName || "").trim();
      const note = String(body.note || "").trim();
      if (!phone) {
        sendJson(res, 400, { error: "phone obbligatorio." });
        return;
      }
      const label = CUSTOMER_ACTION_LABELS[action];
      if (!label) {
        sendJson(res, 400, { error: `action non riconosciuta. Valori validi: ${Object.keys(CUSTOMER_ACTION_LABELS).join(", ")}.` });
        return;
      }

      const identity = await resolveConversationIdentity(phone, customerName || phone, label);
      const createdAt = new Date().toISOString();
      const conversation = await createOrUpdateConversation({
        phone,
        customerName: customerName || phone,
        leadId: identity.leadId,
        customerId: identity.customerId,
        incrementUnread: true,
        lastMessagePreview: label,
        lastInboundAt: createdAt,
        replyWindowExpiresAt: getReplyWindowExpiresAt(createdAt),
        source: "whatsapp"
      });

      const message = await appendMessage({
        conversationId: conversation.id,
        direction: "inbound",
        text: note ? `${label} (${note})` : label,
        status: "received",
        messageType: "customer_action",
        from: phone,
        createdAt
      });

      await applyCustomerActionEffects(conversation.leadId, action);

      sendJson(res, 200, {
        ok: true,
        conversationId: conversation.id,
        leadId: conversation.leadId || null,
        customerId: conversation.customerId || null,
        ambiguous: identity.ambiguous,
        message
      });
      return;
    }

    if (method === "GET" && pathname === "/templates") {
      sendJson(res, 200, TEMPLATE_CONFIG);
      return;
    }

    if (method === "POST" && pathname === "/templates/test-send") {
      const body = await parseBody(req);
      const templateKey = String(body.templateKey || "").trim();
      const templateName = String(body.templateName || "").trim();
      const selectedTemplate = resolveTemplate(templateKey, templateName);
      if (!selectedTemplate) {
        sendJson(res, 400, { error: "Template WhatsApp non configurato." });
        return;
      }

      let conversation = null;
      if (body.conversationId) {
        conversation = await getConversationById(String(body.conversationId));
      }

      const to = String(body.to || (conversation ? conversation.phone : "")).trim();
      if (!to) {
        sendJson(res, 400, { error: "Numero destinatario mancante (to)." });
        return;
      }

      conversation = await createOutboundConversation({
        conversation,
        to,
        customerName: body.customerName || to,
        agentName: body.agentName || "operatore",
        text: selectedTemplate.body
      });

      const sendResult = await sendTemplateViaMeta(to, selectedTemplate.name);
      const message = await appendMessage({
        conversationId: conversation.id,
        direction: "outbound",
        text: selectedTemplate.body,
        status: sendResult.simulated ? "simulated" : "sent",
        messageType: "template",
        templateKey: selectedTemplate.key,
        templateName: selectedTemplate.name,
        from: WA_PHONE_NUMBER_ID || "crm",
        to,
        providerMessageId: sendResult.providerMessageId,
        agentName: body.agentName || "operatore"
      });

      sendJson(res, 200, {
        ok: true,
        simulated: sendResult.simulated,
        conversationId: conversation.id,
        template: selectedTemplate,
        message
      });
      return;
    }

    const convMessagesParams = routeMatch(pathname, "/conversations/:conversationId/messages");
    if (convMessagesParams && method === "GET") {
      let conversation = await getConversationById(convMessagesParams.conversationId);
      if (!conversation) {
        sendJson(res, 404, { error: "Conversazione non trovata." });
        return;
      }
      conversation = await ensureConversationLead(conversation);
      await markConversationRead(conversation.id);
      const messages = await listMessages(conversation.id);
      sendJson(res, 200, { conversation, messages });
      return;
    }

    const convPatchParams = routeMatch(pathname, "/conversations/:conversationId");
    if (convPatchParams && method === "PATCH") {
      const body = await parseBody(req);
      const nextStatus = body.status ? String(body.status).trim() : undefined;
      const nextAssignedTo = body.assignedTo !== undefined ? String(body.assignedTo || "").trim() : undefined;
      const updated = await updateConversation(convPatchParams.conversationId, {
        ...(nextStatus ? { status: nextStatus } : {}),
        ...(nextAssignedTo !== undefined ? { assignedTo: nextAssignedTo } : {})
      });
      if (!updated) {
        sendJson(res, 404, { error: "Conversazione non trovata." });
        return;
      }
      sendJson(res, 200, updated);
      return;
    }

    if (method === "POST" && pathname === "/messages/send") {
      const body = await parseBody(req);
      const mode = String(body.mode || "text").trim().toLowerCase();
      const templateKey = String(body.templateKey || "").trim();
      const templateName = String(body.templateName || "").trim();
      const selectedTemplate = resolveTemplate(templateKey, templateName);
      const text = String(body.text || "").trim();
      const outboundAttachment = body.attachment && body.attachment.url ? {
        direction: "outbound",
        mediaType: String(body.attachment.mimeType || "").startsWith("image/") ? "image" : "document",
        url: String(body.attachment.url),
        filename: String(body.attachment.filename || ""),
        mimeType: String(body.attachment.mimeType || ""),
        caption: String(body.attachment.caption || ""),
        documentStorageKey: String(body.attachment.storageKey || "")
      } : null;
      if (mode === "text" && !text) {
        sendJson(res, 400, { error: "text obbligatorio." });
        return;
      }
      if (mode === "template" && !selectedTemplate) {
        sendJson(res, 400, { error: "Template WhatsApp non configurato." });
        return;
      }
      if (mode === "attachment" && !outboundAttachment) {
        sendJson(res, 400, { error: "attachment (con url) obbligatorio per l'invio di un allegato." });
        return;
      }

      let conversation = null;
      if (body.conversationId) {
        conversation = await getConversationById(String(body.conversationId));
      }

      const to = String(body.to || (conversation ? conversation.phone : "")).trim();
      if (!to) {
        sendJson(res, 400, { error: "Numero destinatario mancante (to)." });
        return;
      }
      // Meta restricts every freeform message type -- not just text -- to the 24h customer
      // service window; only a pre-approved template can be sent outside it. An attachment is no
      // exception, so it gets the identical gate as free text rather than a bypass.
      if (conversation && (mode === "text" || mode === "attachment") && !conversation.hasOpenSession) {
        sendJson(res, 400, { error: "La finestra di risposta WhatsApp e chiusa. Usa un template approvato." });
        return;
      }

      conversation = await createOutboundConversation({
        conversation,
        to,
        customerName: body.customerName || to,
        agentName: body.agentName || "",
        text: text || (outboundAttachment ? `[${outboundAttachment.mediaType}] ${outboundAttachment.filename}` : buildTemplateText(templateKey || templateName, selectedTemplate?.body || ""))
      });

      const outboundText =
        mode === "template"
          ? selectedTemplate.body || buildTemplateText(templateKey || templateName, "")
          : mode === "attachment"
            ? outboundAttachment.caption || outboundAttachment.filename
            : text;
      const sendResult =
        mode === "template"
          ? await sendTemplateViaMeta(to, selectedTemplate.name)
          : mode === "attachment"
            ? await sendAttachmentViaMeta(to, outboundAttachment)
            : await sendViaMeta(to, text);
      const message = await appendMessage({
        conversationId: conversation.id,
        direction: "outbound",
        text: outboundText,
        status: sendResult.simulated ? "simulated" : "sent",
        messageType: mode,
        templateKey: selectedTemplate?.key || templateKey,
        templateName: selectedTemplate?.name || templateName || templateKey,
        from: WA_PHONE_NUMBER_ID || "crm",
        to,
        providerMessageId: sendResult.providerMessageId,
        attachment: outboundAttachment,
        agentName: body.agentName || "operatore"
      });

      sendJson(res, 200, {
        ok: true,
        simulated: sendResult.simulated,
        conversationId: conversation.id,
        message
      });
      return;
    }

    if (method === "GET" && pathname === "/webhook") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (mode === "subscribe" && token === VERIFY_TOKEN && challenge) {
        sendText(res, 200, challenge);
        return;
      }
      sendText(res, 403, "Forbidden");
      return;
    }

    if (method === "POST" && pathname === "/webhook") {
      const rawBody = await readRawBody(req);
      if (!isValidWebhookSignature(rawBody, req.headers["x-hub-signature-256"])) {
        sendJson(res, 401, { error: "Firma webhook non valida." });
        return;
      }
      let payload = {};
      if (rawBody) {
        try {
          payload = JSON.parse(rawBody);
        } catch (error) {
          sendJson(res, 400, { error: "Invalid JSON body" });
          return;
        }
      }
      const result = await handleInboundWebhook(payload);
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    sendJson(res, 404, { error: "Endpoint non trovato." });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Errore interno." });
  }
});

if (process.env.NODE_ENV !== "test") {
  server.listen(PORT, HOST, () => {
    // eslint-disable-next-line no-console
    console.log(`whatsapp-service su http://localhost:${PORT}`);
  });
}

module.exports.server = server;
module.exports.resolveConversationIdentity = resolveConversationIdentity;

export {};
