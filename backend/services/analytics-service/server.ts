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
  const res = await fetch(`${LEAD_URL}/leads`);
  if (!res.ok) throw new Error("Impossibile leggere lead dal lead-service.");
  return res.json();
}

function computeKpis(leads: any[]) {
  const total = leads.length;
  const toContact = leads.filter((lead) => lead.status === "Da contattare").length;
  const interested = leads.filter((lead) => lead.status === "Contatto interessato").length;
  const sold = leads.filter((lead) => lead.status === "Venduta").length;
  const noAnswer = leads.filter((lead) => lead.status === "Non risponde").length;
  const overdueCallbacks = leads.filter((lead) => lead.nextActionAt && new Date(lead.nextActionAt).getTime() < Date.now()).length;
  return { total, toContact, interested, sold, noAnswer, overdueCallbacks };
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
