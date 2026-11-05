import { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import { useAutoRefresh } from "../../lib/use-auto-refresh";
import { useClock } from "../../lib/use-clock";
import { getTaskBoardCache, setTaskBoardCache, type CrmTask } from "../../store/crm-store";
import { useThreeCx } from "../calls/threecx-context";
import { buildPracticeUrl } from "../practices/practice-links";
import type { Lead } from "../practices/pratiche.types";
import { buildOperatorDay, dueLabel } from "./operator-day";

type Sources = { tasks: CrmTask[]; leads: Lead[]; conversations: any[]; mail: any[]; calls: any[] };
const EMPTY: Sources = { tasks: [], leads: [], conversations: [], mail: [], calls: [] };
const listOf = (value: unknown) => (Array.isArray(value) ? value : []);

export function OperatorDashboard({ onSummary }: { onSummary(text: string): void }) {
  const threeCx = useThreeCx();
  const now = useClock();
  const [sources, setSources] = useState<Sources>(() => {
    const cached = getTaskBoardCache();
    return cached ? { ...EMPTY, tasks: cached.data.tasks, leads: cached.data.leads as Lead[] } : EMPTY;
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [syncedAt, setSyncedAt] = useState<number | null>(null);

  async function load() {
    setLoading(true);
    setError("");
    try {
      // The board is the work itself; a missing side source must not empty the page.
      const [board, conversations, mail, calls] = await Promise.all([
        api<{ tasks: CrmTask[]; leads: Lead[] }>("/api/tasks/board"),
        api<any[]>("/api/whatsapp/conversations").catch(() => []),
        api<{ messages: any[] }>("/api/mail/messages").then((data) => data.messages).catch(() => []),
        api<any[]>("/api/calls?limit=250").catch(() => [])
      ]);
      setTaskBoardCache(board.tasks, board.leads);
      setSources({ tasks: board.tasks, leads: board.leads, conversations: listOf(conversations), mail: listOf(mail), calls: listOf(calls) });
      setSyncedAt(Date.now());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Impossibile caricare la dashboard.");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, []);
  useAutoRefresh(load, !loading);

  const day = useMemo(() => buildOperatorDay({ ...sources, now }), [sources, now]);
  const total = day.planned + day.done + day.late;
  useEffect(() => {
    if (!syncedAt) return onSummary("Stiamo preparando la tua giornata…");
    onSummary(total ? `Oggi hai ${total} ${total === 1 ? "chiamata" : "chiamate"}${day.late ? `, di cui ${day.late} in ritardo` : ""}.` : "Nessuna chiamata in programma oggi.");
  }, [syncedAt, total, day.late, onSummary]);

  const counters = [
    { label: "Chiamate di oggi", value: total, note: `${day.done} già fatte`, to: "/calls" },
    { label: "In ritardo", value: day.late, note: day.late ? "Da fare per prime" : "Tutto in orario", to: "/pratiche", late: day.late > 0 },
    { label: "Lead nuove", value: day.newLeads, note: "Da contattare", to: "/pratiche" },
    { label: "Chat", value: day.chats, note: "Da rispondere", to: "/chat" },
    { label: "Email", value: day.emails, note: "Da leggere", to: "/email" }
  ];
  const next = day.next;

  return <>
    <div className="cd-sync" role="status">
      <span>{loading ? "Aggiornamento in corso…" : syncedAt ? `Aggiornato alle ${new Date(syncedAt).toLocaleTimeString("it-IT", { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit" })} · Le tue attività` : "Dati non disponibili"}</span>
      <button className="cd-link" onClick={() => void load()} disabled={loading}><RefreshCw size={13} aria-hidden="true" />Aggiorna</button>
    </div>
    {error && <div className="cd-error" role="alert">{syncedAt ? "Aggiornamento non riuscito: i dati mostrati sono dell’ultima sincronizzazione. " : "Caricamento non riuscito. "}{error}<button className="cd-link" onClick={() => void load()} disabled={loading}>Riprova</button></div>}

    <section className="cd-next" aria-label="Prossima chiamata">
      {next ? <>
        <div className="cd-next-copy">
          <span>Prossima chiamata · {dueLabel(next)}{next.late ? "" : `, ${next.state.toLowerCase()}`}</span>
          <strong>{next.name}</strong>
          <small>{next.what}</small>
        </div>
        <div className="cd-next-actions">
          {threeCx.dn && next.phone ? <button type="button" className="cd-next-call" disabled={threeCx.busy} onClick={() => void threeCx.dial(next.phone, { leadId: next.leadId, customerName: next.name })}>Chiama</button> : null}
          <Link className="cd-next-open" to={buildPracticeUrl(next.leadId)}>Apri pratica</Link>
        </div>
      </> : <div className="cd-next-copy"><span>Prossima chiamata</span><strong>Nessuna chiamata in programma</strong><small>Quando fissi un richiamo lo trovi qui.</small></div>}
    </section>

    <section className="cd-counters" aria-label="Il tuo lavoro di oggi">
      {counters.map((item) => <Link className="cd-counter" key={item.label} to={item.to}>
        <span>{item.label}</span>
        <strong className={item.late ? "is-late" : ""}>{syncedAt ? item.value : "—"}</strong>
        <small>{item.note}</small>
      </Link>)}
    </section>

    <div className="cd-columns">
      <section className="cd-panel" aria-labelledby="cd-agenda-title">
        <h2 id="cd-agenda-title">Agenda di oggi</h2>
        {day.agenda.slice(0, 8).map((item) => <Link className="cd-agenda-row" key={item.taskId} to={buildPracticeUrl(item.leadId)}>
          <strong className={item.late ? "is-late" : ""}>{item.time}</strong>
          <span className="cd-agenda-who"><b>{item.name}</b><small>{item.what}</small></span>
          <span className={`cd-agenda-state${item.late ? " is-late" : ""}`}>{item.state}</span>
        </Link>)}
        {!day.agenda.length && <p className="cd-empty">{syncedAt ? "Nessuna chiamata in agenda per oggi." : "Caricamento dell’agenda…"}</p>}
        {day.agenda.length > 8 && <p className="cd-more">Altre {day.agenda.length - 8} chiamate oggi</p>}
      </section>

      <section className="cd-panel" aria-labelledby="cd-waiting-title">
        <h2 id="cd-waiting-title">Clienti che aspettano una risposta</h2>
        {day.waiting.slice(0, 6).map((item) => <Link className="cd-waiting-row" key={item.key} to={item.href}>
          <span className="cd-agenda-who"><b>{item.name}</b><small>{item.text}</small></span>
          <time>{new Date(item.at).toLocaleTimeString("it-IT", { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit" })}</time>
        </Link>)}
        {!day.waiting.length && <p className="cd-empty">{syncedAt ? "Nessun cliente in attesa." : "Caricamento…"}</p>}
        {day.waiting.length > 6 && <p className="cd-more">Altri {day.waiting.length - 6} clienti in attesa</p>}
      </section>
    </div>
  </>;
}
