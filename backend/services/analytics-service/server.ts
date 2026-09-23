import "../../loadEnv";
import http from "http";
import { rowsToCsv } from "../common/csv";

const HOST = "0.0.0.0";
const PORT = Number(process.env.ANALYTICS_SERVICE_PORT || 4304);
const LEAD_URL = process.env.LEAD_SERVICE_URL || "http://localhost:4301";

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function loadLeads() {
  const res = await fetch(`${LEAD_URL}/leads?view=summary`);
  if (!res.ok) throw new Error("Impossibile leggere lead dal lead-service.");
  return res.json();
}

function normalizeBucketKey(value: unknown, fallback: string) {
  const normalized = String(value || "").trim();
  return normalized || fallback;
}

function incrementCounter(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) || 0) + 1);
}

function sortBreakdown(map: Map<string, number>) {
  return Array.from(map.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.label.localeCompare(b.label, "it")));
}

export function computeKpis(leads: any[]) {
  const now = Date.now();
  const lossReasons = new Map<string, number>();
  const statuses = new Map<string, number>();
  const sources = new Map<string, number>();
  const ownerLoad = new Map<string, { owner: string; total: number; ready: number; closed: number; overdue: number; slaBreached: number }>();
  const total = leads.length;
  const toContact = leads.filter((lead) => lead.status === "Da contattare").length;
  const interested = leads.filter((lead) => lead.status === "Contatto interessato").length;
  const sold = leads.filter((lead) => lead.status === "Venduta").length;
  const noAnswer = leads.filter((lead) => lead.status === "Non risponde").length;
  const readyToClose = leads.filter((lead) => lead.status === "Pronta per chiusura").length;
  const closed = leads.filter((lead) => lead.status === "Chiusa 100%").length;
  const lost = leads.filter((lead) => lead.closingOutcome === "lost").length;
  const disqualified = leads.filter((lead) => lead.closingOutcome === "disqualified").length;
  const unassigned = leads.filter((lead) => !String(lead.assignedTo || "").trim()).length;
  const overdueCallbacks = leads.filter((lead) => lead.nextActionAt && new Date(lead.nextActionAt).getTime() < now).length;
  const slaBreached = leads.filter((lead) => {
    const dueAt = lead.slaDueAt ? new Date(lead.slaDueAt).getTime() : 0;
    return Boolean(!lead.firstContactAt && dueAt > 0 && dueAt < now && String(lead.status || "").toLowerCase().includes("contattare"));
  }).length;

  leads.forEach((lead) => {
    incrementCounter(statuses, normalizeBucketKey(lead.status, "Senza stato"));
    incrementCounter(sources, normalizeBucketKey(lead.sourcePlatform || lead.source, "manuale"));
    if (lead.lossReason) {
      incrementCounter(lossReasons, normalizeBucketKey(lead.lossReason, "altro"));
    }

    const owner = normalizeBucketKey(lead.assignedTo, "Non assegnata");
    const current =
      ownerLoad.get(owner) || {
        owner,
        total: 0,
        ready: 0,
        closed: 0,
        overdue: 0,
        slaBreached: 0
      };
    current.total += 1;
    if (lead.status === "Pronta per chiusura") current.ready += 1;
    if (lead.status === "Chiusa 100%") current.closed += 1;
    if (lead.nextActionAt && new Date(lead.nextActionAt).getTime() < now) current.overdue += 1;
    if (!lead.firstContactAt && lead.slaDueAt && new Date(lead.slaDueAt).getTime() < now && String(lead.status || "").toLowerCase().includes("contattare")) {
      current.slaBreached += 1;
    }
    ownerLoad.set(owner, current);
  });

  return {
    total,
    toContact,
    interested,
    sold,
    noAnswer,
    overdueCallbacks,
    readyToClose,
    closed,
    lost,
    disqualified,
    unassigned,
    slaBreached,
    lossReasons: sortBreakdown(lossReasons),
    statusBreakdown: sortBreakdown(statuses),
    sourceBreakdown: sortBreakdown(sources),
    ownerLoad: Array.from(ownerLoad.values()).sort((a, b) => {
      if (b.overdue !== a.overdue) return b.overdue - a.overdue;
      if (b.ready !== a.ready) return b.ready - a.ready;
      if (b.total !== a.total) return b.total - a.total;
      return a.owner.localeCompare(b.owner, "it");
    })
  };
}

/**
 * "Contatto morto" (dead contact) definition for the Marketing export segment:
 * a lead whose commercial outcome is explicitly lost or disqualified.
 * FLOW_CANCELLED leads derive closingOutcome "open" in lead-service, so they
 * are never candidates here without further code evidence they should be.
 */
const DEAD_CONTACT_OUTCOMES = new Set(["lost", "disqualified"]);

export type MarketingExportFilters = {
  dateFrom?: string;
  dateTo?: string;
  closingOutcome?: string;
  lossReason?: string;
  source?: string;
  sourcePlatform?: string;
  sourceCampaignId?: string;
  assignedTo?: string;
};

function parseMarketingExportFilters(query: Record<string, string>): MarketingExportFilters {
  return {
    dateFrom: query.dateFrom || undefined,
    dateTo: query.dateTo || undefined,
    closingOutcome: query.closingOutcome || undefined,
    lossReason: query.lossReason || undefined,
    source: query.source || undefined,
    sourcePlatform: query.sourcePlatform || undefined,
    sourceCampaignId: query.sourceCampaignId || undefined,
    assignedTo: query.assignedTo || undefined
  };
}

