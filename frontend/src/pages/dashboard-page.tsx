import { useEffect, useMemo, useState } from "react";
import { ArrowRight, CalendarDays, ChartNoAxesColumnIncreasing, ChevronRight, Clock3, FileText, Phone, RefreshCw, Search, UsersRound } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { getAuthUser } from "../lib/auth";
import { buildPracticeUrl, getPracticeFocusFromTask, getPracticeUrlOptionsFromTask } from "../features/practices/practice-links";
import type { Lead } from "../features/practices/pratiche.types";
import { getTaskBoardCache, isTaskBoardCacheFresh, setTaskBoardCache, type CrmTask as Task } from "../store/crm-store";
import "../styles/dashboard-page.css";

type Filter = "all" | "today" | "overdue" | "documents" | "payments";
const BOOKING_KINDS = new Set(["callback_reminder", "quote_preparation", "appointment_reminder", "callback_overdue", "next_action"]);
const key = (value?: string | null) => String(value || "").trim().toLocaleLowerCase("it");
const timestamp = (value?: string | null) => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
function sameDay(value?: string | null) {
  return Boolean(timestamp(value)) && new Date(value!).toDateString() === new Date().toDateString();
}
function lane(task: Task) {
  if (timestamp(task.dueAt) && timestamp(task.dueAt) < Date.now()) return "overdue";
  return sameDay(task.dueAt) ? "today" : "planned";
}
function formatDate(value?: string | null) {
  if (!timestamp(value)) return "Da pianificare";
  const date = new Date(value!);
  return `${sameDay(value) ? "Oggi" : date.toLocaleDateString("it-IT", { day: "numeric", month: "short" })} ${date.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}`;
}
function initials(value: string) {
  return value.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "—";
}

