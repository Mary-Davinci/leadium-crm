import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRightLeft, Check, ChevronDown, ChevronUp, ClipboardCheck, ExternalLink, Pause, Phone, PhoneIncoming, PhoneOff, PhoneOutgoing, User, X } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import { apiUrl } from "../../lib/api-url";
import { clearSession, getAuthToken } from "../../lib/auth";
import { buildPracticeUrl } from "../practices/practice-links";
import "../../styles/threecx-live.css";

/** Observed phase of the agent leg (from PBX events, never from the API acceptance). */
export type CallPhase = "incoming" | "callback_ringing" | "callback_answered" | "dialing_customer" | "connected" | "hold" | "other";
export type LiveCall = {
  callId: string; direction: "inbound" | "outbound"; customerPhone: string; agentDn: string;
  status: "ringing" | "connected" | "hold"; startedAt: string; answeredAt?: string;
  phase?: CallPhase; connectedAt?: string;
  leadId?: string; practiceId?: string; customerName?: string;
  capabilities: { answer: boolean; hangup: boolean; transfer: boolean; hold: boolean; resume: boolean };
};
export type DeviceOption = { device: string; label: string; userAgent: string };
export type DialTarget = { leadId?: string; customerName?: string };

/** One outbound attempt, from the click until it is dismissed. */
export type Attempt = {
  id: number;
  phone: string;
  target: DialTarget;
  stage: "preparing" | "choosing" | "requesting" | "accepted" | "error" | "cancelled";
  devices?: DeviceOption[];
  device?: DeviceOption;
  attemptId?: string;
  callId?: string;
  destination?: string;
  error?: string;
  uncertain?: boolean;
  acceptedAt?: number;
  matchedCallId?: string;
  correlation?: "callid" | "probable";
  phase?: CallPhase;
  maxPhaseRank?: number;
  directControl?: boolean;
  connectedAt?: string;
  endedAt?: number;
  talkSeconds?: number;
  /** First snapshot without the matched call: 3CX replaces legs, so a short gap is not an end. */
  missingSince?: number;
};

type CallContext = {
  dial(phone: string, target?: DialTarget): Promise<boolean>;
  busy: boolean;
  dn: string;
  calls: LiveCall[];
  message: string;
  registerOutcomeHandler(leadId: string, open: () => void): () => void;
};
const Context = createContext<CallContext>({ dial: async () => false, busy: false, dn: "", calls: [], message: "", registerOutcomeHandler: () => () => {} });
export const useThreeCx = () => useContext(Context);

export const OBSERVATION_WINDOW_MS = 60000;
/** Fallback until /api/3cx/extensions answers; the configured list comes from the backend. */
export const DEFAULT_TRANSFER_TARGETS = ["901", "913", "910", "911", "912"];
const PHASE_RANK: Record<string, number> = { callback_ringing: 1, callback_answered: 2, dialing_customer: 3, connected: 4 };
/** How long a matched call may be missing from the snapshots before the attempt is ended. */
export const END_GRACE_MS = 4000;
const ATTEMPT_STORAGE_KEY = "leadium.threecx.attempt";
/** Event fired after an admin changes the signed-in user's extension mapping. */
export const MAPPING_CHANGED_EVENT = "leadium:threecx-mapping-changed";

/** An open attempt survives a page reload in this tab only; storage failures are ignored. */
function storeAttempt(dn: string, attempt: Attempt | null) {
  try {
    if (attempt && attempt.stage === "accepted") sessionStorage.setItem(ATTEMPT_STORAGE_KEY, JSON.stringify({ dn, savedAt: Date.now(), attempt }));
    else sessionStorage.removeItem(ATTEMPT_STORAGE_KEY);
  } catch { /* private mode or blocked storage */ }
}
function restoreAttempt(dn: string): Attempt | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(ATTEMPT_STORAGE_KEY) || "null");
    if (!saved || saved.dn !== dn || !(Date.now() - saved.savedAt < 2 * 3600 * 1000) || saved.attempt?.stage !== "accepted") return null;
    return saved.attempt as Attempt;
  } catch { return null; }
}

