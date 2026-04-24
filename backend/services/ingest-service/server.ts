// @ts-nocheck
require("../../loadEnv");

const http = require("http");

const HOST = "0.0.0.0";
const PORT = Number(process.env.INGEST_SERVICE_PORT || 4305);
const LEAD_URL = process.env.LEAD_SERVICE_URL || "http://localhost:4301";
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "dev_meta_token";
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || "dev_whatsapp_token";
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || "";
const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v25.0";

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
      if (data.length > 1_000_000) {
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

function normalizeFieldData(fieldData = []) {
  const result = {};
  for (const item of fieldData) {
    if (!item || !item.name) continue;
    const key = String(item.name).toLowerCase();
    const value = Array.isArray(item.values) && item.values.length ? String(item.values[0]) : "";
    result[key] = value;
  }
  return result;
}

async function fetchMetaLeadById(leadgenId) {
  if (!leadgenId || !META_ACCESS_TOKEN) {
    return null;
  }

  const fields =
    "id,created_time,form_id,ad_id,campaign_id,adgroup_id,platform,is_organic,field_data";
  const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(
    leadgenId
  )}?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(META_ACCESS_TOKEN)}`;

  const res = await fetch(url);
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Meta Graph error (${res.status}): ${errorText}`);
  }
  return res.json();
}

function extractMetaEvents(payload) {
  const events = [];
  if (payload && payload.leadgen_id) {
    events.push(payload);
    return events;
  }
  if (!payload || !Array.isArray(payload.entry)) {
    return events;
  }
  for (const entry of payload.entry) {
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (const change of changes) {
      if (change && change.field === "leadgen" && change.value) {
        events.push(change.value);
      }
    }
  }
  return events;
}

function buildMetaLeadPayload(event, details = null) {
  const merged = details || event || {};
  const fields = normalizeFieldData(merged.field_data || event.field_data || []);
  const leadgenId = event.leadgen_id || event.id || "";
  const firstName = fields.first_name || fields.nome || "";
  const lastName = fields.last_name || fields.cognome || "";
  const fullName =
    fields.full_name ||
    fields.fullname ||
    `${firstName} ${lastName}`.trim() ||
    fields.name ||
    fields.nome_completo ||
    `Lead Meta ${leadgenId || "sconosciuto"}`;
  const phone =
    fields.phone_number ||
    fields.telefono ||
    fields.phone ||
    fields.mobile_phone ||
    fields.cell_phone ||
    "";
  const email = fields.email || "";
  const platform = String(merged.platform || "").toLowerCase();
  const source = platform.includes("instagram") ? "instagram_lead_ads" : "facebook_lead_ads";
  const city = fields.city || fields.citta || fields.locality || "";
  const budget = fields.budget || fields.prezzo || fields.price_range || "";

  return {
    source,
    fullName,
    phone,
    email,
    budget,
    notes: `Meta leadgen_id=${leadgenId}; form_id=${merged.form_id || event.form_id || ""}; ad_id=${
      merged.ad_id || event.ad_id || ""
    }; campaign_id=${merged.campaign_id || ""}; platform=${merged.platform || "unknown"}; city=${city}`,
    raw: {
      event,
      details: merged
    }
  };
}

function extractWhatsAppMessages(payload) {
  const result = [];
  if (!payload || !Array.isArray(payload.entry)) {
    return result;
  }
  for (const entry of payload.entry) {
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change.value || {};
      const contacts = Array.isArray(value.contacts) ? value.contacts : [];
      const messages = Array.isArray(value.messages) ? value.messages : [];
      for (const message of messages) {
        const from = message.from || "";
        const matchedContact = contacts.find((contact) => contact.wa_id === from) || contacts[0] || {};
        const profileName = matchedContact.profile ? matchedContact.profile.name : "";
        const textBody = message.text ? message.text.body || "" : "";
        result.push({
          fullName: profileName || `Contatto WhatsApp ${from || "sconosciuto"}`,
          phone: from,
          notes: `Messaggio WhatsApp: ${textBody}`,
          raw: message
        });
      }
    }
  }
  return result;
}

async function upsertInLeadService(payload) {
  const res = await fetch(`${LEAD_URL}/internal/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || "Errore ingest nel lead-service.");
  }
  return res.json();
}

const server = http.createServer(async (req, res) => {
  try {
    const method = req.method || "GET";
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = decodeURIComponent(url.pathname);

    if (method === "GET" && pathname === "/health") {
      sendJson(res, 200, { ok: true, service: "ingest-service" });
      return;
    }

    if (method === "GET" && pathname === "/facebook/webhook") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (mode === "subscribe" && token === META_VERIFY_TOKEN && challenge) {
        sendText(res, 200, challenge);
        return;
      }
      sendText(res, 403, "Forbidden");
      return;
    }

    if (method === "POST" && pathname === "/facebook/webhook") {
      const payload = await parseBody(req);
      const events = extractMetaEvents(payload);
      const results = [];
      for (const event of events) {
        let details = null;
        try {
          const leadgenId = event.leadgen_id || event.id;
          details = await fetchMetaLeadById(leadgenId);
        } catch (error) {
          // fallback su dati evento base se Graph API non disponibile
        }
        const leadPayload = buildMetaLeadPayload(event, details);
        const result = await upsertInLeadService(leadPayload);
        results.push(result);
      }
      sendJson(res, 200, { ok: true, processed: results.length, results });
      return;
    }

    if (method === "GET" && pathname === "/whatsapp/webhook") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (mode === "subscribe" && token === WHATSAPP_VERIFY_TOKEN && challenge) {
        sendText(res, 200, challenge);
        return;
      }
      sendText(res, 403, "Forbidden");
      return;
    }

    if (method === "POST" && pathname === "/whatsapp/webhook") {
      const payload = await parseBody(req);
      const messages = extractWhatsAppMessages(payload);
      const results = [];
      for (const message of messages) {
        const result = await upsertInLeadService({
          source: "whatsapp",
          fullName: message.fullName,
          phone: message.phone,
          notes: message.notes,
          raw: message.raw
        });
        results.push(result);
      }
      sendJson(res, 200, { ok: true, processed: results.length, results });
      return;
    }

    sendJson(res, 404, { error: "Endpoint non trovato." });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Errore interno." });
  }
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`ingest-service su http://localhost:${PORT}`);
});

export {};
