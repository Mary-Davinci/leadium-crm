import http from "node:http";
import type { AuthPublicUser } from "./auth-store";
import { getUserThreeCxDn } from "./auth-store";
import { callControlInternalHeaders } from "../call-service/threecx-internal";
import { CallControlError } from "../call-service/threecx-controller";
import { findLeadByExternalOrPhone, listLeads, normalizePhone } from "../common/leadStore";
import { getMongoDb, isMongoEnabled } from "../common/mongo";

export async function lookupThreeCxCaller(_externalId: string | null, phone: string) {
  const normalized = normalizePhone(phone);
  if (!normalized || normalized.length < 7) return null;
  const variants = [normalized];
  // Italian local mobile/fixed numbers and +39 are the existing CRM's customer-number forms.
  if (normalized.startsWith("39")) variants.push(normalized.slice(2));
  else if (normalized.startsWith("0") || normalized.startsWith("3")) variants.push("39" + normalized);
  let rows: any[];
  if (isMongoEnabled()) {
    const db = await getMongoDb();
    rows = await db.collection("leads").find({ phoneNormalized: { $in: variants } }).limit(2).toArray();
  } else rows = (await listLeads()).filter(lead => variants.includes(normalizePhone(lead.phone)));
  // Multiple matching practices need an operator choice; never open an arbitrary record.
  return rows.length === 1 ? { id: String(rows[0].id || rows[0]._id), fullName: rows[0].fullName, status: rows[0].status } : null;
}

