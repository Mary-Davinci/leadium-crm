import "../../loadEnv";
import http from "http";

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

function computeKpis(leads: any[]) {
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

const server = http.createServer(async (req, res) => {
  try {
    const method = req.method || "GET";
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const pathname = decodeURIComponent(url.pathname);
    if (method === "GET" && pathname === "/health") return sendJson(res, 200, { ok: true, service: "analytics-service" });
    if (method === "GET" && pathname === "/kpis") return sendJson(res, 200, computeKpis(await loadLeads()));
    return sendJson(res, 404, { error: "Endpoint non trovato." });
  } catch (error: any) {
    return sendJson(res, 500, { error: error.message || "Errore interno." });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`analytics-service su http://localhost:${PORT}`);
});
