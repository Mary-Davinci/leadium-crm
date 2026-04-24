import { KeyboardEvent, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { buildPracticeUrl, getPracticeFocusFromTask, getPracticeUrlOptionsFromTask } from "../features/practices/practice-links";
import {
  getDashboardCache,
  getTaskBoardCache,
  invalidateDashboardCache,
  invalidateTaskBoardCache,
  isDashboardCacheFresh,
  isTaskBoardCacheFresh,
  patchDashboardTaskItemStatus,
  patchTaskStatusInBoard,
  setDashboardCache,
  setTaskBoardCache
} from "../store/crm-store";
import "../styles/dashboard-page.css";

function IconCallback() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 4a8 8 0 1 0 7.4 11H17v-2h6v6h-2v-2.2A10 10 0 1 1 12 2v2z" fill="currentColor" />
    </svg>
  );
}

function IconChat() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm2 5h12v2H6V9zm0-3h12v2H6V6zm0 6h8v2H6v-2z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconDocument() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M6 2h8l4 4v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm7 1.5V7h3.5L13 3.5zM8 10h8v2H8v-2zm0 4h8v2H8v-2zm0 4h6v2H8v-2z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconPayment() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm0 3v2h16V8H4zm5 5h2v4h2v-4h2l-3-3-3 3z"
        fill="currentColor"
      />
    </svg>
  );
}

type Kpi = {
  open: number;
  today: number;
  overdue: number;
  done: number;
};

type Lead = {
  id: string;
  fullName: string;
  phone: string;
  status: string;
  updatedAt?: string;
};

type InboxItem = {
  kind: "lead" | "chat" | "task";
  id: string;
  taskId?: string;
  title: string;
  subtitle: string;
  source: string;
  priority: number;
  status?: "open" | "done" | "dismissed";
  badges?: { overdue?: boolean };
  dueAt?: string | null;
};

type InboxPayload = {
  items: InboxItem[];
  kpis: {
    unreadChats: number;
  };
};

type Task = {
  id: string;
  leadId?: string;
  assignedTo?: string;
  kind: string;
  title: string;
  description?: string;
  source?: string;
  status: "open" | "done" | "dismissed";
  priority: number;
  dueAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

type TaskBoardPayload = {
  tasks: Task[];
  leads: Lead[];
};

type QuickFilter = "all" | "today" | "documents" | "payments";

type PracticePreview = Lead & {
  primaryTask: Task;
  lane: "overdue" | "today" | "planned" | "done";
  laneLabel: string;
  kindLabel: string;
  actionLabel: string;
  nextActionAt: string;
  statusClass: "new" | "ok" | "warn" | "success" | "neutral";
  priorityClass: "high" | "medium" | "low";
  priorityReason: string;
};

function includesAny(value: string, terms: string[]) {
  const normalized = String(value || "").toLowerCase();
  return terms.some((term) => normalized.includes(term));
}

function getTaskLane(task: Task): "overdue" | "today" | "planned" | "done" {
  if (task.status === "done") return "done";
  const now = new Date();
  if (!task.dueAt) return "planned";
  const due = new Date(task.dueAt);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate()).getTime();
  if (due.getTime() < now.getTime()) return "overdue";
  if (dueDay === todayStart) return "today";
  return "planned";
}

