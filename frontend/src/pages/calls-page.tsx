import { FormEvent, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { buildPracticeUrl } from "../features/practices/practice-links";
import { api } from "../lib/api";
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
  lead?: CallLead | null;
};

const OUTCOME_LABELS: Record<CallOutcome, string> = {
  completed: "Completata",
  no_answer: "Senza risposta",
  busy: "Occupato",
  call_back: "Da richiamare",
  interested: "Interessato",
  not_interested: "Non interessato"
};

const TEST_PAYLOAD = `{
  "eventType": "call_ended",
  "callId": "abc-123",
  "from": "+393331234567",
  "to": "+39021234567",
  "durationSeconds": 128,
  "disposition": "completed",
  "externalLeadId": "lead_123"
}`;

function formatDate(value?: string) {
  if (!value) return "-";
  return new Date(value).toLocaleString("it-IT", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function isToday(value?: string) {
  if (!value) return false;
  const date = new Date(value);
  const now = new Date();
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
}

function getDuration(startedAt?: string, endedAt?: string) {
  if (!startedAt || !endedAt) return "-";
  const diff = Math.max(0, Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000));
  if (!diff) return "-";
  const minutes = Math.floor(diff / 60);
  const seconds = diff % 60;
  return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export function CallsPage() {
  const navigate = useNavigate();
  const [calls, setCalls] = useState<CallLogItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [outcomeFilter, setOutcomeFilter] = useState("");
  const [payload, setPayload] = useState(TEST_PAYLOAD);
  const [result, setResult] = useState("");
  const [lastLeadId, setLastLeadId] = useState("");
  const [lastDisposition, setLastDisposition] = useState("");
  const [testOpen, setTestOpen] = useState(false);

  async function loadCalls() {
    setLoading(true);
    setError("");
    try {
      const rows = await api<CallLogItem[]>("/api/calls?limit=250");
      setCalls(Array.isArray(rows) ? rows : []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Errore caricamento chiamate.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadCalls().catch(() => null);
  }, []);

  async function sendWebhook(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const response = await api<Record<string, unknown>>("/api/3cx/webhook", {
      method: "POST",
      body: JSON.stringify(parsed)
    });
    setLastLeadId(String(response.externalLeadId || response.leadId || parsed.externalLeadId || ""));
    setLastDisposition(String(response.disposition || parsed.disposition || ""));
    setResult(JSON.stringify(response, null, 2));
    await loadCalls();
  }

  const filteredCalls = useMemo(() => {
    const q = search.trim().toLowerCase();
    return calls.filter((call) => {
      if (outcomeFilter && call.outcome !== outcomeFilter) return false;
      if (!q) return true;
      const haystack = [
        call.lead?.fullName,
        call.lead?.phone,
        call.lead?.email,
        call.lead?.assignedTo,
        call.actor,
        call.note,
        call.outcome
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [calls, outcomeFilter, search]);

  const kpis = useMemo(() => {
    const today = calls.filter((call) => isToday(call.startedAt));
    return [
      { label: "Chiamate oggi", value: today.length },
      { label: "Completate", value: today.filter((call) => call.outcome === "completed" || call.outcome === "interested").length },
      { label: "Da richiamare", value: calls.filter((call) => call.outcome === "call_back" || call.outcome === "no_answer").length },
      { label: "Clienti collegati", value: calls.filter((call) => call.lead).length }
    ];
  }, [calls]);

  return (
    <div className="calls-page">
      <section className="calls-hero panel">
        <div>
          <span>Registro operativo</span>
          <h3>Chiamate</h3>
          <p>Controllo chiamate 3CX, esiti, clienti collegati e follow-up.</p>
        </div>
        <div className="calls-hero-actions">
          <button type="button" className="secondary" onClick={() => setTestOpen((current) => !current)}>
            {testOpen ? "Nascondi test webhook" : "Test webhook 3CX"}
          </button>
          <button type="button" onClick={() => void loadCalls()}>
            Aggiorna
          </button>
        </div>
      </section>

      {error ? <p className="calls-error">{error}</p> : null}

      <section className="calls-kpis">
        {kpis.map((item) => (
          <article key={item.label} className="panel calls-kpi">
            <span>{item.label}</span>
            <strong>{item.value}</strong>
          </article>
        ))}
      </section>

      <section className="panel calls-register">
        <div className="calls-toolbar">
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Cerca cliente, telefono, operatore..." />
          <select value={outcomeFilter} onChange={(event) => setOutcomeFilter(event.target.value)}>
            <option value="">Tutti gli esiti</option>
            {Object.entries(OUTCOME_LABELS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </div>

        <div className="calls-table">
          <div className="calls-table-head">
            <span>Quando</span>
            <span>Cliente</span>
            <span>Esito</span>
            <span>Durata</span>
            <span>Operatore</span>
            <span>Note</span>
            <span>Azione</span>
          </div>
          {filteredCalls.map((call) => (
            <article key={call.id} className="calls-row">
              <span>{formatDate(call.startedAt)}</span>
              <div className="calls-client">
                <strong>{call.lead?.fullName || call.leadId}</strong>
                <small>{call.lead?.phone || "Telefono non disponibile"}</small>
              </div>
              <span className={`calls-outcome ${call.outcome}`}>{OUTCOME_LABELS[call.outcome] || call.outcome}</span>
              <span>{getDuration(call.startedAt, call.endedAt)}</span>
              <span>{call.actor || call.lead?.assignedTo || "-"}</span>
              <small>{call.note || "-"}</small>
              <button
                type="button"
                className="secondary"
                disabled={!call.leadId}
                onClick={() => navigate(buildPracticeUrl(call.leadId, call.outcome === "call_back" || call.outcome === "no_answer" ? "task" : "timeline"))}
              >
                Apri pratica
              </button>
            </article>
          ))}
          {loading ? <p className="muted">Caricamento chiamate...</p> : null}
          {!loading && !filteredCalls.length ? <p className="muted">Nessuna chiamata nel filtro corrente.</p> : null}
        </div>
      </section>

      {testOpen ? (
        <section className="calls-grid">
          <section className="panel">
            <h3>Webhook 3CX Test</h3>
            <form onSubmit={sendWebhook} className="calls-webhook-form">
              <textarea rows={12} value={payload} onChange={(e) => setPayload(e.target.value)} />
              <button type="submit">Invia evento</button>
            </form>
          </section>
          <section className="panel">
            <h3>Risposta</h3>
            <pre className="calls-code-block">{result || "Nessuna risposta ancora."}</pre>
            {lastLeadId ? (
              <div className="pd-actions">
                <button
                  type="button"
                  onClick={() =>
                    navigate(buildPracticeUrl(lastLeadId, lastDisposition === "call_back" || lastDisposition === "no_answer" ? "task" : "timeline"))
                  }
                >
                  Apri pratica
                </button>
                <button type="button" onClick={() => navigate(buildPracticeUrl(lastLeadId, "timeline"))}>
                  Vai a timeline
                </button>
              </div>
            ) : null}
          </section>
        </section>
      ) : null}
    </div>
  );
}