export function filterDeadContacts(leads: any[], filters: MarketingExportFilters = {}) {
  const dateFromMs = filters.dateFrom ? new Date(filters.dateFrom).getTime() : null;
  const dateToMs = filters.dateTo ? new Date(filters.dateTo).getTime() : null;
  return leads.filter((lead) => {
    if (!DEAD_CONTACT_OUTCOMES.has(String(lead.closingOutcome || ""))) return false;
    if (filters.closingOutcome && DEAD_CONTACT_OUTCOMES.has(filters.closingOutcome) && lead.closingOutcome !== filters.closingOutcome) {
      return false;
    }
    if (filters.lossReason && String(lead.lossReason || "") !== filters.lossReason) return false;
    if (filters.source && String(lead.source || "") !== filters.source) return false;
    if (filters.sourcePlatform && String(lead.sourcePlatform || "") !== filters.sourcePlatform) return false;
    if (filters.sourceCampaignId && String(lead.sourceCampaignId || "") !== filters.sourceCampaignId) return false;
    if (filters.assignedTo && String(lead.assignedTo || "") !== filters.assignedTo) return false;
    if (dateFromMs !== null || dateToMs !== null) {
      const createdMs = lead.createdAt ? new Date(lead.createdAt).getTime() : NaN;
      if (!Number.isFinite(createdMs)) return false;
      if (dateFromMs !== null && createdMs < dateFromMs) return false;
      if (dateToMs !== null && createdMs > dateToMs) return false;
    }
    // Gap documented in AGENTS-facing report: there is no marketing consent/opt-out
    // field in the CRM yet. We respect one if it is ever added (strict === false),
    // but we never fabricate consent — absence of the field means "unknown", not "yes".
    if (lead.marketingConsent === false || lead.marketingOptOut === true) return false;
    return true;
  });
}

export const INTERNAL_EXPORT_HEADERS = [
  "id",
  "nome",
  "telefono",
  "email",
  "fonte",
  "piattaforma",
  "campagna",
  "data_creazione",
  "ultimo_contatto",
  "esito",
  "motivo_perdita",
  "dettaglio_perdita",
  "operatore"
];

export function buildInternalExportRows(leads: any[]) {
  return leads.map((lead) => [
    lead.id || "",
    lead.fullName || "",
    lead.phone || "",
    lead.email || "",
    lead.source || "",
    lead.sourcePlatform || "",
    lead.sourceCampaignId || "",
    lead.createdAt || "",
    lead.lastContactAt || "",
    lead.closingOutcome || "",
    lead.lossReason || "",
    lead.lossDetail || "",
    lead.assignedTo || ""
  ]);
}

// Deliberately minimal: no notes, timeline, lossDetail, documents or payments —
// this file is meant to seed a Meta Custom Audience / Customer List, not an
// internal operational export.
export const META_EXPORT_HEADERS = ["nome", "telefono", "email"];

export function buildMetaExportRows(leads: any[]) {
  return leads.map((lead) => [lead.fullName || "", lead.phone || "", lead.email || ""]);
}

export const server = http.createServer(async (req, res) => {
  try {
    const method = req.method || "GET";
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const pathname = decodeURIComponent(url.pathname);
    const query = Object.fromEntries(url.searchParams.entries()) as Record<string, string>;
    if (method === "GET" && pathname === "/health") return sendJson(res, 200, { ok: true, service: "analytics-service" });
    if (method === "GET" && pathname === "/kpis") return sendJson(res, 200, computeKpis(await loadLeads()));

    if (method === "GET" && pathname === "/export/marketing/preview") {
      const filters = parseMarketingExportFilters(query);
      const leads = filterDeadContacts(await loadLeads(), filters);
      const sample = leads.slice(0, 50).map((lead) => ({
        id: lead.id,
        fullName: lead.fullName || "",
        phone: lead.phone || "",
        email: lead.email || "",
        source: lead.source || "",
        sourcePlatform: lead.sourcePlatform || "",
        closingOutcome: lead.closingOutcome || "",
        lossReason: lead.lossReason || "",
        assignedTo: lead.assignedTo || "",
        createdAt: lead.createdAt || null
      }));
      return sendJson(res, 200, { count: leads.length, sample });
    }

    if (method === "GET" && pathname === "/export/marketing/csv") {
      const filters = parseMarketingExportFilters(query);
      const mode = query.mode === "meta" ? "meta" : "internal";
      const leads = filterDeadContacts(await loadLeads(), filters);
      const csv =
        mode === "meta" ? rowsToCsv(META_EXPORT_HEADERS, buildMetaExportRows(leads)) : rowsToCsv(INTERNAL_EXPORT_HEADERS, buildInternalExportRows(leads));
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="marketing-export-${mode}.csv"`
      });
      res.end(csv);
      return;
    }

    return sendJson(res, 404, { error: "Endpoint non trovato." });
  } catch (error: any) {
    return sendJson(res, 500, { error: error.message || "Errore interno." });
  }
});

if (process.env.NODE_ENV !== "test") {
  server.listen(PORT, HOST, () => {
    console.log(`analytics-service su http://localhost:${PORT}`);
  });
}