function compareTasks(a: Task, b: Task) {
  const laneOrder = { overdue: 0, today: 1, planned: 2, done: 3 };
  const laneDiff = laneOrder[getTaskLane(a)] - laneOrder[getTaskLane(b)];
  if (laneDiff !== 0) return laneDiff;
  if (b.priority !== a.priority) return b.priority - a.priority;
  const aTs = a.dueAt ? new Date(a.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
  const bTs = b.dueAt ? new Date(b.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
  return aTs - bTs;
}

function getTaskKindLabel(kind: string) {
  const value = String(kind || "").toLowerCase();
  if (value.includes("payment") || value.includes("saldo")) return "Sollecito pagamento";
  if (value.includes("document")) return "Documenti";
  if (value.includes("call") || value.includes("richiamo")) return "Richiamo cliente";
  if (value.includes("follow")) return "Follow-up commerciale";
  if (value.includes("next_action")) return "Prossimo task operativo";
  if (value.includes("manual")) return "Task manuale";
  return "Task operativo";
}

function getLaneLabel(lane: ReturnType<typeof getTaskLane>) {
  if (lane === "overdue") return "Scaduto";
  if (lane === "today") return "Oggi";
  if (lane === "done") return "Completato";
  return "Pianificato";
}

export function DashboardPage() {
  const navigate = useNavigate();
  const [kpi, setKpi] = useState<Kpi | null>(null);
  const [recent, setRecent] = useState<Lead[]>([]);
  const [inbox, setInbox] = useState<InboxPayload | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [search, setSearch] = useState("");
  const [quickFilter, setQuickFilter] = useState<QuickFilter>("all");
  const [syncing, setSyncing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);

  async function load() {
    const dashboardCache = getDashboardCache();
    const boardCache = getTaskBoardCache();
    const snapshotLoadedAt = Math.max(dashboardCache?.loadedAt || 0, boardCache?.loadedAt || 0);

    if (dashboardCache?.data) {
      setKpi(dashboardCache.data.kpi);
      setInbox(dashboardCache.data.inbox);
    }
    if (boardCache?.data) {
      setRecent(boardCache.data.leads.slice(0, 12));
      setTasks(boardCache.data.tasks);
    }
    if (snapshotLoadedAt) {
      setLastSyncedAt(snapshotLoadedAt);
    }

    if (isDashboardCacheFresh() && isTaskBoardCacheFresh()) {
      setSyncing(false);
      return;
    }

    setSyncing(Boolean(dashboardCache?.data || boardCache?.data));
    const [inboxData, boardData] = await Promise.all([
      api<InboxPayload>("/api/inbox"),
      api<TaskBoardPayload>("/api/tasks/board")
    ]);
    const boardTasks = Array.isArray(boardData?.tasks) ? boardData.tasks : [];
    const kpiData: Kpi = {
      open: boardTasks.filter((task) => task.status === "open").length,
      today: boardTasks.filter((task) => task.status === "open" && getTaskLane(task) === "today").length,
      overdue: boardTasks.filter((task) => task.status === "open" && getTaskLane(task) === "overdue").length,
      done: boardTasks.filter((task) => task.status === "done").length
    };

    setDashboardCache(kpiData, inboxData);
    setTaskBoardCache(boardTasks, Array.isArray(boardData?.leads) ? boardData.leads : []);
    setKpi(kpiData);
    setInbox(inboxData);
    setRecent((Array.isArray(boardData?.leads) ? boardData.leads : []).slice(0, 12));
    setTasks(boardTasks);
    setLastSyncedAt(Date.now());
    setSyncing(false);
  }

  useEffect(() => {
    load().catch((error: Error) => {
      setSyncing(false);
      alert(error.message);
    });
  }, []);

  async function completeTask(taskId?: string) {
    if (!taskId) return;
    const nextUpdatedAt = new Date().toISOString();
    const previousTasks = tasks;
    setTasks((prev) => prev.map((task) => (task.id === taskId ? { ...task, status: "done", updatedAt: nextUpdatedAt } : task)));
    patchTaskStatusInBoard(taskId, "done");
    patchDashboardTaskItemStatus(taskId, "done");
    setLastSyncedAt(Date.now());
    try {
      await api(`/api/tasks/${taskId}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "done" })
      });
      invalidateDashboardCache();
      invalidateTaskBoardCache();
      void load();
    } catch (error) {
      setTasks(previousTasks);
      invalidateDashboardCache();
      invalidateTaskBoardCache();
      void load();
      throw error;
    }
  }

  const openTasks = useMemo(() => tasks.filter((task) => task.status === "open"), [tasks]);
  const todayTasks = useMemo(() => openTasks.filter((task) => getTaskLane(task) === "today"), [openTasks]);
  const overdueTasks = useMemo(() => openTasks.filter((task) => getTaskLane(task) === "overdue"), [openTasks]);
  const documentTasks = useMemo(() => openTasks.filter((task) => includesAny(task.kind, ["document"])), [openTasks]);
  const paymentTasks = useMemo(() => openTasks.filter((task) => includesAny(task.kind, ["payment", "saldo"])), [openTasks]);
  const openUrgentTasks = useMemo(() => [...openTasks].sort(compareTasks).slice(0, 5), [openTasks]);
  const leadMap = useMemo(() => new Map(recent.map((lead) => [lead.id, lead])), [recent]);

  const searchTerm = search.trim().toLowerCase();
  const filteredTasks = useMemo(
    () =>
      openTasks.filter((task) => {
        const lead = task.leadId ? leadMap.get(task.leadId) : undefined;
        const stack = `${task.title} ${task.description || ""} ${lead?.fullName || ""} ${lead?.phone || ""}`.toLowerCase();
        if (searchTerm && !stack.includes(searchTerm)) return false;
        if (quickFilter === "today") return getTaskLane(task) === "today";
        if (quickFilter === "documents") return includesAny(task.kind, ["document"]);
        if (quickFilter === "payments") return includesAny(task.kind, ["payment", "saldo"]);
        return true;
      }),
    [openTasks, leadMap, quickFilter, searchTerm]
  );

  const practices = useMemo(() => {
    const grouped = new Map<string, Task[]>();
    filteredTasks.forEach((task) => {
      if (!task.leadId) return;
      const bucket = grouped.get(task.leadId) || [];
      bucket.push(task);
      grouped.set(task.leadId, bucket);
    });

    return Array.from(grouped.entries())
      .map(([leadId, taskItems]) => {
        const lead = leadMap.get(leadId);
        if (!lead) return null;
        const orderedTasks = [...taskItems].sort(compareTasks);
        const primaryTask = orderedTasks[0];
        const lane = getTaskLane(primaryTask);
        const priorityClass = primaryTask.priority >= 80 ? "high" : primaryTask.priority >= 50 ? "medium" : "low";
        return {
          ...lead,
          primaryTask,
          lane,
          laneLabel: getLaneLabel(lane),
          kindLabel: getTaskKindLabel(primaryTask.kind),
          actionLabel: primaryTask.title,
          nextActionAt: primaryTask.dueAt ? new Date(primaryTask.dueAt).toLocaleDateString("it-IT") : "Da pianificare",
          statusClass: lane === "overdue" ? "warn" : lane === "today" ? "ok" : "new",
          priorityClass,
          priorityReason: lane === "overdue" ? "Scaduto da recuperare" : lane === "today" ? "Da fare oggi" : "Pianificato"
        } as PracticePreview;
      })
      .filter(Boolean)
      .slice(0, 6) as PracticePreview[];
  }, [filteredTasks, leadMap]);

  const featuredTask = openUrgentTasks[0] || null;
  const featuredTaskLead = featuredTask?.leadId ? leadMap.get(featuredTask.leadId) || null : null;

  function openLeadBoard(lane?: "overdue" | "today" | "planned" | "done") {
    navigate(lane ? `/tasks?lane=${lane}` : "/tasks");
  }

  function openPracticeFromTask(task?: Task | null) {
    if (!task?.leadId) return;
    navigate(buildPracticeUrl(task.leadId, getPracticeFocusFromTask(task), getPracticeUrlOptionsFromTask(task)));
  }

  function openTaskView(view: "open" | "today" | "overdue" | "done") {
    if (view === "today") {
      navigate("/tasks?lane=today");
      return;
    }
    if (view === "overdue") {
      navigate("/tasks?lane=overdue");
      return;
    }
    if (view === "done") {
      navigate("/tasks?lane=done");
      return;
    }
    navigate("/tasks");
  }

  function handlePracticeKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openLeadBoard();
    }
  }

  const syncLabel = syncing
    ? "Sincronizzazione in background..."
    : lastSyncedAt
      ? `Dati aggiornati alle ${new Date(lastSyncedAt).toLocaleTimeString("it-IT", {
          hour: "2-digit",
          minute: "2-digit"
        })}`
      : "Dati non ancora sincronizzati";

  return (
    <div className="dash-op">
      <section className="panel dash-op-toolbar">
        <div className="dash-op-toolbar-left">
          <div className="dash-op-search">
            <span className="dash-op-search-icon">o</span>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Cerca..."
              aria-label="Ricerca globale"
            />
          </div>
          <small className={`dash-op-sync ${syncing ? "syncing" : ""}`}>{syncLabel}</small>
        </div>
        <div className="dash-op-toolbar-actions">
          <button type="button" className="dash-op-primary" onClick={() => openLeadBoard()}>
            + Nuovo Cliente
          </button>
          <button type="button" className="dash-op-more-btn" aria-label="Altre azioni">
            ...
          </button>
        </div>
      </section>

      <section className="dash-op-quick-row">
        <button
          type="button"
          className={`panel dash-op-quick q-callbacks ${quickFilter === "today" ? "active" : ""}`}
          onClick={() => setQuickFilter("today")}
        >
          <span className="dash-op-quick-icon">
            <IconCallback />
          </span>
          <div className="dash-op-quick-copy">
            <strong>{todayTasks.length} task di oggi</strong>
            <small>Include richiami, follow-up e task operativi</small>
          </div>
        </button>

        <button type="button" className="panel dash-op-quick q-chat" onClick={() => navigate("/chat")}>
          <span className="dash-op-quick-icon">
            <IconChat />
          </span>
          <div className="dash-op-quick-copy">
            <strong>{inbox?.kpis.unreadChats ?? 0} chat da rispondere</strong>
            <small>Apri inbox e smaltisci le non lette</small>
          </div>
        </button>

        <button
          type="button"
          className={`panel dash-op-quick q-docs ${quickFilter === "documents" ? "active" : ""}`}
          onClick={() => setQuickFilter("documents")}
        >
          <span className="dash-op-quick-icon">
            <IconDocument />
          </span>
          <div className="dash-op-quick-copy">
            <strong>{documentTasks.length} task documenti</strong>
            <small>Documenti da richiedere o verificare</small>
          </div>
        </button>

        <button
          type="button"
          className={`panel dash-op-quick q-payments ${quickFilter === "payments" ? "active" : ""}`}
          onClick={() => setQuickFilter("payments")}
        >
          <span className="dash-op-quick-icon">
            <IconPayment />
          </span>
          <div className="dash-op-quick-copy">
            <strong>{paymentTasks.length} pagamenti in scadenza</strong>
            <small>Task pagamento ancora aperti</small>
          </div>
        </button>
      </section>

      <div className="dash-op-grid">
        <section className="panel dash-op-practices">
          <header className="dash-op-head">
            <h3>Pratiche da gestire</h3>
            <button type="button" className="dash-op-link primary" onClick={() => setQuickFilter("all")}>
              Mostra tutte le pratiche
            </button>
          </header>
          <p className="dash-op-section-note">Mostra solo lead collegati ad almeno un task aperto.</p>

          <div className="dash-op-practice-list">
            {practices.map((lead) => (
              <article
                key={lead.id}
                className={`dash-op-practice-item priority-${lead.priorityClass}`}
                role="button"
                tabIndex={0}
                onKeyDown={handlePracticeKeyDown}
                onClick={() => openPracticeFromTask(lead.primaryTask)}
                aria-label={`Apri pratica di ${lead.fullName}`}
              >
                <div className="dash-op-practice-top">
                  <div className="dash-op-practice-main">
                    <h4>{lead.fullName}</h4>
                    <p>{lead.phone}</p>
                    <small>
                      Task: {lead.kindLabel} - scadenza {lead.nextActionAt}
                    </small>
                  </div>
                  <div className={`dash-op-practice-status ${lead.statusClass}`}>{lead.laneLabel}</div>
                </div>

                <div className="dash-op-practice-bottom">
                  <div className="dash-op-practice-action">
                    <span className={`priority-dot ${lead.priorityClass}`} />
                    <span>{lead.actionLabel}</span>
                    <small>{lead.priorityReason}</small>
                  </div>
                  <div className="dash-op-practice-buttons" onClick={(event) => event.stopPropagation()}>
                    <button type="button" onClick={() => openLeadBoard(lead.lane)}>
                      Apri task
                    </button>
                    <button type="button" className="secondary" onClick={() => openPracticeFromTask(lead.primaryTask)}>
                      Apri pratica
                    </button>
                    <button type="button" onClick={() => navigate("/calls")}>
                      Chiama
                    </button>
                    <button type="button" className="secondary" onClick={() => navigate("/chat")}>
                      Scrivi
                    </button>
                  </div>
                </div>
              </article>
            ))}
            {!practices.length ? <p className="dash-op-empty">Nessuna pratica collegata a task aperti con i filtri attuali.</p> : null}
          </div>

          <button type="button" className="dash-op-link subtle" onClick={() => openLeadBoard()}>
            Vai alla Task Board completa
          </button>
        </section>

        <aside className="dash-op-side">
          <section className="panel dash-op-tasks">
            <h3>Task urgenti</h3>
            <div className="dash-op-task-list">
              {openUrgentTasks.map((task) => (
                <article
                  key={task.id}
                  className={`dash-op-task-item ${getTaskLane(task) === "overdue" ? "overdue" : ""}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => openPracticeFromTask(task)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      openPracticeFromTask(task);
                    }
                  }}
                >
                  <div className="dash-op-task-top">
                    <strong>{task.title}</strong>
                    <span>P{task.priority}</span>
                  </div>
                  <p>{task.description || "Azione richiesta"}</p>
                  {task.dueAt ? <small className="dash-op-task-due">Scadenza: {new Date(task.dueAt).toLocaleString("it-IT")}</small> : null}
                  <div className="dash-op-task-actions" onClick={(event) => event.stopPropagation()}>
                    {getTaskLane(task) === "overdue" ? <em>Scaduto</em> : <small>{getTaskLane(task) === "today" ? "Oggi" : "In corso"}</small>}
                    {task.leadId ? (
                      <button type="button" className="secondary" onClick={() => openPracticeFromTask(task)}>
                        Apri pratica
                      </button>
                    ) : null}
                    <button type="button" onClick={() => completeTask(task.id)}>
                      Completa
                    </button>
                  </div>
                </article>
              ))}
              {!openUrgentTasks.length ? <p className="dash-op-empty">Nessun task urgente.</p> : null}
            </div>
          </section>

          <section className="panel dash-op-mini-kpis">
            <h3>Stato task</h3>
            <div className="dash-op-mini-grid">
              <button type="button" className="kpi-open" onClick={() => openTaskView("open")}>
                <strong>{kpi?.open ?? openTasks.length}</strong>
                <span>Task aperti</span>
              </button>
              <button type="button" className="kpi-quote" onClick={() => openTaskView("today")}>
                <strong>{kpi?.today ?? todayTasks.length}</strong>
                <span>Task oggi</span>
              </button>
              <button type="button" className="kpi-win" onClick={() => openTaskView("overdue")}>
                <strong>{kpi?.overdue ?? overdueTasks.length}</strong>
                <span>Task scaduti</span>
              </button>
              <button type="button" className="kpi-conv" onClick={() => openTaskView("done")}>
                <strong>{kpi?.done ?? tasks.filter((task) => task.status === "done").length}</strong>
                <span>Completati</span>
              </button>
            </div>
            <p className="dash-op-mini-foot">Dashboard operativa allineata ai task aperti.</p>
          </section>
        </aside>
      </div>

      <section className="panel dash-op-focus">
        <h3>Task piu urgente</h3>
        {featuredTask ? (
          <article className="dash-op-focus-card">
            <div className="dash-op-focus-main">
              <strong>{featuredTask.title}</strong>
              <p>{featuredTaskLead ? `${featuredTaskLead.fullName} - ${featuredTaskLead.phone}` : "Task non collegato a una pratica"}</p>
              <small>Tipo: {getTaskKindLabel(featuredTask.kind)}</small>
              <small>Scadenza: {featuredTask.dueAt ? new Date(featuredTask.dueAt).toLocaleString("it-IT") : "Da pianificare"}</small>
              <small>Urgenza: {getLaneLabel(getTaskLane(featuredTask))}</small>
            </div>
            <div className="dash-op-focus-actions">
              {featuredTask.leadId ? (
                <button type="button" className="primary" onClick={() => openPracticeFromTask(featuredTask)}>
                  Apri pratica
                </button>
              ) : (
                <button type="button" className="primary" onClick={() => openLeadBoard(getTaskLane(featuredTask))}>
                  Apri task
                </button>
              )}
              <button type="button" className="secondary" onClick={() => openLeadBoard(getTaskLane(featuredTask))}>
                Apri task
              </button>
              <button type="button" className="secondary" onClick={() => navigate("/calls")}>
                Chiama
              </button>
              <button type="button" className="secondary" onClick={() => navigate("/chat")}>
                Scrivi
              </button>
            </div>
          </article>
        ) : (
          <p className="dash-op-empty">Nessun task urgente al momento.</p>
        )}
      </section>
    </div>
  );
}
