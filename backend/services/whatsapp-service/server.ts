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
  updateMessageStatusByProviderId,
  getMessageById,
  findMessageByIdempotencyKey,
  listTemplateSendsForLead,
  reserveTemplateOnce,
  releaseTemplateOnce,
  recordWhatsappDiagnostic,
  getWhatsappDiagnostics
} = require("../common/chatStore");
const {
  checkTemplateSend,
  buildTemplateComponents,
  renderTemplateBody,
  deriveAutomationState,
  suggestTemplates,
  nextAutomaticTemplate,
  findTemplate
} = require("../common/whatsappAutomation");
const { classifyMetaError, createMetaSendError, getFriendlyMetaMessage } = require("./meta-errors");
const {
  resolveOutboundMediaType,
  normalizeAttachmentKind,
  sanitizeAttachmentFilename,
  isInlineSafeMime,
  buildContentDisposition,
  INBOUND_MEDIA_MAX_BYTES
} = require("./media-rules");

// Internal service: reached only through the gateway in the same process. INTERNAL_SERVICE_HOST=127.0.0.1
// keeps its port off the network (the gateway keeps listening on 0.0.0.0).
const HOST = process.env.INTERNAL_SERVICE_HOST || "0.0.0.0";
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
// Global kill switch for automatic WhatsApp sends. Off unless explicitly "true": with it off, the
// Booking sequence only ever produces suggestions for operators, never a send.
const AUTOMATION_ENABLED = String(process.env.WHATSAPP_AUTOMATION_ENABLED || "").trim().toLowerCase() === "true";
const AUTOMATION_MAX_SENDS_PER_TICK = Math.max(1, Number(process.env.WHATSAPP_AUTOMATION_MAX_PER_TICK || 20));
// The service runs from services/ under tsx and from dist/services/ once built, so the bundled
// config sits two or three levels up depending on how it was started.
const WA_TEMPLATE_CONFIG_PATH = [
  process.env.WHATSAPP_TEMPLATE_CONFIG_PATH,
  path.join(__dirname, "..", "..", "config", "whatsapp-templates.json"),
  path.join(__dirname, "..", "..", "..", "config", "whatsapp-templates.json")
].find((candidate) => candidate && fs.existsSync(candidate));

