import { useClock } from "../lib/use-clock";
import { Fragment, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { dayHeading, daySummary, directionLabel, formatTalk, formatTotalTalk, isInPeriod, operatorNames, operatorOf, operatorSummary, talkSeconds, type CallPeriod, type Operator } from "../features/calls/call-register";
import { buildPracticeUrl } from "../features/practices/practice-links";
import { api } from "../lib/api";
import { getAuthToken, getAuthUser } from "../lib/auth";
import "../styles/calls-page.css";

type CallOutcome = "completed" | "no_answer" | "busy" | "call_back" | "interested" | "not_interested";

type CallLead = {
  id: string;
  fullName: string;
  phone: string;
  email?: string;
  status?: string;
  assignedTo?: string;
  source?: string;
};

type CallLogItem = {
  id: string;
  leadId: string;
  startedAt: string;
  endedAt?: string;
  outcome: CallOutcome;
  actor: string;
  note?: string;
  source?: string;
  durationSeconds?: number;
  direction?: "inbound" | "outbound";
  answeredAt?: string | null;
  lead?: CallLead | null;
};

const PAGE_SIZE = 50;
// The most the server hands over: the period filter works on these.
const CALLS_LIMIT = 1000;

type ThreeCxDiagnostics = {
  enabled: boolean;
  configured: boolean;
  connected: boolean;
  lastConnectedAt: string | null;
  lastEventAt: string | null;
  lastCallId: string | null;
  lastError: string | null;
  observedDnTypes?: Record<string, string>;
  unreadableDns?: Record<string, string>;
  observedDevices?: Record<string, Array<{ deviceIdMasked: string; userAgent: string }>>;
  deviceCount?: Record<string, number>;
  recentCallAttempts?: ThreeCxCallAttempt[];
};
type ThreeCxCallAttempt = {
  attemptId: string; dn: string; at: string; outcome: string; code: string;
  httpStatus?: number; finalStatus?: string; deviceCount?: number;
  destination?: { format: string; digits: number; lastDigits: string };
  callId?: string; deviceMasked?: string; correlation?: string; candidateCount?: number;
  observation?: { dn: string; steps: string[]; ended: boolean; firstSeenAt: string; lastSeenAt: string };
};

const CORRELATION_LABELS: Record<string, string> = {
  callid: "correlata per callId",
  callid_other_dn: "callId visto solo su un altro interno (incerta)",
  probable_no_callid: "probabile, 3CX non ha restituito il callId (incerta)",
  ambiguous_no_callid: "ambigua: piu chiamate nello stesso intervallo, nessuna attribuita",
  pending: "in attesa di eventi (finestra 60 s)",
  not_observed: "nessun evento osservato: non prova che la chiamata non sia avvenuta",
  not_applicable: "richiesta non arrivata o rifiutata dal centralino"
};

// "accepted" is only the PBX acknowledgement; the monitor trace shows what was observed afterwards.
export function ThreeCxRecentAttempts({ attempts }: { attempts?: ThreeCxCallAttempt[] }) {
  return <div>
    <dt>recentCallAttempts</dt>
    <dd>{attempts?.length ? attempts.map(row => <div key={row.attemptId}>
      <strong>{new Date(row.at).toLocaleTimeString("it-IT", { timeZone: "Europe/Rome" })} · rif. {row.attemptId} · {row.dn}</strong> → {row.outcome} ({row.code})
      {row.httpStatus !== undefined ? ` · HTTP ${row.httpStatus}` : ""}{row.finalStatus ? ` · ${row.finalStatus}` : ""}
      {row.deviceCount !== undefined ? ` · ${row.deviceCount} device` : ""}{row.deviceMasked ? ` (${row.deviceMasked})` : ""}
      {row.destination ? ` · ${row.destination.format} ${row.destination.digits} cifre …${row.destination.lastDigits}` : ""}
      <div>
        {row.callId ? `callId ${row.callId} · ` : ""}{CORRELATION_LABELS[row.correlation || ""] || row.correlation || "—"}
        {row.candidateCount && row.candidateCount > 1 ? ` (${row.candidateCount} candidati)` : ""}
        {row.observation ? `: ${row.observation.steps.join(" → ")}${row.observation.ended ? "" : " (in corso)"}` : ""}
      </div>
    </div>) : "Nessun tentativo dal riavvio del servizio"}</dd>
  </div>;
}

const DEFAULT_AGENT_DNS = ["901", "913"];
const INFRASTRUCTURE_DNS = ["910", "911", "912", "920", "921", "922"];

export function ThreeCxObservedDevices({ devices, agents = DEFAULT_AGENT_DNS }: { devices?: ThreeCxDiagnostics["observedDevices"]; agents?: string[] }) {
  const observed = agents.filter(dn => Array.isArray(devices?.[dn]));
  return <div>
    <dt>observedDevices</dt>
    <dd>{observed.length ? observed.map(dn => <div key={dn}>
      <strong>{dn} · {devices![dn].length} device</strong>
      {devices![dn].length ? devices![dn].map((device, index) => <div key={index}>{device.deviceIdMasked} → {device.userAgent || "User agent non disponibile"}</div>) : <div>Nessun device registrato</div>}
    </div>) : "Device non ancora osservati"}</dd>
  </div>;
}

export function ThreeCxObservedDnTypes({ types, agents = DEFAULT_AGENT_DNS }: { types?: Record<string, string>; agents?: string[] }) {
  const observed = [...agents, ...INFRASTRUCTURE_DNS]
    .filter((dn) => typeof types?.[dn] === "string");
  return (
    <div>
      <dt>observedDnTypes</dt>
      <dd>
        {observed.length
          ? observed.map((dn) => <div key={dn}>{dn} → {types![dn]}</div>)
          : "Nessun DN osservato"}
      </dd>
    </div>
  );
}

const OUTCOME_LABELS: Record<CallOutcome, string> = {
  completed: "Completata",
  no_answer: "Senza risposta",
  busy: "Occupato",
  call_back: "Da richiamare",
  interested: "Interessato",
  not_interested: "Non interessato"
};

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString("it-IT", { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit" });
}

function formatDay(value: string) {
  return new Date(value).toLocaleString("it-IT", { timeZone: "Europe/Rome", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function CallsPage() {
  const clockTick = useClock();
  const navigate = useNavigate();
  const user = getAuthUser();
  const isAdmin = user?.role === "admin" || user?.role === "super_admin";
  const [calls, setCalls] = useState<CallLogItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [outcomeFilter, setOutcomeFilter] = useState("");
  const [directionFilter, setDirectionFilter] = useState("");
  const [operatorFilter, setOperatorFilter] = useState("");
  const [period, setPeriod] = useState<CallPeriod>("7d");
  const [page, setPage] = useState(0);
  const [operators, setOperators] = useState<Operator[]>([]);
  const [detailsOpen, setDetailsOpen] = useState<boolean | null>(null);
  const [diagnostics, setDiagnostics] = useState<ThreeCxDiagnostics | null>(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [diagnosticsError, setDiagnosticsError] = useState("");
  const [agentDns, setAgentDns] = useState<string[]>(DEFAULT_AGENT_DNS);

  function returnToLoginIfSessionInvalid() {
    // api() already clears local credentials on 401. Don't leave the cached admin header
    // visible after the gateway has lost/expired that session. No global auth change.
    if (getAuthToken()) return false;
    navigate("/login", { replace: true, state: { from: { pathname: "/calls" } } });
    return true;
  }

  async function loadCalls() {
    setLoading(true);
    setError("");
    try {
      const rows = await api<CallLogItem[]>(`/api/calls?limit=${CALLS_LIMIT}`);
      setCalls(Array.isArray(rows) ? rows : []);
    } catch (loadError) {
      if (returnToLoginIfSessionInvalid()) return;
      setError(loadError instanceof Error ? loadError.message : "Errore caricamento chiamate.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadCalls().catch(() => null);
  }, []);

  async function loadDiagnostics() {
    if (!isAdmin) return;
    setDiagnosticsLoading(true);
    setDiagnosticsError("");
    try {
      setDiagnostics(await api<ThreeCxDiagnostics>("/api/3cx/diagnostics"));
      api<{ agents?: string[] }>("/api/3cx/extensions")
        .then((list) => { if (Array.isArray(list.agents) && list.agents.length) setAgentDns(list.agents); })
        .catch(() => undefined);
    } catch (loadError) {
      setDiagnostics(null);
      if (returnToLoginIfSessionInvalid()) return;
      setDiagnosticsError(loadError instanceof Error ? loadError.message : "Stato 3CX non disponibile.");
    } finally {
      setDiagnosticsLoading(false);
    }
  }

  useEffect(() => {
    if (!isAdmin) return;
    void loadDiagnostics();
    api<Operator[]>("/api/users").then((rows) => { if (Array.isArray(rows)) setOperators(rows); }).catch(() => undefined);
  }, [isAdmin]);

  const names = useMemo(() => operatorNames(operators), [operators]);

  const filteredCalls = useMemo(() => {
    const q = search.trim().toLowerCase();
    const now = Date.now();
    return calls.filter((call) => {
      if (!isInPeriod(call, period, now)) return false;
      if (outcomeFilter && call.outcome !== outcomeFilter) return false;
      if (directionFilter && call.direction !== directionFilter) return false;
      if (operatorFilter && operatorOf(call, names) !== operatorFilter) return false;
      if (!q) return true;
      const haystack = [
        call.lead?.fullName,
        call.lead?.phone,
        call.lead?.email,
        call.lead?.assignedTo,
        operatorOf(call, names),
        call.note
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [calls, directionFilter, names, operatorFilter, outcomeFilter, period, search, clockTick]);

  useEffect(() => { setPage(0); }, [search, outcomeFilter, directionFilter, operatorFilter, period]);
  const lastPage = Math.max(0, Math.ceil(filteredCalls.length / PAGE_SIZE) - 1);
  const currentPage = Math.min(page, lastPage);
  const pageCalls = filteredCalls.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  const today = useMemo(() => daySummary(calls, Date.now()), [calls, clockTick]);
  const kpis = [
    { label: "Chiamate oggi", value: today.total, hint: `${today.inbound} in arrivo · ${today.outbound} in uscita` },
    { label: "Con risposta", value: today.answered, hint: today.total ? `${Math.round(today.answered / today.total * 100)}% delle chiamate` : "Oggi" },
    { label: "Senza risposta", value: today.unanswered, hint: "Oggi" },
    { label: "Da richiamare", value: today.callBack, hint: "Oggi" },
    { label: "Tempo in chiamata", value: formatTotalTalk(today.talk), hint: "Tutti gli operatori" }
  ];
  const byOperator = useMemo(() => operatorSummary(calls, names, Date.now()), [calls, names, clockTick]);

  const unreadable = Object.entries(diagnostics?.unreadableDns || {});
  // A problem opens the details by itself: they are what explains it.
  const linkProblem = Boolean(diagnostics) && (!diagnostics!.connected || Boolean(diagnostics!.lastError) || unreadable.length > 0);
  const showDetails = detailsOpen ?? linkProblem;
  useEffect(() => { if (linkProblem) setDetailsOpen(null); }, [linkProblem]);

  return (
    <div className="calls-page">
      <section className="calls-hero panel">
        <div>
          <span>Registro operativo</span>
          <h3>Chiamate</h3>
          <p>Controllo chiamate 3CX, esiti, clienti collegati e follow-up.</p>
        </div>
        <div className="calls-hero-actions">
          <button type="button" onClick={() => void loadCalls()}>
            Aggiorna
          </button>
        </div>
      </section>

      {error ? <p className="calls-error">{error}</p> : null}

      {isAdmin ? (
        <section className="panel calls-diagnostics" aria-labelledby="calls-3cx-title" aria-busy={diagnosticsLoading}>
          <div className="calls-diagnostics-heading">
            <span className={`calls-link-dot ${diagnostics?.connected ? "on" : "off"}`} aria-hidden="true" />
            <h4 id="calls-3cx-title">Stato 3CX</h4>
            {diagnostics ? <span className="calls-link-text">
              {diagnostics.connected
                ? `Centralino collegato${diagnostics.lastConnectedAt ? ` dal ${formatDay(diagnostics.lastConnectedAt)}` : ""}`
                : "Centralino non collegato"}
            </span> : null}
            <span className="calls-link-spacer" />
            {agentDns.map((dn) => <span key={dn} className={`calls-dn ${diagnostics?.unreadableDns?.[dn] ? "off" : ""}`}>{names.get(dn) ? `${names.get(dn)} · ` : ""}{dn}</span>)}
            <button type="button" className="calls-open" aria-expanded={showDetails} onClick={() => setDetailsOpen(!showDetails)}>Dettagli tecnici</button>
            <button type="button" className="calls-open" disabled={diagnosticsLoading} onClick={() => void loadDiagnostics()}>Aggiorna stato</button>
          </div>
          {diagnosticsLoading ? <p className="muted" role="status">Caricamento stato 3CX...</p> : null}
          {diagnosticsError ? <p className="calls-error" role="alert">{diagnosticsError}</p> : null}
          {diagnostics && showDetails ? (
            <dl className="calls-diagnostics-fields">
              <div><dt>enabled</dt><dd>{String(diagnostics.enabled)}</dd></div>
              <div><dt>configured</dt><dd>{String(diagnostics.configured)}</dd></div>
              <div><dt>connected</dt><dd>{String(diagnostics.connected)}</dd></div>
              <div><dt>lastConnectedAt</dt><dd>{diagnostics.lastConnectedAt ? new Date(diagnostics.lastConnectedAt).toLocaleString("it-IT", { timeZone: "Europe/Rome" }) : "—"}</dd></div>
              <div><dt>lastEventAt</dt><dd>{diagnostics.lastEventAt ? new Date(diagnostics.lastEventAt).toLocaleString("it-IT", { timeZone: "Europe/Rome" }) : "—"}</dd></div>
              <div><dt>lastCallId</dt><dd>{diagnostics.lastCallId || "—"}</dd></div>
              <div><dt>lastError</dt><dd>{diagnostics.lastError || "—"}</dd></div>
              <div><dt>interni non abilitati</dt><dd>{unreadable.map(([dn, reason]) => `${dn} (${reason})`).join(", ") || "—"}</dd></div>
              <ThreeCxObservedDnTypes types={diagnostics.observedDnTypes} agents={agentDns} />
              <ThreeCxObservedDevices devices={diagnostics.observedDevices} agents={agentDns} />
              <ThreeCxRecentAttempts attempts={diagnostics.recentCallAttempts} />
            </dl>
          ) : null}
        </section>
      ) : null}

      <section className="calls-kpis">
        {kpis.map((item) => (
          <article key={item.label} className="panel calls-kpi">
            <strong>{item.value}</strong>
            <span>{item.label}</span>
            <small>{item.hint}</small>
          </article>
        ))}
      </section>

      <div className={`calls-layout ${isAdmin ? "with-side" : ""}`}>
        <section className="panel calls-register">
          <div className="calls-toolbar">
            <label className="calls-field search">
              <span>Cerca</span>
              <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Cliente, telefono, operatore..." />
            </label>
            <label className="calls-field">
              <span>Periodo</span>
              <select value={period} onChange={(event) => setPeriod(event.target.value as CallPeriod)}>
                <option value="7d">Ultimi 7 giorni</option>
                <option value="today">Oggi</option>
                <option value="all">Tutte</option>
              </select>
            </label>
            <label className="calls-field">
              <span>Direzione</span>
              <select value={directionFilter} onChange={(event) => setDirectionFilter(event.target.value)}>
                <option value="">Tutte</option>
                <option value="inbound">In arrivo</option>
                <option value="outbound">In uscita</option>
              </select>
            </label>
            <label className="calls-field">
              <span>Esito</span>
              <select value={outcomeFilter} onChange={(event) => setOutcomeFilter(event.target.value)}>
                <option value="">Tutti gli esiti</option>
                {Object.entries(OUTCOME_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {operatorFilter ? <button type="button" className="calls-chip" onClick={() => setOperatorFilter("")}>Solo {operatorFilter} · togli filtro</button> : null}

          <div className="calls-table">
            <div className="calls-table-head">
              <span>Ora</span>
              <span>Tipo</span>
              <span>Cliente</span>
              <span>Esito</span>
              <span>Durata</span>
              <span>Operatore</span>
              <span>Nota</span>
              <span />
            </div>
            {pageCalls.map((call, index) => {
              const heading = dayHeading(call.startedAt, Date.now());
              const showHeading = index === 0 || heading !== dayHeading(pageCalls[index - 1].startedAt, Date.now());
              return (
                <Fragment key={call.id}>
                  {showHeading ? <h4 className="calls-day">{heading}</h4> : null}
                  <article className="calls-row">
                    <span className="calls-time">{formatTime(call.startedAt)}</span>
                    <span>{directionLabel(call)}</span>
                    <div className="calls-client">
                      <strong>{call.lead?.fullName || "Contatto non disponibile"}</strong>
                      <small>{call.lead?.phone || "Telefono non disponibile"}</small>
                    </div>
                    <span className={`calls-outcome ${call.outcome}`}>{OUTCOME_LABELS[call.outcome] || call.outcome}</span>
                    <span>{formatTalk(talkSeconds(call))}</span>
                    <span>{operatorOf(call, names)}</span>
                    <small className="calls-note" title={call.note || undefined}>{call.note || "—"}</small>
                    <button
                      type="button"
                      className="calls-open"
                      disabled={!call.leadId}
                      onClick={() => navigate(buildPracticeUrl(call.leadId, call.outcome === "call_back" || call.outcome === "no_answer" ? "task" : "timeline"))}
                    >
                      Apri pratica
                    </button>
                  </article>
                </Fragment>
              );
            })}
            {loading ? <p className="muted">Caricamento chiamate...</p> : null}
            {!loading && !filteredCalls.length ? <p className="muted">Nessuna chiamata nel filtro corrente.</p> : null}
          </div>

          {filteredCalls.length > 0 ? <div className="calls-foot">
            <span>Mostrate {currentPage * PAGE_SIZE + 1}–{Math.min((currentPage + 1) * PAGE_SIZE, filteredCalls.length)} di {filteredCalls.length}</span>
            {lastPage > 0 ? <div>
              <button type="button" className="secondary" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Precedenti</button>
              <button type="button" className="secondary" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>Successive</button>
            </div> : null}
          </div> : null}
        </section>

        {isAdmin ? <aside className="panel calls-side">
          <strong>Oggi per operatore</strong>
          {byOperator.map((row) => (
            <button key={row.name} type="button" aria-pressed={operatorFilter === row.name} onClick={() => setOperatorFilter(operatorFilter === row.name ? "" : row.name)}>
              <span><b>{row.name}</b><small>{row.answered} con risposta · {formatTotalTalk(row.talk)}</small></span>
              <strong>{row.total}</strong>
            </button>
          ))}
          {!byOperator.length ? <p className="muted">Nessuna chiamata oggi.</p> : null}
        </aside> : null}
      </div>
    </div>
  );
}
