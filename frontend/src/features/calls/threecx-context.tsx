import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRightLeft, ChevronDown, ChevronUp, ExternalLink, Pause, Phone, PhoneIncoming, PhoneOff, PhoneOutgoing, User, X } from "lucide-react";
import { api, ApiError } from "../../lib/api";
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
export type DeviceOption = { device: string; label: string; userAgent: string };
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
  const [messageTone, setMessageTone] = useState<"info" | "error">("info");
  const [available, setAvailable] = useState(false);
  const [action, setAction] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [deviceChoice, setDeviceChoice] = useState<DeviceOption[] | null>(null);
  const chooseDevice = useRef<((device: string | null) => void) | null>(null);
  const locked = useRef(false);
  const knownCallIds = useRef(new Set<string>());
  const panelRef = useRef<HTMLElement>(null);
  const hasPanel = Boolean(message || deviceChoice || calls.length > 0 || (dn && !available));
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
    if (!dn) { setMessageTone("error"); setMessage("Interno 3CX non configurato"); return false; }
    locked.current = true; setBusy(true); setCollapsed(false); setMessageTone("info"); setMessage("Verifico i dispositivi 3CX...");
    let posted = false;
    try {
      // Fresh list for every attempt: one device is used directly, several need an explicit
      // choice (never the first one), none or unknown stop before any PBX request.
      const options = await api<{ devices: DeviceOption[] | null }>("/api/3cx/devices");
      if (options.devices === null) {
        setMessageTone("error"); setMessage("Dispositivi 3CX non ancora disponibili: il collegamento al centralino non e pronto. Riprova tra poco."); return false;
      }
      if (!options.devices.length) {
        setMessageTone("error"); setMessage(`Nessun dispositivo 3CX collegato all'interno ${dn}: apri l'app o il client web 3CX e riprova.`); return false;
      }
      let device = options.devices.length === 1 ? options.devices[0].device : null;
      if (!device) {
        setMessage("");
        device = await new Promise<string | null>(resolve => { chooseDevice.current = resolve; setDeviceChoice(options.devices); });
        chooseDevice.current = null; setDeviceChoice(null);
        if (!device) { setMessage("Chiamata annullata."); return false; }
      }
      setMessage("Avvio chiamata...");
      posted = true;
      const result = await api<{ attemptId?: string }>("/api/3cx/call", { method: "POST", body: JSON.stringify({ phone, device }) });
      // PBX acceptance only: it does not prove that the device or the customer rang.
      setMessage(`Richiesta accettata da 3CX${result?.attemptId ? ` (rif. ${result.attemptId})` : ""}. Se il tuo dispositivo 3CX squilla, rispondi: può essere il richiamo che precede la chiamata al cliente.`); return true;
    } catch (error) {
      setMessageTone("error");
      // A 503 can be a timeout after the PBX already received the request: never invite a blind retry.
      const uncertain = posted && (!(error instanceof ApiError) || error.status >= 500);
      setMessage((error instanceof Error ? error.message : "3CX momentaneamente non disponibile") + (uncertain ? " Prima di riprovare controlla il dispositivo 3CX: la chiamata potrebbe essere partita comunque." : ""));
      return false;
    }
    finally { locked.current = false; setBusy(false); }
  }
  async function control(call: LiveCall, verb: string, target?: string) {
    if (locked.current) return;
    locked.current = true; setAction(call.callId); setMessage("");
    try { await api(`/api/3cx/calls/${encodeURIComponent(call.callId)}/${verb}`, { method: "POST", body: JSON.stringify(target ? { target } : {}) }); }
    catch (error) { setMessageTone("error"); setMessage(error instanceof Error ? error.message : "3CX momentaneamente non disponibile"); }
    finally { locked.current = false; setAction(""); }
  }
  const ringing = calls.some(call => call.status === "ringing" && call.direction === "inbound");
  return <Context.Provider value={{ dial, busy, dn, calls, message }}>
    {children}
    {hasPanel && <aside ref={panelRef} className={`threecx-live${collapsed ? " is-collapsed" : ""}`} aria-label="Chiamate 3CX">
      {collapsed
        ? <button type="button" className="threecx-live-pill" aria-expanded="false" onClick={() => setCollapsed(false)}>
          <span className={`threecx-live-dot${ringing ? " is-ringing" : ""}`} aria-hidden="true" />
          {deviceChoice ? "Scegli il dispositivo 3CX" : calls.length ? `${calls.length} ${calls.length === 1 ? "chiamata" : "chiamate"} 3CX` : "Telefono 3CX"}
          <ChevronUp size={14} aria-hidden="true" />
        </button>
        : <>
          <header className="threecx-live-head">
            <span><Phone size={13} aria-hidden="true" /> Telefono 3CX{dn && <em>Interno {dn}</em>}</span>
            <button type="button" className="threecx-live-icon" aria-expanded="true" aria-label="Riduci pannello chiamate" title="Riduci" onClick={() => setCollapsed(true)}><ChevronDown size={16} aria-hidden="true" /></button>
          </header>
          {dn && !available && <p className="threecx-live-notice is-warning" role="status">3CX momentaneamente non disponibile</p>}
          {message && <p className={`threecx-live-notice${messageTone === "error" ? " is-error" : ""}`} role="status">
            <span>{message}</span>
            {!busy && <button type="button" className="threecx-live-icon" aria-label="Chiudi messaggio" onClick={() => setMessage("")}><X size={14} aria-hidden="true" /></button>}
          </p>}
          {deviceChoice && <section className="threecx-live-devices" aria-label="Scegli il dispositivo">
            <strong>Da quale dispositivo vuoi chiamare?</strong>
            <span>Sul dispositivo scelto puo arrivare prima una chiamata da 3CX: rispondi per collegarti al cliente.</span>
            {deviceChoice.map(option => <button type="button" key={option.device} className="threecx-live-device" onClick={() => chooseDevice.current?.(option.device)}>
              <Phone size={14} aria-hidden="true" />
              <span><b>{option.label}</b><small>{option.userAgent && option.userAgent !== "[redacted]" ? option.userAgent : "Dettagli non disponibili"} · {option.device.slice(-4)}</small></span>
            </button>)}
            <button type="button" className="threecx-live-btn is-quiet" onClick={() => chooseDevice.current?.(null)}>Annulla</button>
          </section>}
          {calls.map(call => <ThreeCxLiveCard key={call.callId} call={call} busy={action !== "" || busy} onAction={(verb, target) => void control(call, verb, target)} />)}
        </>}
    </aside>}
  </Context.Provider>;
}

