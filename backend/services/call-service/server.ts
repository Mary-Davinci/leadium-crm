import "../../loadEnv";
import http from "http";
import { ThreeCxMonitor, monitorConfig } from "./threecx-monitor";
import { createMonitorStore } from "./threecx-store";
import { ThreeCxController, ThreeCxOAuth, CallControlError, capabilities, validateThreeCxDn } from "./threecx-controller";
import { isCallControlInternal } from "./threecx-internal";

// Internal service: reached only through the gateway in the same process. INTERNAL_SERVICE_HOST=127.0.0.1
// keeps its port off the network (the gateway keeps listening on 0.0.0.0).
const HOST = process.env.INTERNAL_SERVICE_HOST || "0.0.0.0";
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

async function forwardEventToLead(eventPayload: any, signal?: AbortSignal) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, 15000);
  try {
    const res = await fetch(`${LEAD_URL}/internal/call-events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(eventPayload), signal: controller.signal
    });
    if (!res.ok) throw new Error("Errore inoltro evento al lead-service.");
    return await res.json();
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
}

const config = monitorConfig();
const oauth = new ThreeCxOAuth(config);
const monitor = new ThreeCxMonitor(config, {
  oauth,
  store: createMonitorStore(config.baseUrl || "disabled"),
  deliver: async (event, signal) => { await forwardEventToLead(event, signal); }
});
const controller = new ThreeCxController(config, oauth, () => monitor.liveCalls(), undefined, undefined, undefined, dn => monitor.devicesForDn(dn), id => monitor.maskDeviceId(id), id => monitor.noteMakecall(id));

export const server = http.createServer(async (req, res) => {
  try {
    const method = req.method || "GET";
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const pathname = decodeURIComponent(url.pathname);
    if (method === "GET" && pathname === "/health") return sendJson(res, 200, { ok: true, service: "call-service" });
    if (method === "GET" && pathname === "/3cx/diagnostics") {
      // Includes recent call attempts: only reachable through the admin-gated gateway route.
      if (!isCallControlInternal(req.headers["x-leadium-call-control"])) return sendJson(res, 403, { error: "Permesso negato." });
      return sendJson(res, 200, { ...monitor.diagnostics(), recentCallAttempts: controller.recentAttempts({ trace: id => monitor.callTrace(id), between: (dn, from, to) => monitor.callTracesBetween(dn, from, to) }) });
    }
    if (pathname === "/3cx/live" || pathname === "/3cx/control" || pathname === "/3cx/devices") {
      if (!isCallControlInternal(req.headers["x-leadium-call-control"])) return sendJson(res, 403, { error: "Permesso negato." });
      if (pathname === "/3cx/live" && method === "GET") {
        const dn = validateThreeCxDn(url.searchParams.get("dn"));
        if (!dn) return sendJson(res, 403, { error: "Interno 3CX non configurato" });
        const rows = monitor.liveCalls().filter(call => call.agentDn === dn);
        return sendJson(res, 200, { available: config.enabled && monitor.diagnostics().connected, calls: rows.map(({ participantId, directControl, ...call }) => ({ ...call, capabilities: capabilities({ ...call, participantId, directControl }) })) });
      }
      if (pathname === "/3cx/devices" && method === "GET") {
        // Own DN only (the gateway passes the persisted mapping); pseudonyms + readable labels.
        const dn = validateThreeCxDn(url.searchParams.get("dn"));
        if (!dn) return sendJson(res, 403, { error: "Interno 3CX non configurato" });
        return sendJson(res, 200, { available: config.enabled && monitor.diagnostics().connected, devices: monitor.deviceOptionsForDn(dn) });
      }
      if (pathname === "/3cx/control" && method === "POST") {
        if (!monitor.diagnostics().connected) return sendJson(res, 503, { error: "3CX momentaneamente non disponibile" });
        const body = await parseBody(req);
        return sendJson(res, 200, await controller.execute(body.actor, body.action, body.input, body.callId));
      }
      return sendJson(res, 405, { error: "Metodo non consentito." });
    }
    if (method === "POST" && pathname === "/3cx/webhook") {
      const payload = await parseBody(req);
      const result = await forwardEventToLead(payload);
      return sendJson(res, 200, result);
    }
    return sendJson(res, 404, { error: "Endpoint non trovato." });
  } catch (error: any) {
    if (pathnameIsControl(req.url)) return sendJson(res, error instanceof CallControlError ? error.status : 503, { error: error instanceof CallControlError ? error.message : "3CX momentaneamente non disponibile", ...(error instanceof CallControlError && error.attemptId ? { attemptId: error.attemptId } : {}) });
    return sendJson(res, 500, { error: error.message || "Errore interno." });
  }
});
function pathnameIsControl(url?: string) { return Boolean(url && /^\/3cx\/(control|live|devices)(?:\?|$)/.test(url)); }

server.listen(PORT, HOST, () => {
  console.log(`call-service su http://localhost:${PORT}`);
  monitor.start();
});

export async function stopCallService() {
  await monitor.stop();
  oauth.clear();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
if (require.main === module) {
  const stop = () => { void stopCallService().then(() => process.exit(0)); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
}
