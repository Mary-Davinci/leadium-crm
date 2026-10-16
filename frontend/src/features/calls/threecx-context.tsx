import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../../lib/api";
import { apiUrl } from "../../lib/api-url";
import { clearSession, getAuthToken } from "../../lib/auth";
import { buildPracticeUrl } from "../practices/practice-links";
import "../../styles/threecx-live.css";

export type LiveCall = {
  callId: string; direction: "inbound" | "outbound"; customerPhone: string; agentDn: string;
  status: "ringing" | "connected" | "hold"; startedAt: string; answeredAt?: string;
  leadId?: string; practiceId?: string; customerName?: string;
  capabilities: { answer: boolean; hangup: boolean; transfer: boolean; hold: boolean; resume: boolean };
};
type CallContext = { dial(phone: string): Promise<boolean>; busy: boolean; dn: string; calls: LiveCall[]; message: string };
const Context = createContext<CallContext>({ dial: async () => false, busy: false, dn: "", calls: [], message: "" });
export const useThreeCx = () => useContext(Context);

export async function consumeCallStream(response: Response, receive: (event: string, data: any) => void) {
  if (!response.body) throw new Error("Stream non disponibile");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      buffer += decoder.decode(part.value, { stream: true });
      if (buffer.length > 1000000) throw new Error("Stream non valido");
      let index: number;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, index); buffer = buffer.slice(index + 2);
        const event = frame.split("\n").find(line => line.startsWith("event: "))?.slice(7);
        const data = frame.split("\n").find(line => line.startsWith("data: "))?.slice(6);
        if (event && data) receive(event, JSON.parse(data));
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function ThreeCxProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const [dn, setDn] = useState("");
  const [calls, setCalls] = useState<LiveCall[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [available, setAvailable] = useState(false);
  const [action, setAction] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const locked = useRef(false);
  const knownCallIds = useRef(new Set<string>());
  const panelRef = useRef<HTMLElement>(null);
  const hasPanel = Boolean(message || calls.length > 0 || (dn && !available));
  useEffect(() => {
    const panel = panelRef.current;
    const shell = panel?.previousElementSibling;
    if (!panel || !(shell instanceof HTMLElement)) return;
    // Leave enough scroll space below the last page control while the floating panel is open.
    const updateGap = () => shell.style.setProperty("--threecx-live-gap", `${Math.ceil(panel.getBoundingClientRect().height) + 32}px`);
    updateGap();
    const observer = new ResizeObserver(updateGap);
    observer.observe(panel);
    return () => { observer.disconnect(); shell.style.removeProperty("--threecx-live-gap"); };
  }, [hasPanel]);
  useEffect(() => {
    const abort = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout>;
    let attempt = 0;
    const expired = () => { clearSession(); setCalls([]); navigateRef.current("/login", { replace: true }); };
    async function connect() {
      try {
        const config = await api<{ threeCxDn: string; available: boolean }>("/api/3cx/session", { signal: abort.signal });
        if (abort.signal.aborted) return;
        setDn(config.threeCxDn); setAvailable(config.available);
        if (!config.threeCxDn) return;
        const response = await fetch(apiUrl("/api/3cx/events"), { headers: { Authorization: "Bearer " + getAuthToken() }, signal: abort.signal, cache: "no-store" });
        if (response.status === 401) { expired(); return; }
        if (!response.ok) throw new Error();
        await consumeCallStream(response, (event, data) => {
          if (event === "session_expired") { expired(); abort.abort(); return; }
          if (event === "calls") {
            attempt = 0; setAvailable(data.available === true);
            // Full snapshots replace old rows: reconnects/updates cannot duplicate a popup.
            const unique = new Map<string, LiveCall>();
            for (const call of data.calls || []) if (call.agentDn === config.threeCxDn) unique.set(call.callId, call);
            if ([...unique.keys()].some(id => !knownCallIds.current.has(id))) setCollapsed(false);
            knownCallIds.current = new Set(unique.keys());
            setCalls([...unique.values()]);
          }
        });
      } catch { if (!getAuthToken() && !abort.signal.aborted) { expired(); return; } }
      if (abort.signal.aborted) return;
      setAvailable(false); setCalls([]);
      retryTimer = setTimeout(() => void connect(), Math.min(30000, 1000 * 2 ** Math.min(attempt++, 5)));
    }
    void connect();
    return () => { abort.abort(); clearTimeout(retryTimer); };
  }, []);

  async function dial(phone: string) {
    if (locked.current) return false;
    if (!dn) { setMessage("Interno 3CX non configurato"); return false; }
    locked.current = true; setBusy(true); setCollapsed(false); setMessage("Avvio chiamata...");
    try {
      await api("/api/3cx/call", { method: "POST", body: JSON.stringify({ phone }) });
      setMessage("Chiamata inviata a 3CX"); return true;
    } catch (error) { setMessage(error instanceof Error ? error.message : "3CX momentaneamente non disponibile"); return false; }
    finally { locked.current = false; setBusy(false); }
  }
  async function control(call: LiveCall, verb: string, target?: string) {
    if (locked.current) return;
    locked.current = true; setAction(call.callId); setMessage("");
    try { await api(`/api/3cx/calls/${encodeURIComponent(call.callId)}/${verb}`, { method: "POST", body: JSON.stringify(target ? { target } : {}) }); }
    catch (error) { setMessage(error instanceof Error ? error.message : "3CX momentaneamente non disponibile"); }
    finally { locked.current = false; setAction(""); }
  }
  return <Context.Provider value={{ dial, busy, dn, calls, message }}>
    {children}
    {hasPanel && <aside ref={panelRef} className="threecx-live" aria-label="Chiamate 3CX">
      <button type="button" className="secondary" aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}>{collapsed ? `Mostra chiamate (${calls.length})` : "Riduci pannello chiamate"}</button>
      {!collapsed && <>
      {message && <p role="status">{message}</p>}
      {dn && !available && <p role="status">3CX momentaneamente non disponibile</p>}
      {calls.map(call => <ThreeCxLiveCard key={call.callId} call={call} busy={action !== "" || busy} onAction={(verb, target) => void control(call, verb, target)} />)}
      </>}
    </aside>}
  </Context.Provider>;
}