export function isThreeCxV2Path(path: string) {
  return ["/api/3cx/call", "/api/3cx/session", "/api/3cx/events"].includes(path) || /^\/api\/3cx\/calls\/[^/]+\/(answer|hangup|hold|resume|transfer)$/.test(path);
}
type Deps = {
  base: string;
  resolveDn?: typeof getUserThreeCxDn;
  lookup?: typeof findLeadByExternalOrPhone;
  http?: typeof fetch;
  tickMs?: number;
};
function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body));
}
export async function handleThreeCxV2(req: http.IncomingMessage, res: http.ServerResponse, pathname: string,
  user: AuthPublicUser, sessionValid: () => boolean, deps: Deps) {
  const resolveDn = deps.resolveDn || getUserThreeCxDn, httpFetch = deps.http || fetch;
  const clientAbort = new AbortController();
  const onClientClose = () => clientAbort.abort();
  // Install before the first await: the client can leave during the identity lookup.
  res.once("close", onClientClose);
  if (res.destroyed) clientAbort.abort();
  try {
    if (["/api/3cx/session", "/api/3cx/events"].includes(pathname) && req.method !== "GET") { json(res, 405, { error: "Metodo non consentito." }); return; }
    const dn = await resolveDn(user);
    if (clientAbort.signal.aborted) return;
    if (!dn) { json(res, pathname.endsWith("/session") ? 200 : 403, pathname.endsWith("/session") ? { threeCxDn: "", available: false } : { error: "Interno 3CX non configurato" }); return; }
    const internal = async (path: string, input?: unknown, signal?: AbortSignal) => {
      const response = await httpFetch(deps.base + path, { method: input === undefined ? "GET" : "POST", redirect: "error",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000),
        headers: { ...callControlInternalHeaders(), "Content-Type": "application/json" }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
      if (!response.ok) {
        // Internal routes return fixed, sanitized messages; never forward an arbitrary upstream body.
        const messages: Record<number, string> = { 400: "Parametri chiamata non validi.", 403: "Chiamata non disponibile per il tuo interno.", 409: "Azione non disponibile per questa chiamata o dispositivo.", 422: "Azione non supportata dall’API 3CX documentata.", 429: "Attendi prima di inviare un altro comando 3CX." };
        throw new CallControlError(messages[response.status] ? response.status : 503, messages[response.status] || "3CX momentaneamente non disponibile");
      }
      return response.json() as Promise<any>;
    };
    if (pathname === "/api/3cx/session" && req.method === "GET") {
      try { const state = await internal("/3cx/live?dn=" + dn); json(res, 200, { threeCxDn: dn, available: state.available === true }); }
      catch { json(res, 200, { threeCxDn: dn, available: false }); }
      return;
    }
    if (pathname === "/api/3cx/events" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      res.flushHeaders();
      const abort = clientAbort;
      let last = "", tick = 0;
      const callerCache = new Map<string, { expires: number; lead: any }>();
      while (!abort.signal.aborted) {
        if (!sessionValid()) { res.write('event: session_expired\ndata: {}\n\n'); break; }
        if (await resolveDn(user) !== dn) break; // Mapping revoked/reassigned while stream open.
        let payload: any;
        try {
          const state = await internal("/3cx/live?dn=" + dn, undefined, abort.signal);
          const rows = Array.isArray(state.calls) ? state.calls.filter((call: any) => call.agentDn === dn) : [];
          const calls = await Promise.all(rows.map(async (call: any) => {
            let lead: any = null;
            try {
              const cached = callerCache.get(call.customerPhone);
              if (cached && cached.expires > Date.now()) lead = cached.lead;
              else { lead = await (deps.lookup || lookupThreeCxCaller)(null, call.customerPhone); callerCache.set(call.customerPhone, { expires: Date.now() + 15000, lead }); }
            } catch { /* phone still usable if CRM lookup unavailable */ }
            if (user.role === "operatore" && ["Pronta per chiusura", "Chiusa 100%"].includes(lead?.status)) lead = null;
            return { callId: call.callId, agentDn: dn, direction: call.direction, customerPhone: call.customerPhone,
              status: call.status, startedAt: call.startedAt, answeredAt: call.answeredAt,
              capabilities: call.capabilities,
              ...(lead ? { leadId: lead.id, practiceId: lead.id, customerName: lead.fullName } : {}) };
          }));
          payload = { available: state.available === true, calls };
        } catch { payload = { available: false, calls: [], error: "3CX momentaneamente non disponibile" }; }
        if (abort.signal.aborted) break;
        const data = JSON.stringify(payload);
        if (data !== last) { if (!res.write("event: calls\ndata: " + data + "\n\n")) break; last = data; }
        else if (++tick % 5 === 0) { if (!res.write(": heartbeat\n\n")) break; }
        await new Promise<void>(resolve => {
          if (abort.signal.aborted) { resolve(); return; }
          const done = () => { clearTimeout(timer); abort.signal.removeEventListener("abort", done); resolve(); };
          const timer = setTimeout(done, deps.tickMs || 1500); abort.signal.addEventListener("abort", done, { once: true });
        });
      }
      res.end(); return;
    }
    if (req.method !== "POST") { json(res, 405, { error: "Metodo non consentito." }); return; }
    let text = "";
    for await (const chunk of req) { text += chunk; if (text.length > 4096) throw new CallControlError(400, "Richiesta troppo grande."); }
    let body: any;
    try { body = text ? JSON.parse(text) : {}; } catch { throw new CallControlError(400, "JSON non valido."); }
    if (!body || Array.isArray(body) || typeof body !== "object") throw new CallControlError(400, "Parametri chiamata non validi.");
    const match = pathname.match(/^\/api\/3cx\/calls\/(\d+)\/(answer|hangup|hold|resume|transfer)$/);
    const result = await internal("/3cx/control", { actor: { userId: user.id, threeCxDn: dn }, action: pathname === "/api/3cx/call" ? "call" : match?.[2], callId: match?.[1], input: body });
    json(res, 200, { accepted: result.accepted === true, ...(typeof result.callId === "string" && /^\d+$/.test(result.callId) ? { callId: result.callId } : {}) });
  } catch (error) {
    if (res.headersSent) { res.end(); return; }
    json(res, error instanceof CallControlError ? error.status : 503, { error: error instanceof CallControlError ? error.message : "3CX momentaneamente non disponibile" });
  } finally {
    res.off("close", onClientClose);
  }
}
