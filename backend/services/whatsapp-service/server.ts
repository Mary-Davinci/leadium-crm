// @ts-nocheck
require("../../loadEnv");

const http = require("http");
const fs = require("fs");
const path = require("path");
const {
  listConversations,
  getConversationById,
  listMessages,
  createOrUpdateConversation,
  appendMessage,
  markConversationRead,
  updateConversation,
  updateMessageStatusByProviderId
} = require("../common/chatStore");

const HOST = "0.0.0.0";
const PORT = Number(process.env.WHATSAPP_SERVICE_PORT || 4306);
const LEAD_URL = process.env.LEAD_SERVICE_URL || "http://localhost:4301";
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || "dev_whatsapp_token";
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

function getReplyWindowExpiresAt(createdAt) {
  return new Date(new Date(createdAt || Date.now()).getTime() + 24 * 60 * 60 * 1000).toISOString();
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
    return payload && payload.lead ? payload.lead.id : null;
  } catch (error) {
    return null;
  }
}

async function ensureConversationLead(conversation, text = "") {
  if (!conversation || conversation.leadId) return conversation;
  const leadId = await upsertLeadFromChat({
    phone: conversation.phone,
    customerName: conversation.customerName || conversation.phone,
    text: text || conversation.lastMessagePreview || "Conversazione WhatsApp collegata al CRM."
  });
  if (!leadId) return conversation;
  return createOrUpdateConversation({
    phone: conversation.phone,
    customerName: conversation.customerName || conversation.phone,
    leadId,
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
        const from = message.from || "";
        const contact = contacts.find((c) => c.wa_id === from) || contacts[0] || {};
        const customerName = (contact.profile && contact.profile.name) || "";
        const text = extractInboundText(message);
        const createdAt = message.timestamp ? new Date(Number(message.timestamp) * 1000).toISOString() : new Date().toISOString();
        const leadId = await upsertLeadFromChat({ phone: from, customerName, text });

        const conversation = await createOrUpdateConversation({
          phone: from,
          customerName,
          leadId,
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
          providerMessageId: message.id || "",
          raw: message,
          createdAt
        });
        messageCount += 1;
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

async function createOutboundConversation({ conversation, to, customerName, agentName, text }) {
  if (!conversation) {
    const leadId = await upsertLeadFromChat({
      phone: to,
      customerName: customerName || to,
      text
    });
    return createOrUpdateConversation({
      phone: to,
      customerName: customerName || to,
      leadId,
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
      const conversations = await listConversations();
      sendJson(res, 200, conversations);
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
      if (mode === "text" && !text) {
        sendJson(res, 400, { error: "text obbligatorio." });
        return;
      }
      if (mode === "template" && !selectedTemplate) {
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
      if (conversation && mode === "text" && !conversation.hasOpenSession) {
        sendJson(res, 400, { error: "La finestra di risposta WhatsApp e chiusa. Usa un template approvato." });
        return;
      }

      conversation = await createOutboundConversation({
        conversation,
        to,
        customerName: body.customerName || to,
        agentName: body.agentName || "",
        text: text || buildTemplateText(templateKey || templateName, selectedTemplate?.body || "")
      });

      const outboundText = mode === "template" ? selectedTemplate.body || buildTemplateText(templateKey || templateName, "") : text;
      const sendResult =
        mode === "template" ? await sendTemplateViaMeta(to, selectedTemplate.name) : await sendViaMeta(to, text);
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
      const payload = await parseBody(req);
      const result = await handleInboundWebhook(payload);
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    sendJson(res, 404, { error: "Endpoint non trovato." });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Errore interno." });
  }
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`whatsapp-service su http://localhost:${PORT}`);
});

export {};