export function DashboardPage() {
  const navigate = useNavigate();
  const user = getAuthUser();
  const isAdmin = user?.role === "admin" || user?.role === "super_admin";
  const [leads, setLeads] = useState<Lead[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [days, setDays] = useState(14);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [syncedAt, setSyncedAt] = useState<number | null>(null);

  async function load(force = false) {
    const cached = getTaskBoardCache();
    setError("");
    if (cached) {
      setLeads(cached.data.leads);
      setTasks(cached.data.tasks);
      setSyncedAt(cached.loadedAt);
      if (!force && isTaskBoardCacheFresh()) { setLoading(false); return; }
    }
    setLoading(true);
    try {
      const data = await api<{ leads: Lead[]; tasks: Task[] }>("/api/tasks/board");
      const nextLeads = Array.isArray(data.leads) ? data.leads : [];
      const nextTasks = Array.isArray(data.tasks) ? data.tasks : [];
      setTaskBoardCache(nextTasks, nextLeads);
      setLeads(nextLeads);
      setTasks(nextTasks);
      setSyncedAt(Date.now());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Impossibile caricare la dashboard.");
    } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  const actorKeys = [user?.username, user?.name, user?.email].map(key).filter(Boolean);
  const owned = (assignedTo?: string) => isAdmin || actorKeys.includes(key(assignedTo));
  const visibleLeads = leads.filter((lead) => owned(lead.assignedTo));
  const visibleTasks = tasks.filter((task) => owned(task.assignedTo));
  const openTasks = visibleTasks.filter((task) => task.status === "open");
  const leadMap = new Map(visibleLeads.map((lead) => [lead.id, lead]));
  const overdue = openTasks.filter((task) => lane(task) === "overdue");
  const activeLeads = visibleLeads.filter((lead) => (lead.closingOutcome || "open") === "open");
  const won = visibleLeads.filter((lead) => lead.closingOutcome === "won").length;
  const conversion = visibleLeads.length ? Math.round(won / visibleLeads.length * 100) : 0;
  const followUps = openTasks.filter((task) => sameDay(task.dueAt) && BOOKING_KINDS.has(task.kind));
  const query = key(search);
  const focusQueue = openTasks.filter((task) => {
    const lead = task.leadId ? leadMap.get(task.leadId) : undefined;
    if (query && !key(`${task.title} ${task.description || ""} ${lead?.fullName || ""} ${lead?.phone || ""}`).includes(query)) return false;
    if (filter === "today") return sameDay(task.dueAt);
    if (filter === "overdue") return lane(task) === "overdue";
    if (filter === "documents") return /document/i.test(task.kind);
    if (filter === "payments") return /payment|saldo/i.test(task.kind);
    return true;
  }).sort((a, b) => {
    const order = { overdue: 0, today: 1, planned: 2 };
    return order[lane(a)] - order[lane(b)] || b.priority - a.priority || (timestamp(a.dueAt) || Infinity) - (timestamp(b.dueAt) || Infinity);
  });
  const recentActivity = [...visibleLeads].filter((lead) => timestamp(lead.updatedAt))
    .sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt)).slice(0, 5);
  const upcoming = [...openTasks].filter((task) => timestamp(task.dueAt) >= Date.now())
    .sort((a, b) => timestamp(a.dueAt) - timestamp(b.dueAt)).slice(0, 4);
  const team = Array.from(openTasks.reduce((map, task) => {
    const actor = key(task.assignedTo);
    const row = map.get(actor) || { name: task.assignedTo || "Non assegnati", count: 0, overdue: 0 };
    row.count++;
    if (lane(task) === "overdue") row.overdue++;
    map.set(actor, row);
    return map;
  }, new Map<string, { name: string; count: number; overdue: number }>()).values()).sort((a, b) => b.count - a.count);

  const trend = useMemo(() => {
    const scoped = leads.filter((lead) => isAdmin || [user?.username, user?.name, user?.email].map(key).filter(Boolean).includes(key(lead.assignedTo)));
    return Array.from({ length: days }, (_, index) => {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - days + index + 1);
      const end = new Date(start);
      end.setDate(end.getDate() + 1);
      return { date: start, count: scoped.filter((lead) => timestamp(lead.createdAt) >= start.getTime() && timestamp(lead.createdAt) < end.getTime()).length };
    });
  }, [leads, days, isAdmin, user?.username, user?.name, user?.email]);
  const trendMax = Math.max(2, ...trend.map((item) => item.count));
  const points = trend.map((item, index) => `${38 + index * 604 / (days - 1)},${162 - item.count / trendMax * 128}`).join(" ");
  const toContact = activeLeads.filter((lead) => lead.status === "Da contattare").length;
  function openTask(task: Task) {
    if (task.leadId) navigate(buildPracticeUrl(task.leadId, getPracticeFocusFromTask(task), getPracticeUrlOptionsFromTask(task)));
    else navigate(isAdmin ? "/tasks" : "/pratiche");
  }
  const value = (number: number | string) => syncedAt ? number : "—";
  const metricCards = [
    { label: "Lead da contattare", value: toContact, note: "In attesa del primo contatto", icon: UsersRound, tone: "blue", action: () => navigate("/pratiche") },
    { label: "Follow-up oggi", value: followUps.length, note: "Richiami e appuntamenti di oggi", icon: Phone, tone: "cyan", action: () => setFilter("today") },
    { label: "Pratiche aperte", value: activeLeads.length, note: "Opportunità ancora in lavorazione", icon: FileText, tone: "violet", action: () => navigate("/pratiche") },
    { label: "Conversione", value: `${conversion}%`, note: `${won} vendute su ${visibleLeads.length} lead visibili`, icon: ChartNoAxesColumnIncreasing, tone: "green", action: () => navigate("/analytics") }
  ];

  return (
    <div className="cruise-dashboard" aria-busy={loading}>
      <section className="cd-welcome">
        <img className="cd-welcome-image" src="/brand/cruise.jpg" alt="" />
        <div><span className="cd-eyebrow">LA TUA GIORNATA, A BORDO</span>
          <h1>{new Date().getHours() < 14 ? "Buongiorno" : "Buon pomeriggio"}, {isAdmin ? "Team Crocieriamo" : user?.name || "Crocieriamo"}!</h1>
          <p>Ogni nuovo lead è un viaggio da vivere insieme.</p>
        </div>
      </section>
      <div className="cd-sync" role="status"><span>{loading ? "Aggiornamento in corso…" : syncedAt ? `Aggiornato alle ${new Date(syncedAt).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })} · ${isAdmin ? "Vista team" : "Le tue attività"}` : "Dati non disponibili"}</span><button className="cd-link" onClick={() => void load(true)} disabled={loading}><RefreshCw size={13} />Aggiorna</button></div>
      {error && <div className="cd-error" role="alert">{syncedAt ? "Aggiornamento non riuscito: i dati mostrati sono dell’ultima sincronizzazione. " : "Caricamento non riuscito. "}{error}<button className="cd-link" onClick={() => void load(true)} disabled={loading}>Riprova</button></div>}
      <section className="cd-kpis" aria-label="Riepilogo operativo">
        {metricCards.map(({ label, value: metric, note, icon: Icon, tone, action }) => <button className={`cd-kpi ${tone}`} key={label} onClick={action}><span className="cd-icon"><Icon size={24} /></span><span className="cd-kpi-copy"><span>{label}</span><strong>{value(metric)}</strong><small>{syncedAt ? note : "In attesa dei dati"}</small></span></button>)}
      </section>
      <div className="cd-grid">
        <section className="cd-panel cd-priorities">
          <header className="cd-heading"><div><h2>Priorità di oggi</h2>{overdue.length > 0 && <span className="cd-badge overdue">{overdue.length} in ritardo</span>}</div><button className="cd-link" onClick={() => navigate(isAdmin ? "/tasks" : "/pratiche")}>Vedi tutte <ArrowRight size={14} /></button></header>
          <div className="cd-search"><Search size={16} /><input type="search" aria-label="Cerca nelle priorità" placeholder="Cerca cliente, pratica o task…" value={search} onChange={(event) => setSearch(event.target.value)} /></div>
          <div className="cd-filters" aria-label="Filtra priorità">{([["all", "Tutte"], ["today", "Oggi"], ["overdue", "In ritardo"], ["documents", "Documenti"], ["payments", "Pagamenti"]] as [Filter, string][]).map(([id, label]) => <button key={id} className={filter === id ? "selected" : ""} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>)}</div>
          <div className="cd-task-list">{focusQueue.slice(0, 4).map((task) => {
            const lead = task.leadId ? leadMap.get(task.leadId) : undefined;
            const state = lane(task);
            return <button className="cd-task" key={task.id} onClick={() => openTask(task)}><span className={`cd-priority-dot ${state}`} /><span className="cd-avatar">{lead ? initials(lead.fullName) : <Clock3 size={18} />}</span><span className="cd-task-copy"><strong>{task.title}{lead && !key(task.title).includes(key(lead.fullName)) ? `: ${lead.fullName}` : ""}</strong><small>{task.description || "Apri la pratica per gestire la prossima azione."}</small></span><span className="cd-task-end"><time>{formatDate(task.dueAt)}</time><span className={`cd-badge ${state}`}>{state === "overdue" ? "In ritardo" : state === "today" ? "Oggi" : "Pianificata"}</span></span><ChevronRight size={14} /></button>;
          })}{!focusQueue.length && <p className="cd-empty">{loading && !syncedAt ? "Caricamento delle priorità…" : !syncedAt ? "Le priorità saranno disponibili dopo il caricamento." : query || filter !== "all" ? "Nessuna attività corrisponde ai filtri selezionati." : "Tutto in ordine. Nessuna attività aperta da gestire."}</p>}</div>
          <footer className="cd-panel-footer"><span>{value(focusQueue.length)} attività{focusQueue.length > 4 ? " · mostrate le prime 4" : ""}</span><span>Ordinate per urgenza</span></footer>
        </section>
        <aside className="cd-panel cd-team"><header className="cd-heading"><h2>{isAdmin ? "Carico del team" : "Il tuo carico"}</h2><UsersRound size={17} /></header><p className="cd-caption">Attività aperte assegnate</p>{team.slice(0, 5).map((member) => <div className="cd-team-row" key={member.name}><span className="cd-avatar">{initials(member.name)}</span><div><strong>{member.name}</strong><small>{member.overdue ? `${member.overdue} in ritardo` : "Nessuna scadenza superata"}</small></div><span className="cd-team-count" aria-label={`${member.count} attività aperte`}>{member.count}</span></div>)}{!team.length && <p className="cd-empty">{syncedAt ? "Nessuna attività aperta assegnata." : "In attesa dei dati."}</p>}<button className="cd-link cd-bottom-link" onClick={() => navigate(isAdmin ? "/tasks" : "/pratiche")}>Gestisci attività <ArrowRight size={14} /></button></aside>
        <section className="cd-panel cd-trend"><header className="cd-heading"><h2>Andamento nuovi lead</h2><select aria-label="Periodo andamento lead" value={days} onChange={(event) => setDays(Number(event.target.value))}><option value={14}>Ultimi 14 giorni</option><option value={30}>Ultimi 30 giorni</option></select></header><div className="cd-chart-summary"><strong>{value(trend.reduce((sum, item) => sum + item.count, 0))}</strong><span>lead ricevuti nel periodo</span><span className="cd-chart-legend"><i />Nuovi lead</span></div>
          {syncedAt ? <svg className="cd-chart" viewBox="0 0 660 200" role="img" aria-label={`Nuovi lead negli ultimi ${days} giorni: ${trend.map((item) => `${item.date.toLocaleDateString("it-IT")}: ${item.count}`).join(", ")}`}><defs><linearGradient id="cd-chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#31bade" stopOpacity=".24" /><stop offset="100%" stopColor="#31bade" stopOpacity=".02" /></linearGradient></defs>{[0, 0.5, 1].map((ratio) => <g key={ratio}><line x1="38" x2="642" y1={162 - ratio * 128} y2={162 - ratio * 128} stroke="#e5edf5" /><text x="25" y={166 - ratio * 128} textAnchor="end">{Math.round(trendMax * ratio)}</text></g>)}<polygon points={`38,162 ${points} 642,162`} fill="url(#cd-chart-fill)" /><polyline points={points} fill="none" stroke="#1674bd" strokeWidth="2.5" strokeLinejoin="round" />{trend.map((item, index) => <g key={index}><circle cx={38 + index * 604 / (days - 1)} cy={162 - item.count / trendMax * 128} r="3" fill="#08b9d9" stroke="white"><title>{item.date.toLocaleDateString("it-IT")}: {item.count} lead</title></circle>{(index === 0 || index === days - 1 || index === Math.floor(days / 2)) && <text x={38 + index * 604 / (days - 1)} y="190" textAnchor={index === 0 ? "start" : index === days - 1 ? "end" : "middle"}>{item.date.toLocaleDateString("it-IT", { day: "numeric", month: "short" })}</text>}</g>)}</svg> : <p className="cd-empty">Il grafico sarà disponibile al caricamento dei dati.</p>}
        </section>
        <section className="cd-panel cd-upcoming"><header className="cd-heading"><h2>Prossime attività</h2><CalendarDays size={17} /></header>{upcoming.map((task) => <button className="cd-agenda-row" key={task.id} onClick={() => openTask(task)}><span className="cd-calendar"><strong>{new Date(task.dueAt!).getDate()}</strong><small>{new Date(task.dueAt!).toLocaleDateString("it-IT", { month: "short" })}</small></span><span><strong>{task.title}</strong><small>{task.leadId ? leadMap.get(task.leadId)?.fullName : task.assignedTo}<span> · {new Date(task.dueAt!).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}</span></small></span><ChevronRight size={14} /></button>)}{!upcoming.length && <p className="cd-empty">{syncedAt ? "Nessuna attività futura pianificata. Imposta la prossima azione nelle pratiche." : "In attesa dei dati."}</p>}</section>
        <aside className="cd-panel cd-activity"><header className="cd-heading"><h2>Attività recente</h2></header><p className="cd-caption">Ultimi aggiornamenti delle pratiche</p>{recentActivity.map((lead) => <button className="cd-activity-row" key={lead.id} onClick={() => navigate(buildPracticeUrl(lead.id))}><span className="cd-icon blue"><FileText size={16} /></span><span><strong>{lead.fullName}</strong><small>{lead.status}</small><time>{formatDate(lead.updatedAt)}</time></span><ChevronRight size={13} /></button>)}{!recentActivity.length && <p className="cd-empty">{syncedAt ? "Nessun aggiornamento disponibile." : "In attesa dei dati."}</p>}</aside>
      </div>
    </div>
  );
}