const DEFAULT_TEMPLATE_CONFIG = [
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

// Template entry as the CRM uses it. `category` keeps the legacy UI grouping (utility/followup);
// the rest drives the Cloud API send and the Booking automation (see common/whatsappAutomation).
function normalizeTemplateItem(item) {
  const automationMode = String(item?.automationMode || "manual_only").trim() === "automatic_allowed" ? "automatic_allowed" : "manual_only";
  const parameters = Array.isArray(item?.parameters)
    ? item.parameters
        .map((param) => ({
          name: String(param?.name || "").trim(),
          label: String(param?.label || param?.name || "").trim(),
          component: param?.component === "button_url" ? "button_url" : "body",
          index: Number(param?.index || 1),
          buttonIndex: param?.buttonIndex !== undefined ? Number(param.buttonIndex) : undefined,
          kind: param?.kind === "url" ? "url" : "text",
          required: param?.required !== false,
          source: ["productInterest", "quoteUrl", "fullName"].includes(param?.source) ? param.source : undefined
        }))
        .filter((param) => param.name)
    : [];
  return {
    key: String(item?.key || item?.name || "").trim(),
    name: String(item?.name || item?.key || "").trim(),
    label: String(item?.label || item?.name || item?.key || "").trim(),
    body: String(item?.body || "").trim(),
    category: String(item?.category || "utility").trim().toLowerCase() === "followup" ? "followup" : "utility",
    suggestionTag: String(item?.suggestionTag || "generic").trim().toLowerCase(),
    language: String(item?.language || "it").trim() || "it",
    metaCategory: String(item?.metaCategory || "").trim().toUpperCase(),
    metaStatus: String(item?.metaStatus || "approved").trim().toLowerCase(),
    bodyDraft: Boolean(item?.bodyDraft),
    parameters,
    automationMode,
    onceGroup: item?.onceGroup ? String(item.onceGroup) : undefined,
    sequence:
      item?.sequence && item.sequence.after
        ? { after: String(item.sequence.after), afterHours: Math.max(1, Number(item.sequence.afterHours || 24)) }
        : undefined,
    endsSequence: Boolean(item?.endsSequence),
    requiresQuote: Boolean(item?.requiresQuote),
    eligibleStatuses: Array.isArray(item?.eligibleStatuses) ? item.eligibleStatuses.map(String) : undefined
  };
}

function loadTemplateConfig() {
  try {
    if (WA_TEMPLATE_CONFIG_PATH && fs.existsSync(WA_TEMPLATE_CONFIG_PATH)) {
      const fileRaw = fs.readFileSync(WA_TEMPLATE_CONFIG_PATH, "utf8");
      const fileParsed = JSON.parse(fileRaw);
      if (Array.isArray(fileParsed)) {
        const normalizedFromFile = fileParsed
          .map(normalizeTemplateItem)
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
      .map(normalizeTemplateItem)
      .filter((item) => item.key && item.name && item.label);
    return normalized.length ? normalized : DEFAULT_TEMPLATE_CONFIG;
  } catch {
    return DEFAULT_TEMPLATE_CONFIG;
  }
}

const TEMPLATE_CONFIG = loadTemplateConfig().map(normalizeTemplateItem);

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

// A send can return 200 and still fail at delivery: Meta then posts a "failed" status with the
// reason in errors[]. Logs the raw reason and returns the operator-facing text ("" otherwise).
function describeStatusFailure(status) {
  if (String(status?.status || "").toLowerCase() !== "failed") return "";
  const error = Array.isArray(status.errors) && status.errors[0] ? status.errors[0] : {};
  const metaCode = Number.isFinite(Number(error.code)) ? Number(error.code) : null;
  const detail = String(error.error_data?.details || error.message || error.title || "").slice(0, 300);
  const code = classifyMetaError(0, metaCode);
  // eslint-disable-next-line no-console
  console.error(`[whatsapp-service] Consegna fallita: message=${status.id} metaCode=${metaCode ?? "-"} code=${code} detail=${detail}`);
  void recordWhatsappDiagnostic({ lastMetaError: { at: new Date().toISOString(), stage: "delivery", code, metaCode } });
  return getFriendlyMetaMessage(code);
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

// --- Booking template sends (manual and automatic share one path) -------------------------------

async function fetchLead(leadId) {
  if (!leadId) return null;
  try {
    const response = await fetch(`${LEAD_URL}/leads/${encodeURIComponent(leadId)}`);
    if (!response.ok) return null;
    const payload = await response.json();
    return payload && payload.lead ? payload.lead : null;
  } catch {
    return null;
  }
}

async function buildAutomationContext(lead, conversation) {
  const conversations = lead ? (await listConversations()).filter((item) => String(item.leadId || "") === String(lead.id)) : [];
  const ids = Array.from(new Set([...conversations.map((item) => item.id), ...(conversation ? [conversation.id] : [])]));
  const lastInboundAt = [...conversations, ...(conversation ? [conversation] : [])]
    .map((item) => item.lastInboundAt)
    .filter(Boolean)
    .sort()
    .pop() || null;
  return {
    lead: lead || {},
    conversation: { lastInboundAt },
    sent: lead || ids.length ? await listTemplateSendsForLead(lead ? lead.id : "", ids) : [],
    templates: TEMPLATE_CONFIG,
    now: new Date(),
    automationEnabled: AUTOMATION_ENABLED
  };
}

async function createLeadTimelineActivity(leadId, type, text, actor, meta = {}) {
  if (!leadId) return;
  try {
    await fetch(`${LEAD_URL}/leads/${leadId}/activities`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, text, actor, meta })
    });
  } catch {
    // Best-effort: the message record stays the source of truth for the send.
  }
}

/**
 * Every template send goes through here: rules (checkTemplateSend), once-per-lead lock, Meta
 * variables, retry idempotency, audit fields and the lead timeline entry.
 */
async function performTemplateSend({ template, to, conversation, lead, overrides = {}, trigger, agentName, idempotencyKey, customerName }) {
  if (idempotencyKey) {
    const existing = await findMessageByIdempotencyKey(idempotencyKey);
    if (existing) return { status: 200, body: { ok: true, duplicate: true, conversationId: existing.conversationId, message: existing } };
  }
  const ctx = await buildAutomationContext(lead, conversation);
  const check = checkTemplateSend(ctx, template.key, trigger, overrides);
  if (!check.allowed) {
    const status = check.code === "already_sent" || check.code === "opt_out" ? 409 : 400;
    return { status, body: { error: check.reason, code: check.code } };
  }
  const lockId = lead && template.onceGroup ? `${lead.id}:${template.onceGroup}` : null;
  if (lockId && !(await reserveTemplateOnce(lockId, { templateKey: template.key, trigger }))) {
    return { status: 409, body: { error: `"${template.label}" e gia stato inviato a questo cliente: si invia una sola volta.`, code: "already_sent" } };
  }
  const values = check.values || {};
  const text = renderTemplateBody(template, values);
  let sendResult;
  try {
    conversation = await createOutboundConversation({ conversation, to, customerName: customerName || to, agentName: agentName || "", text });
    sendResult = await sendTemplateViaMeta(to, template, buildTemplateComponents(template, values));
  } catch (error) {
    if (lockId) await releaseTemplateOnce(lockId);
    throw error;
  }
  let message;
  try {
    message = await appendMessage({
      conversationId: conversation.id,
      direction: "outbound",
      text,
      status: sendResult.simulated ? "simulated" : "sent",
      messageType: "template",
      templateKey: template.key,
      templateName: template.name,
      from: WA_PHONE_NUMBER_ID || "crm",
      to,
      providerMessageId: sendResult.providerMessageId,
      agentName: agentName || (trigger === "automation" ? "automazione" : "operatore"),
      leadId: (lead && lead.id) || conversation.leadId || "",
      trigger,
      templateParams: values,
      metaCategory: template.metaCategory || "",
      idempotencyKey
    });
  } catch (error) {
    // Two concurrent retries with the same key: the unique index keeps one log row.
    const existing = idempotencyKey ? await findMessageByIdempotencyKey(idempotencyKey) : null;
    if (!existing) throw error;
    message = existing;
  }
  if (!sendResult.simulated) await recordWhatsappDiagnostic({ lastOutboundOkAt: message.createdAt });
  const leadId = (lead && lead.id) || conversation.leadId;
  await createLeadTimelineActivity(
    leadId,
    "whatsapp_template_sent",
    `Template WhatsApp inviato: ${template.label}${trigger === "automation" ? " (automazione)" : ""}.`,
    agentName || (trigger === "automation" ? "automazione" : "operatore"),
    { templateKey: template.key, trigger, messageId: message.id, providerMessageId: message.providerMessageId, simulated: Boolean(sendResult.simulated) }
  );
  return { status: 200, body: { ok: true, simulated: sendResult.simulated, conversationId: conversation.id, message } };
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

// Meta attaches billing info to status webhooks (pricing: billable/category/pricing_model;
// conversation: id/origin). Stored only when present: the CRM never estimates a cost itself.
function extractStatusBilling(status) {
  const extra = {};
  if (status && status.pricing && typeof status.pricing === "object") {
    extra.pricing = {
      billable: status.pricing.billable,
      category: status.pricing.category || "",
      pricingModel: status.pricing.pricing_model || "",
      type: status.pricing.type || ""
    };
  }
  if (status && status.conversation && typeof status.conversation === "object") {
    extra.metaConversation = {
      id: status.conversation.id || "",
      originType: (status.conversation.origin && status.conversation.origin.type) || "",
      expiresAt: status.conversation.expiration_timestamp
        ? new Date(Number(status.conversation.expiration_timestamp) * 1000).toISOString()
        : ""
    };
  }
  return extra;
}

// A once-per-lead template that Meta later reports as failed was never delivered: free its lock so
// the operator (or the sequence) can send it again.
async function releaseOnceLockForFailedSend(providerMessageId) {
  const message = await findMessageByProviderId(providerMessageId);
  if (!message || message.messageType !== "template" || !message.leadId) return;
  const template = findTemplate(TEMPLATE_CONFIG, message.templateKey || message.templateName);
  if (template && template.onceGroup) await releaseTemplateOnce(`${message.leadId}:${template.onceGroup}`);
}

async function handleInboundWebhook(payload) {
  const entryList = Array.isArray(payload.entry) ? payload.entry : [];
  await recordWhatsappDiagnostic({ lastWebhookAt: new Date().toISOString() });
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
          statusCount += await updateMessageStatusByProviderId(status.id, status.status, describeStatusFailure(status), extractStatusBilling(status));
          if (String(status.status).toLowerCase() === "failed") await releaseOnceLockForFailedSend(status.id);
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
        await recordWhatsappDiagnostic({ lastInboundAt: createdAt });

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
    throw createMetaSendError(response.status, errText, "Invio testo");
  }
  const payload = await response.json();
  const providerMessageId =
    payload && Array.isArray(payload.messages) && payload.messages[0] ? payload.messages[0].id : `wa_${Date.now()}`;
  return { simulated: false, providerMessageId };
}

async function sendTemplateViaMeta(to, template, components = []) {
  const templateName = template.name;
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
        language: { code: template.language || "it" },
        ...(components.length ? { components } : {})
      }
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    const error = createMetaSendError(response.status, errText, "Invio template");
    // Which template failed, for the admin diagnostics (e.g. one deleted on WhatsApp Manager).
    error.templateName = templateName;
    throw error;
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
  const mediaType = attachment.mediaType === "image" ? "image" : "document";
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
    throw createMetaSendError(response.status, errText, "Invio allegato");
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

      const result = await performTemplateSend({
        template: selectedTemplate,
        to,
        conversation,
        lead: conversation && conversation.leadId ? await fetchLead(conversation.leadId) : null,
        overrides: body.templateParams && typeof body.templateParams === "object" ? body.templateParams : {},
        trigger: "manual",
        agentName: body.agentName || "operatore",
        idempotencyKey: body.idempotencyKey ? String(body.idempotencyKey) : "",
        customerName: body.customerName || to
      });
      sendJson(res, result.status, result.status === 200 ? { ...result.body, template: selectedTemplate } : result.body);
      return;
    }

    // Inbound media (photos/documents a customer sent) only arrive as a Meta mediaId. This
    // resolves it through Meta's Media API and streams the bytes back to the CRM -- reachable only
    // through the authenticated gateway (/api/whatsapp/* other than /webhook requires a session),
    // and only for a mediaId already stored on one of our own messages, never an arbitrary id.
    const mediaParams = routeMatch(pathname, "/messages/:messageId/media");
    if (mediaParams && method === "GET") {
      const message = await getMessageById(mediaParams.messageId);
      const mediaId = message && message.attachment && message.attachment.mediaId;
      if (!mediaId) {
        sendJson(res, 404, { error: "Allegato non disponibile.", code: "media_not_found" });
        return;
      }
      if (!WA_ACCESS_TOKEN) {
        sendJson(res, 503, { error: "Download degli allegati WhatsApp non configurato.", code: "media_unavailable" });
        return;
      }
      const authHeaders = { Authorization: `Bearer ${WA_ACCESS_TOKEN}` };
      const metaResponse = await fetch(`https://graph.facebook.com/${WA_GRAPH_VERSION}/${encodeURIComponent(mediaId)}`, { headers: authHeaders });
      if (!metaResponse.ok) {
        // Meta keeps inbound media for a limited time; past that the id simply stops resolving.
        sendJson(res, 410, { error: "Allegato non piu disponibile su WhatsApp.", code: "media_expired" });
        return;
      }
      const meta = await metaResponse.json();
      if (!meta || !meta.url) {
        sendJson(res, 410, { error: "Allegato non piu disponibile su WhatsApp.", code: "media_expired" });
        return;
      }
      if (Number(meta.file_size || 0) > INBOUND_MEDIA_MAX_BYTES) {
        sendJson(res, 413, { error: "Allegato troppo grande per l'anteprima.", code: "media_too_large" });
        return;
      }
      const binaryResponse = await fetch(meta.url, { headers: authHeaders });
      if (!binaryResponse.ok) {
        sendJson(res, 502, { error: "Download dell'allegato da WhatsApp non riuscito.", code: "media_download_failed" });
        return;
      }
      const content = Buffer.from(await binaryResponse.arrayBuffer());
      if (content.length > INBOUND_MEDIA_MAX_BYTES) {
        sendJson(res, 413, { error: "Allegato troppo grande per l'anteprima.", code: "media_too_large" });
        return;
      }
      const mimeType = String(meta.mime_type || message.attachment.mimeType || "application/octet-stream").split(";")[0].trim();
      const filename = sanitizeAttachmentFilename(message.attachment.filename, `allegato-${message.id}`);
      res.writeHead(200, {
        "Content-Type": isInlineSafeMime(mimeType) ? mimeType : "application/octet-stream",
        "Content-Length": String(content.length),
        "Content-Disposition": buildContentDisposition(isInlineSafeMime(mimeType) ? "inline" : "attachment", filename),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=300"
      });
      res.end(content);
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
      // "Segna come non letta": only ever raises the counter to at least 1, never an arbitrary
      // client-chosen number, so it can't fake or hide real inbound volume.
      let unreadPatch = {};
      if (body.markUnread === true) {
        const current = await getConversationById(convPatchParams.conversationId);
        if (current) unreadPatch = { unreadCount: Math.max(1, Number(current.unreadCount || 0)) };
      }
      const updated = await updateConversation(convPatchParams.conversationId, {
        ...(nextStatus ? { status: nextStatus } : {}),
        ...(nextAssignedTo !== undefined ? { assignedTo: nextAssignedTo } : {}),
        ...unreadPatch
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
        mediaType: resolveOutboundMediaType(body.attachment.mimeType, body.attachment.size),
        kind: normalizeAttachmentKind(body.attachment.kind),
        url: String(body.attachment.url),
        filename: sanitizeAttachmentFilename(body.attachment.filename),
        mimeType: String(body.attachment.mimeType || ""),
        size: Number(body.attachment.size || 0) || 0,
        caption: String(body.attachment.caption || "").slice(0, 1024),
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

      if (mode === "template") {
        // trigger is always "manual" here: this route is the operator composer, never automation.
        // A conversation opened from "Nuova chat" has no lead yet: look the number up (read-only)
        // so once-per-lead and opt-out rules still apply to an existing customer.
        let leadId = (conversation && conversation.leadId) || (body.leadId ? String(body.leadId) : "");
        if (!leadId) {
          const identity = await resolveConversationIdentity(to, body.customerName || to, "", { skipCreate: true });
          if (identity && identity.leadId && !identity.ambiguous) leadId = String(identity.leadId);
        }
        const result = await performTemplateSend({
          template: selectedTemplate,
          to,
          conversation,
          lead: await fetchLead(leadId),
          overrides: body.templateParams && typeof body.templateParams === "object" ? body.templateParams : {},
          trigger: "manual",
          agentName: body.agentName || "operatore",
          idempotencyKey: body.idempotencyKey ? String(body.idempotencyKey) : "",
          customerName: body.customerName || to
        });
        sendJson(res, result.status, result.body);
        return;
      }

      const idempotencyKey = body.idempotencyKey ? String(body.idempotencyKey) : "";
      if (idempotencyKey) {
        const existing = await findMessageByIdempotencyKey(idempotencyKey);
        if (existing) {
          sendJson(res, 200, { ok: true, duplicate: true, conversationId: existing.conversationId, message: existing });
          return;
        }
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
        agentName: body.agentName || "operatore",
        leadId: conversation.leadId || "",
        idempotencyKey
      });
      if (!sendResult.simulated) await recordWhatsappDiagnostic({ lastOutboundOkAt: message.createdAt });

      sendJson(res, 200, {
        ok: true,
        simulated: sendResult.simulated,
        conversationId: conversation.id,
        message
      });
      return;
    }

    // Booking automation state for one lead: derived state, operator suggestions and, per template,
    // whether a manual send would be accepted (and why not).
    if (method === "GET" && pathname === "/automation/state") {
      const conversationId = String(url.searchParams.get("conversationId") || "").trim();
      const conversation = conversationId ? await getConversationById(conversationId) : null;
      const leadId = String(url.searchParams.get("leadId") || (conversation && conversation.leadId) || "").trim();
      const lead = await fetchLead(leadId);
      if (!lead) {
        sendJson(res, 200, { leadId: leadId || null, state: null, suggestions: [], templates: {} });
        return;
      }
      const ctx = await buildAutomationContext(lead, conversation);
      const templates = {};
      for (const template of TEMPLATE_CONFIG) {
        const check = checkTemplateSend(ctx, template.key, "manual");
        templates[template.key] = check.allowed ? { allowed: true } : { allowed: false, code: check.code, reason: check.reason };
      }
      sendJson(res, 200, {
        leadId: lead.id,
        state: deriveAutomationState(ctx),
        suggestions: suggestTemplates(ctx, lead.latestCallOutcome || null),
        templates
      });
      return;
    }

    // Called by the lead-service scheduler (existing interval, no new cron) and never reachable
    // from the browser (the gateway blocks /internal/*). Does nothing unless
    // WHATSAPP_AUTOMATION_ENABLED=true AND a template is configured automatic_allowed.
    if (method === "POST" && pathname === "/internal/automation/tick") {
      if (!AUTOMATION_ENABLED) {
        sendJson(res, 200, { ok: true, skipped: "automation_disabled", sent: 0 });
        return;
      }
      const leadsResponse = await fetch(`${LEAD_URL}/leads`);
      const leads = leadsResponse.ok ? await leadsResponse.json() : [];
      const conversations = await listConversations();
      let sent = 0;
      const errors = [];
      for (const lead of Array.isArray(leads) ? leads : []) {
        if (sent >= AUTOMATION_MAX_SENDS_PER_TICK) break;
        if (String(lead.closingOutcome || "open") !== "open" || !lead.phone) continue;
        const conversation = conversations.find((item) => String(item.leadId || "") === String(lead.id)) || null;
        const ctx = await buildAutomationContext(lead, conversation);
        const next = nextAutomaticTemplate(ctx);
        if (!next) continue;
        const template = findTemplate(TEMPLATE_CONFIG, next.key);
        try {
          const result = await performTemplateSend({
            template,
            to: String(lead.phone).replace(/[^\d]/g, ""),
            conversation,
            lead,
            trigger: "automation",
            agentName: "automazione",
            // One automatic send per lead+template, ever: a re-run of the tick is a no-op.
            idempotencyKey: `auto:${lead.id}:${template.key}`,
            customerName: lead.fullName || lead.phone
          });
          if (result.status === 200 && !result.body.duplicate) sent += 1;
        } catch (error) {
          errors.push({ leadId: lead.id, error: error.message || String(error) });
        }
      }
      sendJson(res, 200, { ok: true, sent, errors });
      return;
    }

    // Provider health for admins: configuration presence (never values) and last activity.
    if (method === "GET" && pathname === "/diagnostics") {
      sendJson(res, 200, {
        provider: {
          accessTokenConfigured: Boolean(WA_ACCESS_TOKEN),
          phoneNumberIdConfigured: Boolean(WA_PHONE_NUMBER_ID),
          appSecretConfigured: Boolean(APP_SECRET),
          verifyTokenCustomized: VERIFY_TOKEN !== "dev_whatsapp_token",
          graphVersion: WA_GRAPH_VERSION,
          automationEnabled: AUTOMATION_ENABLED,
          templatesConfigured: TEMPLATE_CONFIG.length
        },
        ...(await getWhatsappDiagnostics())
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
    if (error && error.isMetaSendError) {
      await recordWhatsappDiagnostic({ lastMetaError: { at: new Date().toISOString(), stage: "send", code: error.code, httpStatus: error.httpStatus, metaCode: error.metaCode, ...(error.templateName ? { templateName: error.templateName } : {}) } });
      sendJson(res, 502, { error: error.message, code: error.code });
      return;
    }
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