const STATUS_LABEL = { incoming: "Chiamata in arrivo", outgoing: "Chiamata in uscita", connected: "In chiamata", hold: "In attesa" } as const;

function initials(name?: string) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  return parts.length ? (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() : "";
}

export function ThreeCxLiveCard({ call, busy, onAction }: { call: LiveCall; busy: boolean; onAction(verb: string, target?: string): void }) {
  const [target, setTarget] = useState("");
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const seconds = Math.max(0, Math.floor((now - Date.parse(call.answeredAt || call.startedAt)) / 1000));
  const duration = `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
  const incoming = call.status === "ringing" && call.direction === "inbound";
  const state = call.status === "ringing" ? (incoming ? "incoming" : "outgoing") : call.status;
  const StateIcon = state === "incoming" ? PhoneIncoming : state === "outgoing" ? PhoneOutgoing : state === "hold" ? Pause : Phone;
  const monogram = initials(call.customerName);
  return <section className={`threecx-live-call is-${state}`} aria-label={incoming ? "Chiamata in arrivo" : "Chiamata 3CX attiva"}>
    <div className="threecx-live-status">
      <span className="threecx-live-badge"><StateIcon size={12} aria-hidden="true" />{STATUS_LABEL[state]}</span>
      <time aria-label="Durata">{duration}</time>
    </div>
    <div className="threecx-live-identity">
      <span className="threecx-live-avatar" aria-hidden="true">{monogram || <User size={18} />}</span>
      <span className="threecx-live-who">
        <strong>{call.customerName || "Numero non associato"}</strong>
        <span>{call.customerPhone}</span>
      </span>
      {call.practiceId && <Link className="threecx-live-link" to={buildPracticeUrl(call.practiceId)}>Apri pratica <ExternalLink size={12} aria-hidden="true" /></Link>}
    </div>
    {incoming
      ? <div className="threecx-live-answer">
        <button type="button" className="threecx-live-btn is-accept" disabled={busy || !call.capabilities.answer} onClick={() => onAction("answer")}><Phone size={16} aria-hidden="true" />Rispondi</button>
        {call.capabilities.hangup && <button type="button" className="threecx-live-btn is-reject" disabled={busy} onClick={() => onAction("hangup")}><PhoneOff size={16} aria-hidden="true" />Rifiuta</button>}
      </div>
      : call.capabilities.hangup && <button type="button" className="threecx-live-btn is-reject is-wide" disabled={busy} onClick={() => onAction("hangup")}><PhoneOff size={16} aria-hidden="true" />Termina</button>}
    {incoming && !call.capabilities.answer && <small className="threecx-live-hint">Rispondi dal dispositivo 3CX</small>}
    {call.capabilities.transfer && <div className="threecx-live-transfer">
      <select aria-label="Destinazione trasferimento" value={target} onChange={event => setTarget(event.target.value)} disabled={busy}>
        <option value="">Trasferisci a…</option>{["901", "913", "910", "911", "912"].filter(dn => dn !== call.agentDn).map(dn => <option key={dn} value={dn}>Interno {dn}</option>)}
      </select>
      <button type="button" className="threecx-live-btn is-quiet" disabled={busy || !target} onClick={() => onAction("transfer", target)}><ArrowRightLeft size={14} aria-hidden="true" />Trasferisci</button>
    </div>}
  </section>;
}