export function ThreeCxLiveCard({ call, busy, onAction }: { call: LiveCall; busy: boolean; onAction(verb: string, target?: string): void }) {
  const [target, setTarget] = useState("");
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const seconds = Math.max(0, Math.floor((now - Date.parse(call.answeredAt || call.startedAt)) / 1000));
  const duration = `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
  return <section className="threecx-live-call" aria-label={call.direction === "inbound" && call.status === "ringing" ? "Chiamata in arrivo" : "Chiamata 3CX attiva"}>
    <strong>{call.status === "ringing" ? call.direction === "inbound" ? "Chiamata in arrivo" : "Chiamata in uscita" : call.status === "hold" ? "In attesa" : "In chiamata"} · {duration}</strong>
    <span>{call.customerName || "Numero non associato"}</span><span>{call.customerPhone}</span>
    {call.practiceId && <small>Pratica #{call.practiceId}</small>}
    <div className="threecx-live-actions">
      {call.practiceId && <Link className="button secondary" to={buildPracticeUrl(call.practiceId)}>Apri pratica</Link>}
      {call.capabilities.answer && <button disabled={busy} onClick={() => onAction("answer")}>Rispondi</button>}
      {call.capabilities.hangup && <button className="secondary" disabled={busy} onClick={() => onAction("hangup")}>{call.status === "ringing" && call.direction === "inbound" ? "Rifiuta" : "Termina"}</button>}
    </div>
    {call.status === "ringing" && call.direction === "inbound" && !call.capabilities.answer && <small>Rispondi dal dispositivo 3CX</small>}
    {call.capabilities.transfer && <div className="threecx-live-actions">
      <select aria-label="Destinazione trasferimento" value={target} onChange={event => setTarget(event.target.value)} disabled={busy}>
        <option value="">Trasferisci a…</option>{["901", "913", "910", "911", "912"].filter(dn => dn !== call.agentDn).map(dn => <option key={dn} value={dn}>{dn}</option>)}
      </select><button className="secondary" disabled={busy || !target} onClick={() => onAction("transfer", target)}>Trasferisci</button>
    </div>}
  </section>;
}
