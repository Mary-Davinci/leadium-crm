import { useEffect, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import { getAuthUser } from "../lib/auth";
import { api } from "../lib/api";
import {
  CrmTask,
  CrmUser,
  getTaskBoardCache,
  getUsersCache,
  isTaskBoardCacheFresh,
  isUsersCacheFresh,
  setTaskBoardCache,
  setUsersCache
} from "../store/crm-store";
import "../styles/leadboard-page.css";

type Lead = {
  id: string;
  fullName: string;
  phone: string;
  email?: string;
  source?: string;
  assignedTo?: string;
  status: string;
};

type TaskBoardPayload = {
  tasks: CrmTask[];
  leads: Lead[];
};

type LoadTone = "green" | "orange" | "red";

type OperatorSnapshot = {
  key: string;
  displayName: string;
  username: string;
  role: CrmUser["role"] | "operatore";
  openTasks: CrmTask[];
  overdueTasks: CrmTask[];
  todayTasks: CrmTask[];
  completedToday: CrmTask[];
  lastActivityAt: string | null;
  lastActivityLabel: string;
  isOnline: boolean;
  tone: LoadTone;
  loadPercent: number;
};

function normalizeTask(input: CrmTask): CrmTask {
  return {
    ...input,
    id: String(input?.id || ""),
    leadId: input?.leadId ? String(input.leadId) : undefined,
    assignedTo: String(input?.assignedTo || ""),
    kind: String(input?.kind || "task"),
    title: String(input?.title || "Task senza titolo"),
    description: String(input?.description || ""),
    source: String(input?.source || ""),
    status: input?.status === "done" || input?.status === "dismissed" ? input.status : "open",
    priority: Number(input?.priority || 50),
    dueAt: input?.dueAt ? String(input.dueAt) : null,
    createdAt: String(input?.createdAt || new Date().toISOString()),
    updatedAt: String(input?.updatedAt || new Date().toISOString()),
    meta: input?.meta || null
  };
}

function normalizeLead(input: Lead): Lead {
  return {
    ...input,
    id: String(input?.id || ""),
    fullName: String(input?.fullName || "Cliente senza nome"),
    phone: String(input?.phone || ""),
    email: String(input?.email || ""),
    source: String(input?.source || ""),
    assignedTo: String(input?.assignedTo || ""),
    status: String(input?.status || "")
  };
}

function normalizeKey(value?: string) {
  return String(value || "").trim().toLocaleLowerCase("it");
}

function formatDateTime(value?: string | null) {
  if (!value) return "Nessuna attività";
  return new Date(value).toLocaleString("it-IT", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function isToday(value?: string | null) {
  if (!value) return false;
  const date = new Date(value);
  const now = new Date();
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
}

function isOverdue(task: CrmTask) {
  return task.status === "open" && Boolean(task.dueAt) && new Date(task.dueAt as string).getTime() < Date.now();
}

function isDueToday(task: CrmTask) {
  return task.status === "open" && isToday(task.dueAt);
}

function getLoadTone(openCount: number): LoadTone {
  if (openCount > 15) return "red";
  if (openCount > 10) return "orange";
  return "green";
}

function getLoadLabel(tone: LoadTone) {
  if (tone === "red") return "Saturo";
  if (tone === "orange") return "Sopra soglia";
  return "Gestibile";
}

function getLastActivityLabel(task?: CrmTask) {
  if (!task) return "Nessuna attività recente";
  const status = task.status === "done" ? "Completata" : task.status === "dismissed" ? "Annullata" : "Aggiornata";
  return `${status}: ${task.title}`;
}

function getOperatorDisplay(user: CrmUser) {
  return user.name?.trim() || user.username;
}

function dedupeTasks(tasks: CrmTask[]) {
  const byId = new Map<string, CrmTask>();
  tasks.forEach((task) => {
    if (task.id) byId.set(task.id, task);
  });
  return Array.from(byId.values());
}

export function LeadBoardPage() {
  const authUser = getAuthUser();
  const [tasks, setTasks] = useState<CrmTask[]>(() => getTaskBoardCache()?.data.tasks.map(normalizeTask) || []);
  const [users, setUsers] = useState<CrmUser[]>(() => getUsersCache()?.data || []);
  const [selectedOperator, setSelectedOperator] = useState<string>("all");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const canView = authUser?.role === "admin" || authUser?.role === "super_admin";

  useEffect(() => {
    if (!canView) return;

    let canceled = false;
    async function loadData() {
      const cachedBoard = getTaskBoardCache();
      const cachedUsers = getUsersCache();

      if (cachedBoard?.data) {
        setTasks(dedupeTasks(cachedBoard.data.tasks.map(normalizeTask)));
      }
      if (cachedUsers?.data) setUsers(cachedUsers.data);

      if (isTaskBoardCacheFresh() && isUsersCacheFresh()) return;

      setLoading(!cachedBoard?.data);
      setError("");
      try {
        const [boardData, usersData] = await Promise.all([
          isTaskBoardCacheFresh() && cachedBoard?.data ? Promise.resolve(cachedBoard.data) : api<TaskBoardPayload>("/api/tasks/board"),
          isUsersCacheFresh() && cachedUsers?.data ? Promise.resolve(cachedUsers.data) : api<CrmUser[]>("/api/users")
        ]);
        if (canceled) return;

        const nextTasks = dedupeTasks((Array.isArray(boardData.tasks) ? boardData.tasks : []).map(normalizeTask));
        const nextLeads = (Array.isArray(boardData.leads) ? boardData.leads : []).map(normalizeLead);
        const nextUsers = Array.isArray(usersData) ? usersData : [];

        setTaskBoardCache(nextTasks, nextLeads);
        setUsersCache(nextUsers);
        setTasks(nextTasks);
        setUsers(nextUsers);
      } catch (loadError) {
        if (!canceled) setError(loadError instanceof Error ? loadError.message : "Errore caricamento gestione operativa.");
      } finally {
        if (!canceled) setLoading(false);
      }
    }

    loadData().catch((loadError: Error) => setError(loadError.message));
    return () => {
      canceled = true;
    };
  }, [canView]);

  const openTasks = useMemo(() => tasks.filter((task) => task.status === "open"), [tasks]);
  const overdueTasks = useMemo(() => openTasks.filter(isOverdue), [openTasks]);
  const todayTasks = useMemo(() => openTasks.filter(isDueToday), [openTasks]);
  const completedToday = useMemo(() => tasks.filter((task) => task.status === "done" && isToday(task.updatedAt)), [tasks]);

  const operators = useMemo<OperatorSnapshot[]>(() => {
    const operatorUsers = users.filter((user) => user.role === "operatore");
    const byKey = new Map<string, OperatorSnapshot>();

    operatorUsers.forEach((user) => {
      const displayName = getOperatorDisplay(user);
      const key = normalizeKey(displayName || user.username);
      byKey.set(key, {
        key,
        displayName,
        username: user.username,
        role: user.role,
        openTasks: [],
        overdueTasks: [],
        todayTasks: [],
        completedToday: [],
        lastActivityAt: null,
        lastActivityLabel: "Nessuna attività recente",
        isOnline: false,
        tone: "green",
        loadPercent: 0
      });
    });

    tasks.forEach((task) => {
      const assignedKey = normalizeKey(task.assignedTo);
      if (!assignedKey) return;
      if (!byKey.has(assignedKey)) {
        byKey.set(assignedKey, {
          key: assignedKey,
          displayName: task.assignedTo || "Operatore non registrato",
          username: task.assignedTo || assignedKey,
          role: "operatore",
          openTasks: [],
          overdueTasks: [],
          todayTasks: [],
          completedToday: [],
          lastActivityAt: null,
          lastActivityLabel: "Nessuna attività recente",
          isOnline: false,
          tone: "green",
          loadPercent: 0
        });
      }
      const snapshot = byKey.get(assignedKey);
      if (!snapshot) return;

      if (task.status === "open") snapshot.openTasks.push(task);
      if (isOverdue(task)) snapshot.overdueTasks.push(task);
      if (isDueToday(task)) snapshot.todayTasks.push(task);
      if (task.status === "done" && isToday(task.updatedAt)) snapshot.completedToday.push(task);

      const currentTime = snapshot.lastActivityAt ? new Date(snapshot.lastActivityAt).getTime() : 0;
      const taskTime = new Date(task.updatedAt || task.createdAt).getTime();
      if (taskTime >= currentTime) {
        snapshot.lastActivityAt = task.updatedAt || task.createdAt;
        snapshot.lastActivityLabel = getLastActivityLabel(task);
      }
    });

    return Array.from(byKey.values())
      .map((operator) => {
        const tone = getLoadTone(operator.openTasks.length);
        const lastActivityTime = operator.lastActivityAt ? new Date(operator.lastActivityAt).getTime() : 0;
        return {
          ...operator,
          openTasks: operator.openTasks.sort(compareTasks),
          overdueTasks: operator.overdueTasks.sort(compareTasks),
          todayTasks: operator.todayTasks.sort(compareTasks),
          completedToday: operator.completedToday.sort(compareTasks),
          isOnline: Date.now() - lastActivityTime <= 45 * 60 * 1000,
          tone,
          loadPercent: Math.min(100, Math.round((operator.openTasks.length / 15) * 100))
        };
      })
      .sort((a, b) => b.openTasks.length - a.openTasks.length || a.displayName.localeCompare(b.displayName, "it"));
  }, [tasks, users]);

  const saturatedOperators = useMemo(() => operators.filter((operator) => operator.tone !== "green"), [operators]);
  const availableOperators = useMemo(() => operators.filter((operator) => operator.tone === "green"), [operators]);
  const latestActivities = useMemo(
    () => [...tasks].sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime()).slice(0, 8),
    [tasks]
  );

  const kpis = useMemo(
    () => [
      { label: "Task aperte", value: openTasks.length, meta: "carico operativo totale" },
      { label: "SLA scadute", value: overdueTasks.length, meta: "richiedono intervento" },
      { label: "In scadenza oggi", value: todayTasks.length, meta: "da presidiare" },
      { label: "Operatori saturi", value: saturatedOperators.length, meta: "oltre 10 task aperte" }
    ],
    [openTasks.length, overdueTasks.length, saturatedOperators.length, todayTasks.length]
  );

  if (!canView) return <Navigate to="/dashboard" replace />;

  return (
    <div className="ops-control">
      <section className="ops-hero">
        <div>
          <span className="ops-eyebrow">Sala di controllo</span>
          <h1>Gestione operativa</h1>
          <p>Presidio task, SLA e saturazione operatori per admin e super admin.</p>
        </div>
        <div className="ops-hero-actions">
          <select value={selectedOperator} onChange={(event) => setSelectedOperator(event.target.value)} aria-label="Filtra operatore">
            <option value="all">Tutti gli operatori</option>
            {operators.map((operator) => (
              <option key={operator.key} value={operator.key}>
                {operator.displayName}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => window.location.reload()}>
            Aggiorna
          </button>
        </div>
      </section>

      {error ? <div className="ops-alert">{error}</div> : null}
      {loading ? <div className="ops-alert neutral">Caricamento dati operativi...</div> : null}

      <section className="ops-kpi-grid" aria-label="Indicatori operativi">
        {kpis.map((item) => (
          <article key={item.label} className="ops-kpi">
            <span>{item.label}</span>
            <strong>{item.value}</strong>
            <small>{item.meta}</small>
          </article>
        ))}
      </section>

      <section className="ops-grid">
        <div className="ops-main">
          <section className="ops-panel">
            <div className="ops-panel-head">
              <div>
                <h2>Lista operatori</h2>
                <p>Verde fino a 10 task, arancione oltre 10, rosso oltre 15.</p>
              </div>
              <span>{operators.length} operatori</span>
            </div>

            <div className="ops-operator-list" role="table" aria-label="Stato operativo operatori">
              <div className="ops-operator-head" role="row">
                <span>Operatore</span>
                <span>Stato</span>
                <span>Carico</span>
                <span>SLA</span>
                <span>Oggi</span>
                <span>Chiuse</span>
                <span>Ultima attività</span>
              </div>
              {operators.map((operator) => (
                <button
                  key={operator.key}
                  type="button"
                  role="row"
                  className={`ops-operator-card ${operator.tone} ${selectedOperator === operator.key ? "active" : ""}`}
                  onClick={() => setSelectedOperator((current) => (current === operator.key ? "all" : operator.key))}
                >
                  <div className="ops-operator-person" role="cell">
                    <strong>{operator.displayName}</strong>
                    <small>{operator.username}</small>
                  </div>

                  <div className="ops-operator-status" role="cell">
                    <span className={`ops-presence ${operator.isOnline ? "online" : "offline"}`}>
                      {operator.isOnline ? "Online" : "Offline"}
                    </span>
                  </div>

                  <div className="ops-load-cell" role="cell">
                    <strong>{operator.openTasks.length}</strong>
                    <span className={`ops-load-label ${operator.tone}`}>{getLoadLabel(operator.tone)}</span>
                    <div className="ops-load-track" aria-hidden="true">
                      <span style={{ width: `${operator.loadPercent}%` }} />
                    </div>
                  </div>

                  <span className={`ops-count ${operator.overdueTasks.length ? "danger" : ""}`} role="cell">
                    {operator.overdueTasks.length}
                  </span>
                  <span className="ops-count" role="cell">
                    {operator.todayTasks.length}
                  </span>
                  <span className="ops-count" role="cell">
                    {operator.completedToday.length}
                  </span>

                  <div className="ops-last-activity" role="cell">
                    <strong>{operator.lastActivityLabel}</strong>
                  <small>Ultima attività: {formatDateTime(operator.lastActivityAt)}</small>
                  </div>
                </button>
              ))}
              {!operators.length ? <p className="ops-empty">Nessun operatore disponibile.</p> : null}
            </div>
          </section>

        </div>

        <aside className="ops-side">
          <section className="ops-panel">
            <div className="ops-panel-head compact">
              <h2>Quick management</h2>
              <span>Auto balancing</span>
            </div>
            <div className="ops-balance">
              <div className="ops-balance-column">
                <h3>Da alleggerire</h3>
                {saturatedOperators.slice(0, 5).map((operator) => (
                  <div key={operator.key} className={`ops-balance-item ${operator.tone}`}>
                    <strong>{operator.displayName}</strong>
                    <span>{operator.openTasks.length} task aperte</span>
                  </div>
                ))}
                {!saturatedOperators.length ? <p className="ops-empty">Nessun operatore sopra soglia.</p> : null}
              </div>
              <div className="ops-balance-column">
                <h3>Capienza disponibile</h3>
                {availableOperators.slice(0, 5).map((operator) => (
                  <div key={operator.key} className="ops-balance-item green">
                    <strong>{operator.displayName}</strong>
                    <span>{Math.max(0, 10 - operator.openTasks.length)} slot prima della soglia</span>
                  </div>
                ))}
                {!availableOperators.length ? <p className="ops-empty">Nessuna capienza verde disponibile.</p> : null}
              </div>
            </div>
          </section>

          <section className="ops-panel">
            <div className="ops-panel-head compact">
              <h2>Ultime attività</h2>
              <span>{latestActivities.length}</span>
            </div>
            <div className="ops-activity-list">
              {latestActivities.map((task) => (
                <article key={task.id}>
                  <span>{formatDateTime(task.updatedAt || task.createdAt)}</span>
                  <strong>{getLastActivityLabel(task)}</strong>
                  <small>{task.assignedTo || "Non assegnato"}</small>
                </article>
              ))}
              {!latestActivities.length ? <p className="ops-empty">Nessuna attività registrata.</p> : null}
            </div>
          </section>
        </aside>
      </section>
    </div>
  );
}

function compareTasks(a: CrmTask, b: CrmTask) {
  const overdueDiff = Number(isOverdue(b)) - Number(isOverdue(a));
  if (overdueDiff !== 0) return overdueDiff;
  if (b.priority !== a.priority) return b.priority - a.priority;
  const aDue = a.dueAt ? new Date(a.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
  const bDue = b.dueAt ? new Date(b.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
  if (aDue !== bDue) return aDue - bDue;
  return new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime();
}

export function LegacyLeadBoardRedirect() {
  return <Navigate to="/tasks" replace />;
}
