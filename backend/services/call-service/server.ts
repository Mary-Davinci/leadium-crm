import "../../loadEnv";
import http from "http";

const HOST = "0.0.0.0";
const PORT = Number(process.env.CALL_SERVICE_PORT || 4303);
const LEAD_URL = process.env.LEAD_SERVICE_URL || "http://localhost:4301";

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function parseBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(new Error("Body too large"));
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

async function forwardEventToLead(eventPayload: any) {
  const res = await fetch(`${LEAD_URL}/internal/call-events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(eventPayload)
  });
  if (!res.ok) throw new Error((await res.text()) || "Errore inoltro evento al lead-service.");
  return res.json();
}

const server = http.createServer(async (req, res) => {
  try {
    const method = req.method || "GET";
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const pathname = decodeURIComponent(url.pathname);
    if (method === "GET" && pathname === "/health") return sendJson(res, 200, { ok: true, service: "call-service" });
    if (method === "POST" && pathname === "/3cx/webhook") {
      const payload = await parseBody(req);
      const result = await forwardEventToLead(payload);
      return sendJson(res, 200, result);
    }
    return sendJson(res, 404, { error: "Endpoint non trovato." });
  } catch (error: any) {
    return sendJson(res, 500, { error: error.message || "Errore interno." });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`call-service su http://localhost:${PORT}`);
});
