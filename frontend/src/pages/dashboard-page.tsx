import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { getAuthUser } from "../lib/auth";
import { buildPracticeUrl, getPracticeFocusFromTask, getPracticeUrlOptionsFromTask } from "../features/practices/practice-links";
import {
  getDashboardCache,
  getTaskBoardCache,
  isDashboardCacheFresh,
  isTaskBoardCacheFresh,
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

function includesAny(value: string, terms: string[]) {
  const normalized = String(value || "").toLowerCase();
  return terms.some((term) => normalized.includes(term));
}

function normalizeActorKey(value?: string | null) {
  return String(value || "").trim().toLocaleLowerCase("it");
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

function buildFocusQueueTitle(task: Task, lead?: Lead | null) {
  const title = String(task.title || "").trim();
  const fullName = String(lead?.fullName || "").trim();
  if (!fullName) return title || "Task operativo";
  if (title.toLowerCase().includes(fullName.toLowerCase())) return title;
  return `${title} ${fullName}`;
}

function isTodayDate(value?: string | null) {
  if (!value) return false;
  const date = new Date(value);
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

function taskMatches(task: Task, terms: string[]) {
  return includesAny(`${task.kind} ${task.title} ${task.description || ""}`, terms);
}

export function DashboardPage() {
  const navigate = useNavigate();
  const authUser = getAuthUser();
  const isAdminView = authUser?.role === "admin" || authUser?.role === "super_admin";
  const [recent, setRecent] = useState<Lead[]>([]);
  const [inbox, setInbox] = useState<InboxPayload | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [search, setSearch] = useState("");
  const [quickFilter, setQuickFilter] = useState<QuickFilter>("all");
  const [syncing, setSyncing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [opsPulse, setOpsPulse] = useState(false);
  const [opsSnapshot, setOpsSnapshot] = useState("");

  async function load() {
    const dashboardCache = getDashboardCache();
    const boardCache = getTaskBoardCache();
    const snapshotLoadedAt = Math.max(dashboardCache?.loadedAt || 0, boardCache?.loadedAt || 0);

    if (dashboardCache?.data) {
      setInbox(dashboardCache.data.inbox);
    }
    if (boardCache?.data) {
      setRecent(boardCache.data.leads);
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
    const kpiData = {
      open: boardTasks.filter((task) => task.status === "open").length,
      today: boardTasks.filter((task) => task.status === "open" && getTaskLane(task) === "today").length,
      overdue: boardTasks.filter((task) => task.status === "open" && getTaskLane(task) === "overdue").length,
      done: boardTasks.filter((task) => task.status === "done").length
    };

    setDashboardCache(kpiData, inboxData);
    setTaskBoardCache(boardTasks, Array.isArray(boardData?.leads) ? boardData.leads : []);
    setInbox(inboxData);
    setRecent(Array.isArray(boardData?.leads) ? boardData.leads : []);
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

  const actorKeys = useMemo(
    () =>
      Array.from(
        new Set(
          [authUser?.username, authUser?.name, authUser?.email]
            .map((value) => normalizeActorKey(value))
            .filter(Boolean)
        )
      ),
    [authUser?.email, authUser?.name, authUser?.username]
  );

  const isOwnedByCurrentUser = useMemo(
    () => (assignedTo?: string | null) => {
      const assignedKey = normalizeActorKey(assignedTo);
      return Boolean(assignedKey) && actorKeys.includes(assignedKey);
    },
    [actorKeys]
  );

  const visibleTasks = useMemo(
    () => (isAdminView ? tasks : tasks.filter((task) => isOwnedByCurrentUser(task.assignedTo))),
    [isAdminView, isOwnedByCurrentUser, tasks]
  );
  const visibleLeads = useMemo(
    () => (isAdminView ? recent : recent.filter((lead) => isOwnedByCurrentUser(lead.assignedTo))),
    [isAdminView, isOwnedByCurrentUser, recent]
  );
  const openTasks = useMemo(() => tasks.filter((task) => task.status === "open"), [tasks]);
  const visibleOpenTasks = useMemo(() => visibleTasks.filter((task) => task.status === "open"), [visibleTasks]);
  const visibleTodayTasks = useMemo(() => visibleOpenTasks.filter((task) => getTaskLane(task) === "today"), [visibleOpenTasks]);
  const paymentTasks = useMemo(() => openTasks.filter((task) => includesAny(task.kind, ["payment", "saldo"])), [openTasks]);
  const leadMap = useMemo(() => new Map(visibleLeads.map((lead) => [lead.id, lead])), [visibleLeads]);

  const searchTerm = search.trim().toLowerCase();

  const focusQueue = useMemo(
    () =>
      [...visibleOpenTasks]
        .filter((task) => {
          const lead = task.leadId ? leadMap.get(task.leadId) : undefined;
          const stack = `${task.title} ${task.description || ""} ${lead?.fullName || ""} ${lead?.phone || ""}`.toLowerCase();
          if (searchTerm && !stack.includes(searchTerm)) return false;
          if (quickFilter === "today") return getTaskLane(task) === "today";
          if (quickFilter === "documents") return includesAny(task.kind, ["document"]);
          if (quickFilter === "payments") return includesAny(task.kind, ["payment", "saldo"]);
          return true;
        })
        .sort(compareTasks)
        .slice(0, 4)
        .map((task) => {
          const lead = task.leadId ? leadMap.get(task.leadId) : undefined;
          const lane = getTaskLane(task);
          const priorityClass = task.priority >= 80 ? "high" : task.priority >= 50 ? "medium" : "low";
          return {
            task,
            lead,
            lane,
            priorityClass,
            title: buildFocusQueueTitle(task, lead),
            subtitle: task.description || getTaskKindLabel(task.kind)
          };
        }),
    [visibleOpenTasks, leadMap, quickFilter, searchTerm]
  );

  const operationalMetrics = useMemo(() => {
    const todayCompleted = tasks.filter((task) => task.status === "done" && isTodayDate(task.updatedAt));
    const visibleCompletedToday = visibleTasks.filter((task) => task.status === "done" && isTodayDate(task.updatedAt));
    const completedCalls = todayCompleted.filter((task) => taskMatches(task, ["call", "richiamo", "chiamata"]));
    const completedChats = todayCompleted.filter((task) => taskMatches(task, ["chat", "message", "messaggio", "whatsapp"]));
    const completedPayments = todayCompleted.filter((task) => taskMatches(task, ["payment", "saldo", "pagamento"]));
    const operatorCalls = visibleCompletedToday.filter((task) => taskMatches(task, ["call", "richiamo", "chiamata"])).length;
    const operatorChats = visibleCompletedToday.filter((task) => taskMatches(task, ["chat", "message", "messaggio", "whatsapp"])).length;
    const operatorDoneRateBase = visibleCompletedToday.length + visibleTodayTasks.length;
    const operatorDoneRate = operatorDoneRateBase ? Math.round((visibleCompletedToday.length / operatorDoneRateBase) * 100) : 0;
    const activeTeam = new Set(todayCompleted.map((task) => String(task.assignedTo || "").trim()).filter(Boolean)).size;
    const flowToday = completedCalls.length + completedChats.length + todayCompleted.length;
    const loadOpen = openTasks.length;

    if (!isAdminView) {
      return {
        title: "Stato operativo",
        subtitle: "Live oggi",
        items: [
          { key: "calls", label: "Chiamate effettuate", value: String(operatorCalls), meta: "oggi" },
          { key: "chats", label: "Chat gestite", value: String(operatorChats), meta: "oggi" },
          { key: "done", label: "Task completate", value: `${operatorDoneRate}%`, meta: `${visibleCompletedToday.length} chiuse` }
        ]
      };
    }

    return {
      title: "Stato operativo",
      subtitle: "Vista team live",
      items: [
        { key: "team", label: "Team attivo", value: String(activeTeam), meta: "operatori oggi" },
        { key: "flow", label: "Flusso live", value: String(flowToday), meta: `${completedCalls.length} chiamate · ${completedChats.length} chat` },
        { key: "money", label: "Denaro seguito", value: String(completedPayments.length + paymentTasks.length), meta: "pagamenti oggi + aperti" },
        { key: "load", label: "Carico operativo", value: String(loadOpen), meta: `${todayCompleted.length} task chiuse oggi` }
      ]
    };
  }, [isAdminView, openTasks, paymentTasks.length, tasks, visibleTasks, visibleTodayTasks]);

  useEffect(() => {
    const nextSnapshot = JSON.stringify(operationalMetrics.items.map((item) => item.value));
    if (!opsSnapshot) {
      setOpsSnapshot(nextSnapshot);
      return;
    }
    if (nextSnapshot !== opsSnapshot) {
      setOpsSnapshot(nextSnapshot);
      setOpsPulse(true);
      const timer = window.setTimeout(() => setOpsPulse(false), 900);
      return () => window.clearTimeout(timer);
    }
  }, [operationalMetrics.items, opsSnapshot]);

  function openLeadBoard(lane?: "overdue" | "today" | "planned" | "done") {
    navigate(lane ? `/tasks?lane=${lane}` : "/tasks");
  }

  function openPracticeFromTask(task?: Task | null) {
    if (!task?.leadId) return;
    navigate(buildPracticeUrl(task.leadId, getPracticeFocusFromTask(task), getPracticeUrlOptionsFromTask(task)));
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
          
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Cerca pratiche, task o cliente..."
              aria-label="Ricerca globale"
            />
          </div>
          <small className={`dash-op-sync ${syncing ? "syncing" : ""}`}>{syncLabel}</small>
        </div>
              </section>

    
      <div className="dash-op-top-grid">
        <section className="panel dash-op-focus-queue">
          <header className="dash-op-head">
            <h3>Da fare adesso</h3>
          </header>
          <p className="dash-op-section-note">Leadium ordina per te le priorita immediate. Parti da qui e non perdere tempo a decidere.</p>
          <div className="dash-op-focus-queue-list">
            {focusQueue.map(({ task, lane, priorityClass, title, subtitle }) => (
              <article
                key={task.id}
                className={`dash-op-focus-queue-item priority-${priorityClass}`}
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
                <div className="dash-op-focus-queue-main">
                  <span className={`dash-op-focus-dot ${priorityClass}`} />
                  <div className="dash-op-focus-copy">
                    <strong>{title}</strong>
                    <small>{subtitle}</small>
                  </div>
                </div>
                <div className={`dash-op-focus-pill ${lane}`}>{lane === "overdue" ? "Ora" : lane === "today" ? "Oggi" : "Dopo"}</div>
              </article>
            ))}
            {!focusQueue.length ? <p className="dash-op-empty">Nessun task operativo in coda al momento.</p> : null}
          </div>
        </section>

        <aside className={`panel dash-op-ops-panel ${opsPulse ? "pulse" : ""}`}>
          <header className="dash-op-head dash-op-ops-head">
            <div>
              <h3>{operationalMetrics.title}</h3>
              <p className="dash-op-ops-subtitle">{operationalMetrics.subtitle}</p>
            </div>
            <span className="dash-op-live-badge">live</span>
          </header>
          <div className={`dash-op-ops-grid ${isAdminView ? "admin" : "operator"}`}>
            {operationalMetrics.items.map((item) => (
              <article key={item.key} className="dash-op-ops-card">
                <span>{item.label}</span>
                <strong>{item.value}</strong>
                <small>{item.meta}</small>
              </article>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}