export function formatDuration(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safe / 60).toString().padStart(2, "0")}:${(safe % 60).toString().padStart(2, "0")}`;
}

export type AttemptView = {
  tone: "progress" | "action" | "live" | "done" | "warn" | "error";
  title: string;
  detail?: string;
  steps: Array<{ label: string; state: "done" | "current" | "pending" }>;
  showTimer: boolean;
};

/**
 * Readable state of an attempt. Every claim comes from what was observed: an accepted request
 * is not "the customer is ringing", and silence after the observation window is reported as
 * missing confirmation, not as a failed call.
 */
export function describeAttempt(attempt: Attempt, now: number): AttemptView {
  const rank = attempt.maxPhaseRank || 0;
  const accepted = attempt.stage === "accepted";
  const operatorLabel = attempt.directControl ? "Avvio sul dispositivo" : "Risposta nel client 3CX";
  const step = (done: boolean, current: boolean) => (done ? "done" : current ? "current" : "pending") as "done" | "current" | "pending";
  const ended = Boolean(attempt.endedAt);
  const steps = [
    { label: "Richiesta a 3CX", state: step(accepted, attempt.stage === "requesting" || attempt.stage === "preparing") },
    { label: operatorLabel, state: step(rank >= 2 || (rank >= 1 && Boolean(attempt.directControl)), accepted && !ended && rank === 1) },
    { label: "Chiamata al cliente", state: step(rank >= 4, accepted && !ended && rank === 3) },
    { label: "Conversazione", state: step(ended && attempt.talkSeconds !== undefined, accepted && !ended && rank >= 4) }
  ];
  const base = { steps, showTimer: false };
  if (attempt.stage === "preparing") return { ...base, tone: "progress", title: "Preparazione chiamata", detail: "Verifico i dispositivi 3CX del tuo interno." };
  if (attempt.stage === "choosing") return { ...base, tone: "action", title: "Scegli il dispositivo", detail: "Al tuo interno sono collegati piu dispositivi 3CX." };
  if (attempt.stage === "requesting") return { ...base, tone: "progress", title: "Invio richiesta a 3CX" };
  if (attempt.stage === "cancelled") return { ...base, tone: "done", title: "Chiamata annullata", detail: "Nessuna richiesta e stata inviata a 3CX." };
  if (attempt.stage === "error") {
    return attempt.uncertain
      ? { ...base, tone: "warn", title: "Esito incerto", detail: `${attempt.error || "3CX non ha risposto in tempo."} Prima di riprovare controlla il client 3CX: la chiamata potrebbe essere partita comunque.` }
      : { ...base, tone: "error", title: "Chiamata non avviata", detail: attempt.error || "3CX ha rifiutato la richiesta." };
  }
  if (ended) {
    return attempt.talkSeconds !== undefined
      ? { ...base, tone: "done", title: "Chiamata conclusa", detail: `Durata conversazione ${formatDuration(attempt.talkSeconds)}.` }
      : { ...base, tone: "done", title: "Chiamata terminata", detail: "Il centralino non ha segnalato una conversazione con il cliente." };
  }
  switch (attempt.phase) {
    case "callback_ringing":
      return attempt.directControl
        ? { ...base, tone: "progress", title: "Avvio sul dispositivo", detail: "Il dispositivo scelto sta avviando la chiamata." }
        : { ...base, tone: "action", title: "Rispondi nel client 3CX", detail: "Il tuo dispositivo 3CX sta squillando: e il richiamo del centralino. Rispondi li per avviare la chiamata al cliente." };
    case "callback_answered":
      return { ...base, tone: "progress", title: "Collegato al centralino", detail: "3CX sta avviando la chiamata al cliente." };
    case "dialing_customer":
      return { ...base, tone: "progress", title: "Chiamata al cliente in corso", detail: "In attesa che il cliente risponda." };
    case "connected":
      return { ...base, tone: "live", title: "In conversazione", showTimer: Boolean(attempt.connectedAt) };
    case "hold":
      return { ...base, tone: "progress", title: "Chiamata in attesa", detail: "La chiamata e stata messa in attesa dal dispositivo." };
    case "other":
      return { ...base, tone: "warn", title: "Chiamata attiva", detail: "Stato non riconosciuto dal CRM: controlla il client 3CX." };
  }
  const waited = attempt.acceptedAt ? now - attempt.acceptedAt : 0;
  return waited < OBSERVATION_WINDOW_MS
    ? { ...base, tone: "progress", title: "Richiesta accettata da 3CX", detail: "In attesa di conferma dal centralino. Se il client 3CX squilla, rispondi li per avviare la chiamata." }
    : { ...base, tone: "warn", title: "Nessun evento dal centralino", detail: "La richiesta e stata accettata ma 3CX non ha segnalato la chiamata. Controlla il client 3CX o il registro chiamate." };
}

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
  const [transferTargets, setTransferTargets] = useState<string[]>(DEFAULT_TRANSFER_TARGETS);
  const [action, setAction] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [now, setNow] = useState(Date.now());
  const [sessionVersion, setSessionVersion] = useState(0);
  const chooseDevice = useRef<((device: DeviceOption | null) => void) | null>(null);
  const outcomeHandlers = useRef(new Map<string, () => void>());
  const locked = useRef(false);
  const knownCallIds = useRef(new Set<string>());
  const panelRef = useRef<HTMLElement>(null);
  const attemptCounter = useRef(0);
  const hasPanel = Boolean(message || attempt || calls.length > 0 || (dn && !available));

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
    let retries = 0;
    const expired = () => { clearSession(); setCalls([]); navigateRef.current("/login", { replace: true }); };
    async function connect() {
      try {
        const config = await api<{ threeCxDn: string; available: boolean }>("/api/3cx/session", { signal: abort.signal });
        if (abort.signal.aborted) return;
        setDn(config.threeCxDn); setAvailable(config.available);
        // No extension yet: check again later (an admin may map it), without reloading the page.
        if (!config.threeCxDn) { retryTimer = setTimeout(() => void connect(), 60000); return; }
        api<{ transferTargets?: string[] }>("/api/3cx/extensions", { signal: abort.signal })
          .then(list => { if (Array.isArray(list.transferTargets) && list.transferTargets.length) setTransferTargets(list.transferTargets.filter(value => /^\d{2,6}$/.test(value))); })
          .catch(() => undefined);
        const response = await fetch(apiUrl("/api/3cx/events"), { headers: { Authorization: "Bearer " + getAuthToken() }, signal: abort.signal, cache: "no-store" });
        if (response.status === 401) { expired(); return; }
        if (!response.ok) throw new Error();
        await consumeCallStream(response, (event, data) => {
          if (event === "session_expired") { expired(); abort.abort(); return; }
          if (event === "calls") {
            retries = 0; setAvailable(data.available === true);
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
      retryTimer = setTimeout(() => void connect(), Math.min(30000, 1000 * 2 ** Math.min(retries++, 5)));
    }
    void connect();
    return () => { abort.abort(); clearTimeout(retryTimer); };
  }, [sessionVersion]);

  useEffect(() => {
    const refresh = () => setSessionVersion(value => value + 1);
    window.addEventListener(MAPPING_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(MAPPING_CHANGED_EVENT, refresh);
  }, []);

  // Keep the open attempt across a reload of this tab; bring it back once the extension is known.
  // Restore is declared first: in the same commit it must read before the store effect writes.
  useEffect(() => {
    if (!dn) return;
    const saved = restoreAttempt(dn);
    if (saved) setAttempt(current => current || { ...saved, id: ++attemptCounter.current, missingSince: undefined });
  }, [dn]);
  useEffect(() => { if (dn) storeAttempt(dn, attempt); }, [dn, attempt]);

  // Clock for the conversation timer and the observation window, only while an attempt is open.
  useEffect(() => {
    if (!attempt || attempt.stage !== "accepted" || attempt.endedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [attempt]);

  // Follow the attempt through the PBX events: by native callId, or (no callId returned) the only
  // outbound call that appeared after the request, flagged as a probable link.
  useEffect(() => {
    setAttempt((current) => {
      if (!current || current.stage !== "accepted" || current.endedAt) return current;
      let call = current.callId ? calls.find((row) => row.callId === current.callId) : undefined;
      let correlation: Attempt["correlation"] = "callid";
      if (!current.callId && !call) {
        const since = (current.acceptedAt || 0) - 5000;
        const candidates = calls.filter((row) => row.direction === "outbound" && Date.parse(row.startedAt) >= since);
        if (candidates.length === 1) { call = candidates[0]; correlation = "probable"; }
      }
      if (call) {
        const rank = PHASE_RANK[call.phase || ""] || 0;
        return {
          ...current,
          missingSince: undefined,
          matchedCallId: call.callId,
          correlation,
          phase: call.phase,
          maxPhaseRank: Math.max(current.maxPhaseRank || 0, rank),
          directControl: call.capabilities.answer || current.directControl,
          connectedAt: current.connectedAt || call.connectedAt
        };
      }
      if (current.matchedCallId && !current.missingSince) return { ...current, missingSince: Date.now() };
      return current;
    });
  }, [calls]);

  // End only after the call stayed missing for the grace period (the clock ticks while open).
  useEffect(() => {
    setAttempt((current) => {
      if (!current || current.endedAt || !current.missingSince || now - current.missingSince < END_GRACE_MS) return current;
      const endedAt = current.missingSince;
      return { ...current, endedAt, missingSince: undefined, phase: undefined, talkSeconds: current.connectedAt ? Math.round((endedAt - Date.parse(current.connectedAt)) / 1000) : undefined };
    });
  }, [now]);

  const registerOutcomeHandler = useCallback((leadId: string, open: () => void) => {
    outcomeHandlers.current.set(leadId, open);
    return () => { if (outcomeHandlers.current.get(leadId) === open) outcomeHandlers.current.delete(leadId); };
  }, []);

  function openOutcome(leadId: string) {
    // Existing flow only: the practice's own "Registra esito" dialog, opened in place when the
    // practice is on screen, otherwise by opening the practice with that dialog.
    const open = outcomeHandlers.current.get(leadId);
    if (open) { open(); return; }
    const url = buildPracticeUrl(leadId);
    navigate(`${url}${url.includes("?") ? "&" : "?"}registraEsito=1`);
  }

  async function dial(phone: string, target: DialTarget = {}) {
    if (locked.current) return false;
    let ownDn = dn;
    if (!ownDn) {
      // The mapping may have been set after this page was opened: ask once before refusing.
      try { ownDn = (await api<{ threeCxDn: string }>("/api/3cx/session")).threeCxDn || ""; } catch { ownDn = ""; }
      if (!ownDn) { setMessage("Interno 3CX non configurato"); return false; }
      setDn(ownDn); setSessionVersion(value => value + 1);
    }
    const id = ++attemptCounter.current;
    const update = (patch: Partial<Attempt>) => setAttempt((current) => (current && current.id === id ? { ...current, ...patch } : current));
    locked.current = true; setBusy(true); setCollapsed(false); setMessage("");
    setAttempt({ id, phone, target, stage: "preparing" });
    let posted = false;
    try {
      // Fresh list for every attempt: one device is used directly, several need an explicit
      // choice (never the first one), none or unknown stop before any PBX request.
      const options = await api<{ devices: DeviceOption[] | null }>("/api/3cx/devices");
      if (options.devices === null) {
        update({ stage: "error", error: "Dispositivi 3CX non ancora disponibili: il collegamento al centralino non e pronto. Riprova tra poco." }); return false;
      }
      if (!options.devices.length) {
        update({ stage: "error", error: `Nessun dispositivo 3CX collegato all'interno ${ownDn}: apri l'app o il client web 3CX e riprova.` }); return false;
      }
      let device: DeviceOption | null = options.devices.length === 1 ? options.devices[0] : null;
      if (!device) {
        update({ stage: "choosing", devices: options.devices });
        device = await new Promise<DeviceOption | null>(resolve => { chooseDevice.current = resolve; });
        chooseDevice.current = null;
        if (!device) { update({ stage: "cancelled", devices: undefined }); return false; }
      }
      update({ stage: "requesting", device, devices: undefined });
      posted = true;
      const result = await api<{ attemptId?: string; callId?: string; destination?: string }>("/api/3cx/call", {
        method: "POST",
        body: JSON.stringify({ phone, device: device.device, ...(target.leadId ? { leadId: target.leadId } : {}) })
      });
      // PBX acceptance only: it does not prove that the device or the customer rang.
      update({ stage: "accepted", attemptId: result.attemptId, callId: result.callId, destination: result.destination, acceptedAt: Date.now() });
      setNow(Date.now());
      return true;
    } catch (error) {
      // A 5xx can be a timeout after the PBX already received the request: never invite a blind retry.
      const uncertain = posted && (!(error instanceof ApiError) || error.status >= 500);
      const attemptId = error instanceof ApiError && typeof error.payload?.attemptId === "string" ? error.payload.attemptId : undefined;
      update({ stage: "error", uncertain, attemptId, error: error instanceof Error ? error.message : "3CX momentaneamente non disponibile" });
      return false;
    }
    finally { locked.current = false; setBusy(false); }
  }

  async function control(call: LiveCall, verb: string, target?: string) {
    if (locked.current) return;
    locked.current = true; setAction(call.callId); setMessage("");
    try { await api(`/api/3cx/calls/${encodeURIComponent(call.callId)}/${verb}`, { method: "POST", body: JSON.stringify(target ? { target } : {}) }); }
    catch (error) { setMessage(error instanceof Error ? error.message : "3CX momentaneamente non disponibile"); }
    finally { locked.current = false; setAction(""); }
  }

  const attemptCall = attempt?.matchedCallId ? calls.find((row) => row.callId === attempt.matchedCallId) : undefined;
  const otherCalls = calls.filter((row) => row.callId !== attempt?.matchedCallId);
  const ringing = otherCalls.some(call => call.status === "ringing" && call.direction === "inbound") || attempt?.phase === "callback_ringing";
  const pillLabel = attempt && !attempt.endedAt && !["error", "cancelled"].includes(attempt.stage)
    ? (attempt.stage === "choosing" ? "Scegli il dispositivo 3CX" : describeAttempt(attempt, now).title)
    : otherCalls.length ? `${otherCalls.length} ${otherCalls.length === 1 ? "chiamata" : "chiamate"} 3CX` : "Telefono 3CX";

  return <Context.Provider value={{ dial, busy, dn, calls, message, registerOutcomeHandler }}>
    {children}
    {hasPanel && <aside ref={panelRef} className={`threecx-live${collapsed ? " is-collapsed" : ""}`} aria-label="Chiamate 3CX">
      {collapsed
        ? <button type="button" className="threecx-live-pill" aria-expanded="false" onClick={() => setCollapsed(false)}>
          <span className={`threecx-live-dot${ringing ? " is-ringing" : ""}`} aria-hidden="true" />
          {pillLabel}
          <ChevronUp size={14} aria-hidden="true" />
        </button>
        : <>
          <header className="threecx-live-head">
            <span><Phone size={13} aria-hidden="true" /> Telefono 3CX{dn && <em>Interno {dn}</em>}</span>
            <button type="button" className="threecx-live-icon" aria-expanded="true" aria-label="Riduci pannello chiamate" title="Riduci" onClick={() => setCollapsed(true)}><ChevronDown size={16} aria-hidden="true" /></button>
          </header>
          {dn && !available && <p className="threecx-live-notice is-warning" role="status">3CX momentaneamente non disponibile</p>}
          {message && <p className="threecx-live-notice is-error" role="status">
            <span>{message}</span>
            <button type="button" className="threecx-live-icon" aria-label="Chiudi messaggio" onClick={() => setMessage("")}><X size={14} aria-hidden="true" /></button>
          </p>}
          {attempt && <OutboundAttemptCard
            attempt={attempt}
            call={attemptCall}
            dn={dn}
            now={now}
            transferTargets={transferTargets}
            busy={action !== "" || busy}
            onChooseDevice={(option) => chooseDevice.current?.(option)}
            onAction={(verb, target) => attemptCall && void control(attemptCall, verb, target)}
            onOutcome={() => attempt.target.leadId && openOutcome(attempt.target.leadId)}
            onDismiss={() => setAttempt(null)}
          />}
          {otherCalls.map(call => <ThreeCxLiveCard key={call.callId} call={call} transferTargets={transferTargets} busy={action !== "" || busy} onAction={(verb, target) => void control(call, verb, target)} />)}
        </>}
    </aside>}
  </Context.Provider>;
}

type AttemptCardProps = {
  attempt: Attempt;
  call?: LiveCall;
  dn: string;
  now: number;
  transferTargets?: string[];
  busy: boolean;
  onChooseDevice(option: DeviceOption | null): void;
  onAction(verb: string, target?: string): void;
  onOutcome(): void;
  onDismiss(): void;
};

function initials(name?: string) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  return parts.length ? (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() : "";
}

/** Who is on the line, centred like a phone screen: the one place the card spends visual weight. */
function CallIdentity({ name, number, stored, practiceId, compact }: { name: string; number: string; stored?: string; practiceId?: string; compact?: boolean }) {
  const monogram = initials(name);
  // Compact (no call on the line: errors, device choice): name and number only, less height.
  if (compact) return <div className="threecx-screen-identity is-compact"><strong>{name}</strong>{number ? <span className="threecx-screen-number">{number}{stored ? <small> (salvato: {stored})</small> : null}</span> : null}</div>;
  return <div className="threecx-screen-identity">
    <span className="threecx-live-avatar" aria-hidden="true">{monogram || <User size={20} />}</span>
    <strong>{name}</strong>
    {number ? <span className="threecx-screen-number">{number}{stored ? <small> (salvato: {stored})</small> : null}</span> : null}
    {practiceId ? <Link className="threecx-live-link" to={buildPracticeUrl(practiceId)}>Apri pratica <ExternalLink size={12} aria-hidden="true" /></Link> : null}
  </div>;
}

/** Round call control with its label underneath, as on the 3CX call screen. Only real actions. */
function RoundAction({ tone, label, icon, disabled, onClick }: { tone: "accept" | "reject"; label: string; icon: ReactNode; disabled?: boolean; onClick(): void }) {
  return <button type="button" className={`threecx-round is-${tone}`} disabled={disabled} onClick={onClick}>
    <span className="threecx-round-icon" aria-hidden="true">{icon}</span>
    <span className="threecx-round-label">{label}</span>
  </button>;
}

function TransferControl({ targets, exclude, busy, onTransfer }: { targets: string[]; exclude: string; busy: boolean; onTransfer(target: string): void }) {
  const [target, setTarget] = useState("");
  return <div className="threecx-live-transfer">
    <select aria-label="Destinazione trasferimento" value={target} onChange={event => setTarget(event.target.value)} disabled={busy}>
      <option value="">Trasferisci a…</option>{targets.filter(value => value !== exclude).map(value => <option key={value} value={value}>Interno {value}</option>)}
    </select>
    <button type="button" className="threecx-live-btn is-quiet" disabled={busy || !target} onClick={() => onTransfer(target)}><ArrowRightLeft size={14} aria-hidden="true" />Trasferisci</button>
  </div>;
}

/** The single operational card of an outbound attempt: who, what was dialed, from where, what 3CX reported. */
export function OutboundAttemptCard({ attempt, call, dn, now, transferTargets = DEFAULT_TRANSFER_TARGETS, busy, onChooseDevice, onAction, onOutcome, onDismiss }: AttemptCardProps) {
  const view = describeAttempt(attempt, now);
  const closed = Boolean(attempt.endedAt) || ["error", "cancelled"].includes(attempt.stage);
  const dialed = attempt.destination || (attempt.stage === "accepted" ? attempt.phone : "");
  const talk = view.showTimer && attempt.connectedAt ? formatDuration((now - Date.parse(attempt.connectedAt)) / 1000) : null;
  const canOutcome = Boolean(attempt.target.leadId) && (Boolean(attempt.endedAt) || attempt.phase === "connected");
  const device = attempt.device?.label || (attempt.stage === "choosing" ? "Da scegliere" : "");
  return <section className={`threecx-attempt is-${view.tone}`} aria-label="Chiamata in uscita" aria-live="polite">
    <div className="threecx-attempt-status">
      <span className="threecx-live-badge"><PhoneOutgoing size={12} aria-hidden="true" />{view.title}</span>
      {talk ? <time aria-label="Durata conversazione">{talk}</time> : null}
    </div>

    <CallIdentity name={attempt.target.customerName || "Cliente"} number={dialed || attempt.phone}
      stored={dialed && dialed !== attempt.phone ? attempt.phone : undefined} practiceId={attempt.target.leadId}
      compact={attempt.stage !== "accepted" || Boolean(attempt.endedAt)} />
    {view.detail ? <p className="threecx-attempt-detail">{view.detail}</p> : null}

    {attempt.stage === "choosing" && attempt.devices ? <div className="threecx-live-devices" role="group" aria-label="Scegli il dispositivo">
      <strong>Da quale dispositivo vuoi chiamare?</strong>
      {attempt.devices.map(option => <button type="button" key={option.device} className="threecx-live-device" onClick={() => onChooseDevice(option)}>
        <Phone size={14} aria-hidden="true" />
        <span><b>{option.label}</b><small>{option.userAgent && option.userAgent !== "[redacted]" ? option.userAgent : "Dettagli non disponibili"} · {option.device.slice(-4)}</small></span>
      </button>)}
      <button type="button" className="threecx-live-btn is-quiet" onClick={() => onChooseDevice(null)}>Annulla</button>
    </div> : null}

    {attempt.stage === "accepted" || attempt.stage === "requesting" ? <ol className="threecx-attempt-steps" aria-label="Avanzamento">
      {view.steps.map(row => <li key={row.label} className={`is-${row.state}`}>
        <span aria-hidden="true">{row.state === "done" ? <Check size={10} /> : null}</span>{row.label}
        <span className="threecx-sr">{row.state === "done" ? " (fatto)" : row.state === "current" ? " (in corso)" : " (in attesa)"}</span>
      </li>)}
    </ol> : null}

    <p className="threecx-attempt-meta">Interno {dn || "—"}{device ? <> · <span>{device}</span></> : null}</p>

    {attempt.correlation === "probable" && !closed ? <p className="threecx-attempt-note">Collegamento alla chiamata non certo: 3CX non ha restituito l'identificativo.</p> : null}

    {!closed && call?.capabilities.hangup ? <div className="threecx-round-row">
      <RoundAction tone="reject" icon={<PhoneOff size={22} />} label={attempt.phase === "connected" ? "Termina" : "Annulla chiamata"} disabled={busy} onClick={() => onAction("hangup")} />
    </div> : null}
    {!closed && call?.capabilities.transfer ? <TransferControl targets={transferTargets} exclude={dn} busy={busy} onTransfer={value => onAction("transfer", value)} /> : null}

    {canOutcome || closed ? <div className="threecx-attempt-actions">
      {canOutcome ? <button type="button" className="threecx-live-btn is-primary" onClick={onOutcome}><ClipboardCheck size={15} aria-hidden="true" />Registra esito</button> : null}
      {closed ? <button type="button" className="threecx-live-btn is-quiet" onClick={onDismiss}>Chiudi</button> : null}
    </div> : null}

    {attempt.attemptId ? <small className="threecx-attempt-ref">Riferimento per la diagnostica: {attempt.attemptId}</small> : null}
  </section>;
}

const STATUS_LABEL = { incoming: "Chiamata in arrivo", outgoing: "Chiamata in uscita", connected: "In chiamata", hold: "In attesa" } as const;

export function ThreeCxLiveCard({ call, busy, onAction, transferTargets = DEFAULT_TRANSFER_TARGETS }: { call: LiveCall; busy: boolean; onAction(verb: string, target?: string): void; transferTargets?: string[] }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const seconds = Math.max(0, Math.floor((now - Date.parse(call.answeredAt || call.startedAt)) / 1000));
  const duration = formatDuration(seconds);
  const incoming = call.status === "ringing" && call.direction === "inbound";
  const state = call.status === "ringing" ? (incoming ? "incoming" : "outgoing") : call.status;
  const StateIcon = state === "incoming" ? PhoneIncoming : state === "outgoing" ? PhoneOutgoing : state === "hold" ? Pause : Phone;
  return <section className={`threecx-live-call is-${state}`} aria-label={incoming ? "Chiamata in arrivo" : "Chiamata 3CX attiva"}>
    <div className="threecx-live-status">
      <span className="threecx-live-badge"><StateIcon size={12} aria-hidden="true" />{STATUS_LABEL[state]}</span>
      <time aria-label="Durata">{duration}</time>
    </div>
    <CallIdentity name={call.customerName || "Numero non associato"} number={call.customerPhone} practiceId={call.practiceId} />
    {incoming
      ? <div className="threecx-round-row">
        <RoundAction tone="accept" icon={<Phone size={22} />} label="Rispondi" disabled={busy || !call.capabilities.answer} onClick={() => onAction("answer")} />
        {call.capabilities.hangup ? <RoundAction tone="reject" icon={<PhoneOff size={22} />} label="Rifiuta" disabled={busy} onClick={() => onAction("hangup")} /> : null}
      </div>
      : call.capabilities.hangup ? <div className="threecx-round-row"><RoundAction tone="reject" icon={<PhoneOff size={22} />} label="Termina" disabled={busy} onClick={() => onAction("hangup")} /></div> : null}
    {incoming && !call.capabilities.answer && <small className="threecx-live-hint">Rispondi dal dispositivo 3CX</small>}
    {call.capabilities.transfer && <TransferControl targets={transferTargets} exclude={call.agentDn} busy={busy} onTransfer={value => onAction("transfer", value)} />}
  </section>;
}
