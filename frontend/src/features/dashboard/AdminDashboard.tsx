import { useEffect, useState } from "react";
import { ArrowRight, Clock3, FileText, FolderOpen, MessageCircle, Phone, RefreshCw, UsersRound, type LucideIcon } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import { useAutoRefresh } from "../../lib/use-auto-refresh";
import { buildChecks, PRESENCE_LABELS, type TeamDashboard, type TeamRow } from "./team-dashboard";

type Stat = { value: number; label: string; late?: boolean };

function areasOf(totals: TeamDashboard["totals"]): Array<{ title: string; icon: LucideIcon; to: string; stats: Stat[] }> {
  return [
    { title: "Lead", icon: UsersRound, to: "/tasks", stats: [{ value: totals.assigned, label: "Assegnati" }, { value: totals.toContact, label: "Da contattare" }, { value: totals.unassigned, label: "Senza operatore", late: totals.unassigned > 0 }] },
    { title: "Chiamate di oggi", icon: Phone, to: "/calls", stats: [{ value: totals.done + totals.todo, label: "Previste" }, { value: totals.done, label: "Fatte" }, { value: totals.todo, label: "Da fare" }] },
    { title: "Follow-up", icon: Clock3, to: "/pratiche", stats: [{ value: totals.follow, label: "In corso" }, { value: totals.followLate, label: "In ritardo", late: totals.followLate > 0 }] },
    { title: "Chat WhatsApp", icon: MessageCircle, to: "/chat", stats: [{ value: totals.chats, label: "Gestite oggi" }, { value: totals.waiting, label: "In attesa", late: totals.waiting > 0 }] },
    { title: "Preventivi", icon: FileText, to: "/pratiche", stats: [{ value: totals.quotes, label: "Inviati" }, { value: totals.quotes - totals.quotesOpen, label: "Con prossimo passo" }, { value: totals.quotesOpen, label: "Senza seguito", late: totals.quotesOpen > 0 }] },
    { title: "Pratiche", icon: FolderOpen, to: "/pratiche", stats: [{ value: totals.open, label: "Aperte" }, { value: totals.closed, label: "Chiuse" }] }
  ];
}

const Warn = ({ value }: { value: number }) => <td className={value ? "is-late" : ""}>{value}</td>;

function TeamRowView({ row }: { row: TeamRow }) {
  return <tr>
    <th scope="row">
      <span className="cd-operator">{row.name}<span className={`cd-flag is-${row.presence}`}>{PRESENCE_LABELS[row.presence]}</span></span>
    </th>
    <td className="cd-group">{row.assigned}</td><td>{row.toContact}</td>
    <td className="cd-group">{row.done + row.todo}</td><td>{row.done}</td><td>{row.todo}</td>
    <td className="cd-group">{row.follow}</td><Warn value={row.followLate} />
    <td className="cd-group">{row.chats}</td><Warn value={row.waiting} />
    <td className="cd-group">{row.quotes}</td><Warn value={row.quotesOpen} />
    <td className="cd-group">{row.open}</td><td>{row.closed}</td>
  </tr>;
}

export function AdminDashboard({ onSummary }: { onSummary(text: string): void }) {
  const [data, setData] = useState<TeamDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      setData(await api<TeamDashboard>("/api/dashboard/team"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Impossibile caricare la dashboard.");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, []);
  useAutoRefresh(load, !loading);

  const checks = data ? buildChecks(data.totals) : [];
  useEffect(() => {
    if (!data) return onSummary("Stiamo preparando la panoramica del team…");
    const { done, todo, waiting } = data.totals;
    onSummary(`${done} chiamate fatte su ${done + todo} · ${waiting} clienti in attesa di risposta · ${checks.length} punti da controllare`);
  }, [data, checks.length, onSummary]);

  return <>
    <div className="cd-sync" role="status">
      <span>{loading ? "Aggiornamento in corso…" : data ? `Aggiornato alle ${new Date(data.generatedAt).toLocaleTimeString("it-IT", { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit" })} · Vista team` : "Dati non disponibili"}</span>
      <button className="cd-link" onClick={() => void load()} disabled={loading}><RefreshCw size={13} aria-hidden="true" />Aggiorna</button>
    </div>
    {error && <div className="cd-error" role="alert">{data ? "Aggiornamento non riuscito: i dati mostrati sono dell’ultima sincronizzazione. " : "Caricamento non riuscito. "}{error}<button className="cd-link" onClick={() => void load()} disabled={loading}>Riprova</button></div>}

    {data ? <>
      <div className="cd-top">
        <section className="cd-top-main" aria-labelledby="cd-what-title">
          <h2 id="cd-what-title">Cosa sta succedendo</h2>
          <div className="cd-areas">
            {areasOf(data.totals).map(({ title, icon: Icon, to, stats }) => <Link className="cd-area" key={title} to={to}>
              <span className="cd-area-title"><Icon size={16} aria-hidden="true" />{title}</span>
              <span className="cd-area-stats">{stats.map((stat) => <span key={stat.label}>
                <strong className={stat.late ? "is-late" : ""}>{stat.value}</strong><small>{stat.label}</small>
              </span>)}</span>
            </Link>)}
          </div>
        </section>
        <section className="cd-top-side" aria-labelledby="cd-check-title">
          <h2 id="cd-check-title">Da controllare</h2>
          <div className="cd-checks">
            {checks.map((item) => <div className="cd-check" key={item.text}>
              <strong>{item.count}</strong><span>{item.text}</span>
              <Link className="cd-pill" to={item.to}>{item.action}<span aria-hidden="true"><ArrowRight size={14} /></span></Link>
            </div>)}
            {!checks.length && <p className="cd-empty">Tutto in ordine: niente da controllare.</p>}
          </div>
        </section>
      </div>

      <section className="cd-who" aria-labelledby="cd-who-title">
        <h2 id="cd-who-title">Chi sta lavorando</h2>
        <div className="cd-table-box">
          <table className="cd-team-table">
            <thead>
              <tr>
                <th scope="col" rowSpan={2}>Operatore</th>
                <th scope="colgroup" colSpan={2} className="cd-group">Lead</th>
                <th scope="colgroup" colSpan={3} className="cd-group">Chiamate di oggi</th>
                <th scope="colgroup" colSpan={2} className="cd-group">Follow-up</th>
                <th scope="colgroup" colSpan={2} className="cd-group">WhatsApp</th>
                <th scope="colgroup" colSpan={2} className="cd-group">Preventivi</th>
                <th scope="colgroup" colSpan={2} className="cd-group">Pratiche</th>
              </tr>
              <tr className="cd-table-sub">
                <th scope="col" className="cd-group">Assegnati</th><th scope="col">Da contattare</th>
                <th scope="col" className="cd-group">Previste</th><th scope="col">Fatte</th><th scope="col">Da fare</th>
                <th scope="col" className="cd-group">In corso</th><th scope="col">In ritardo</th>
                <th scope="col" className="cd-group">Gestite</th><th scope="col">In attesa</th>
                <th scope="col" className="cd-group">Inviati</th><th scope="col">Senza seguito</th>
                <th scope="col" className="cd-group">Aperte</th><th scope="col">Chiuse</th>
              </tr>
            </thead>
            <tbody>{data.operators.map((row) => <TeamRowView key={row.username} row={row} />)}</tbody>
          </table>
          {!data.operators.length && <p className="cd-empty">Nessun operatore registrato.</p>}
        </div>
      </section>
    </> : !error && <p className="cd-empty">Caricamento della panoramica del team…</p>}
  </>;
}
