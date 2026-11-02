import { useAutoRefresh } from "../lib/use-auto-refresh";
import { useClock } from "../lib/use-clock";
import { LeadActionDialog, type LeadAction } from "../features/practices/components/LeadActionDialog";
import { isWorkedLead } from "../features/practices/worked";
import { useEffect, useMemo, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { getAuthUser } from "../lib/auth";
import { api } from "../lib/api";
import {
  CrmTask,
  CrmUser,
  getTaskBoardCache,
  getUsersCache,
  isTaskBoardCacheFresh,
  isUsersCacheFresh,
  patchLeadAcrossStore,
  setTaskBoardCache,
  setUsersCache
} from "../store/crm-store";
import "../styles/leadboard-page.css";

type Lead = {
  workedAt?: string | null;
  archivedAt?: string | null;
  archivedBy?: string | null;
  archiveReason?: string | null;
  id: string;
  fullName: string;
  phone: string;
  email?: string;
  source?: string;
  assignedTo?: string;
  status: string;
  closingOutcome?: "open" | "won" | "lost" | "disqualified";
  createdAt?: string;
  updatedAt?: string;
};

type TaskBoardPayload = {
  tasks: CrmTask[];
  leads: Lead[];
};

type OperatorOption = {
  key: string;
  username: string;
  label: string;
  // Open TASKS (an assigned lead spawns several: SLA, next action, documents, payments)...
  openCount: number;
  overdueCount: number;
  // ...versus open PRACTICES owned, which is what "N lead assigned" means to an operator.
  leadCount: number;
};

type DataFilter = "all" | "complete" | "missing-phone" | "missing-email";
type SortMode = "newest" | "name" | "lightest-load";

function normalizeLead(input: Lead): Lead {
  return {
    ...input,
    id: String(input?.id || ""),
    fullName: String(input?.fullName || "Cliente senza nome"),
    phone: String(input?.phone || ""),
    email: String(input?.email || ""),
    source: String(input?.source || ""),
    assignedTo: String(input?.assignedTo || ""),
    status: String(input?.status || ""),
    createdAt: input?.createdAt ? String(input.createdAt) : "",
    updatedAt: input?.updatedAt ? String(input.updatedAt) : ""
  };
}

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

function normalizeKey(value?: string | null) {
  return String(value || "").trim().toLocaleLowerCase("it");
}

function dedupeTasks(tasks: CrmTask[]) {
  const byId = new Map<string, CrmTask>();
  tasks.forEach((task) => {
    if (task.id) byId.set(task.id, task);
  });
  return Array.from(byId.values());
}

function isOverdue(task: CrmTask) {
  return task.status === "open" && Boolean(task.dueAt) && new Date(task.dueAt as string).getTime() < Date.now();
}

function compareLeadsForAssignment(a: Lead, b: Lead) {
  const aImported = String(a.source || "").toLowerCase().startsWith("excel_");
  const bImported = String(b.source || "").toLowerCase().startsWith("excel_");
  if (Number(bImported) !== Number(aImported)) return Number(bImported) - Number(aImported);
  const aTs = new Date(a.createdAt || a.updatedAt || 0).getTime();
  const bTs = new Date(b.createdAt || b.updatedAt || 0).getTime();
  if (aTs !== bTs) return bTs - aTs;
  return a.fullName.localeCompare(b.fullName, "it");
}

function formatImportDate(value?: string) {
  if (!value) return "Data import non disponibile";
  return new Date(value).toLocaleString("it-IT", { timeZone: "Europe/Rome",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function getOperatorDisplay(user: CrmUser) {
  return user.name?.trim() || user.username;
}

function getLeadCompleteness(lead: Lead) {
  if (lead.phone && lead.email) return "complete";
  if (!lead.phone && !lead.email) return "missing-both";
  if (!lead.phone) return "missing-phone";
  return "missing-email";
}

export function LeadBoardPage() {
  const clockTick = useClock();
  const authUser = getAuthUser();
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<CrmTask[]>(() => getTaskBoardCache()?.data.tasks.map(normalizeTask) || []);
  const [leads, setLeads] = useState<Lead[]>(() => getTaskBoardCache()?.data.leads.map(normalizeLead) || []);
  const [users, setUsers] = useState<CrmUser[]>(() => getUsersCache()?.data || []);
  const [defaultOperatorUsername, setDefaultOperatorUsername] = useState("");
  const [assignmentDrafts, setAssignmentDrafts] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [dataFilter, setDataFilter] = useState<DataFilter>("all");
  const [sortMode, setSortMode] = useState<SortMode>("newest");
  const [batchAssigning, setBatchAssigning] = useState(false);
  const [selectedLeadIds, setSelectedLeadIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [view, setView] = useState("inbox");
  const [archivedLeads, setArchivedLeads] = useState<Lead[]>([]);
  const [leadAction, setLeadAction] = useState<{ lead: Lead; action: LeadAction } | null>(null);
  const [notice, setNotice] = useState("");
  const canView = authUser?.role === "admin" || authUser?.role === "super_admin";

  useEffect(() => {
    if (!canView) return;

    let canceled = false;
    async function loadData() {
      const cachedBoard = getTaskBoardCache();
      const cachedUsers = getUsersCache();

      if (cachedBoard?.data) {
        setTasks(dedupeTasks(cachedBoard.data.tasks.map(normalizeTask)));
        setLeads((cachedBoard.data.leads || []).map(normalizeLead));
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
        setLeads(nextLeads);
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

  async function refreshManagement() {
    const [board, archived] = await Promise.all([
      api<TaskBoardPayload>("/api/tasks/board"), api<Lead[]>("/api/leads?archived=only")
    ]);
    setTaskBoardCache(board.tasks, board.leads);
    setTasks(board.tasks.map(normalizeTask));
    setLeads(board.leads.map(normalizeLead));
    setArchivedLeads(archived.map(normalizeLead));
  }
  useEffect(() => {
    setSelectedLeadIds([]);
    if (!canView || view !== "archived") return;
    let cancelled = false;
    setLoading(true);
    api<Lead[]>("/api/leads?archived=only").then((rows) => { if (!cancelled) setArchivedLeads(rows.map(normalizeLead)); })
      .catch((e) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [view, canView]);

  useAutoRefresh(async () => {
    try { await refreshManagement(); } catch (e) { setError(e instanceof Error ? e.message : "Aggiornamento non riuscito."); }
  }, canView && !batchAssigning && !leadAction && !loading);

  const operatorUsers = useMemo(() => users.filter((user) => user.role === "operatore"), [users]);

  const operatorChoices = useMemo<OperatorOption[]>(() => {
    const openByAssignee = new Map<string, number>();
    const overdueByAssignee = new Map<string, number>();
    const leadsByAssignee = new Map<string, number>();

    leads.forEach((lead) => {
      const assignedKey = normalizeKey(lead.assignedTo);
      if (!assignedKey || isWorkedLead(lead)) return;
      leadsByAssignee.set(assignedKey, (leadsByAssignee.get(assignedKey) || 0) + 1);
    });

    tasks.forEach((task) => {
      if (task.status !== "open") return;
      const assignedKey = normalizeKey(task.assignedTo);
      if (!assignedKey) return;
      openByAssignee.set(assignedKey, (openByAssignee.get(assignedKey) || 0) + 1);
      if (isOverdue(task)) overdueByAssignee.set(assignedKey, (overdueByAssignee.get(assignedKey) || 0) + 1);
    });

    return operatorUsers
      .map((user) => {
        const usernameKey = normalizeKey(user.username);
        const displayName = getOperatorDisplay(user);
        const displayKey = normalizeKey(displayName);
        const openCount = (openByAssignee.get(usernameKey) || 0) + (displayKey && displayKey !== usernameKey ? openByAssignee.get(displayKey) || 0 : 0);
        const overdueCount =
          (overdueByAssignee.get(usernameKey) || 0) + (displayKey && displayKey !== usernameKey ? overdueByAssignee.get(displayKey) || 0 : 0);
        const leadCount =
          (leadsByAssignee.get(usernameKey) || 0) + (displayKey && displayKey !== usernameKey ? leadsByAssignee.get(displayKey) || 0 : 0);
        return {
          key: usernameKey,
          username: user.username,
          label: displayName,
          openCount,
          overdueCount,
          leadCount
        };
      })
      .sort((a, b) => a.openCount - b.openCount || a.label.localeCompare(b.label, "it"));
  }, [leads, operatorUsers, tasks, clockTick]);

  useEffect(() => {
    if (defaultOperatorUsername || !operatorChoices.length) return;
    setDefaultOperatorUsername(operatorChoices[0].username);
  }, [defaultOperatorUsername, operatorChoices]);

  const importedUnassignedLeads = useMemo(
    () =>
      [...leads]
        .filter((lead) => !normalizeKey(lead.assignedTo) && String(lead.source || "").toLowerCase().startsWith("excel_"))
        .sort(compareLeadsForAssignment),
    [leads]
  );

  const filteredLeads = useMemo(() => {
    const query = search.trim().toLowerCase();
    const source = view === "inbox" ? importedUnassignedLeads : view === "archived" ? archivedLeads : view === "all" ? leads : leads.filter((lead) => {
      const operator = operatorChoices.find((item) => item.username === view);
      return [normalizeKey(view), normalizeKey(operator?.label)].includes(normalizeKey(lead.assignedTo));
    });
    const filtered = source.filter((lead) => {
      if (dataFilter === "missing-phone" && lead.phone) return false;
      if (dataFilter === "missing-email" && lead.email) return false;
      if (dataFilter === "complete" && (!lead.phone || !lead.email)) return false;
      if (!query) return true;
      return `${lead.fullName} ${lead.phone} ${lead.email || ""} ${lead.source || ""} ${lead.status}`.toLowerCase().includes(query);
    });

    if (sortMode === "name") {
      return filtered.sort((a, b) => a.fullName.localeCompare(b.fullName, "it"));
    }

    if (sortMode === "lightest-load") {
      return filtered.sort((a, b) => {
        const aAssignee = operatorChoices.find((operator) => operator.username === getLeadAssigneeDraft(a.id));
        const bAssignee = operatorChoices.find((operator) => operator.username === getLeadAssigneeDraft(b.id));
        const aLoad = aAssignee?.openCount ?? Number.MAX_SAFE_INTEGER;
        const bLoad = bAssignee?.openCount ?? Number.MAX_SAFE_INTEGER;
        if (aLoad !== bLoad) return aLoad - bLoad;
        return compareLeadsForAssignment(a, b);
      });
    }

    return filtered.sort(compareLeadsForAssignment);
  }, [assignmentDrafts, dataFilter, defaultOperatorUsername, importedUnassignedLeads, operatorChoices, search, sortMode, view, archivedLeads, leads]);

  const summary = useMemo(
    () => ({
      leadsToAssign: importedUnassignedLeads.length,
      visibleLeads: filteredLeads.length,
      operatorsAvailable: operatorChoices.length,
      overloadedOperators: operatorChoices.filter((operator) => operator.openCount > 10).length
    }),
    [filteredLeads.length, importedUnassignedLeads.length, operatorChoices]
  );

  const selectedDefaultOperator = useMemo(
    () => operatorChoices.find((operator) => operator.username === defaultOperatorUsername) || null,
    [defaultOperatorUsername, operatorChoices]
  );
  const selectedLeadSet = useMemo(() => new Set(selectedLeadIds), [selectedLeadIds]);
  const allVisibleSelected = Boolean(filteredLeads.length) && filteredLeads.every((lead) => selectedLeadSet.has(lead.id));
  // Only selected leads still visible in the queue are assigned, so the button counts those.
  const batchTargetIds = filteredLeads.filter((lead) => selectedLeadSet.has(lead.id)).map((lead) => lead.id);

  function getLeadAssigneeDraft(leadId: string) {
    return assignmentDrafts[leadId] ?? defaultOperatorUsername;
  }

  function toggleLeadSelection(leadId: string) {
    setSelectedLeadIds((current) => (current.includes(leadId) ? current.filter((id) => id !== leadId) : [...current, leadId]));
  }

  function toggleVisibleSelection() {
    setSelectedLeadIds((current) => {
      if (allVisibleSelected) {
        return current.filter((id) => !filteredLeads.some((lead) => lead.id === id));
      }
      const next = new Set(current);
      filteredLeads.forEach((lead) => next.add(lead.id));
      return Array.from(next);
    });
  }

  function applyAssignmentLocally(leadIds: string[], assignedTo: string) {
    const touched = new Set(leadIds);
    const now = new Date().toISOString();
    const nextLeads = leads.map((item) => (touched.has(item.id) ? { ...item, assignedTo, updatedAt: now } : item));
    const nextTasks = tasks.map((task) => (task.leadId && touched.has(task.leadId) && task.status === "open" ? { ...task, assignedTo, updatedAt: now } : task));

    leadIds.forEach((leadId) => patchLeadAcrossStore(leadId, { assignedTo }));
    setTaskBoardCache(nextTasks, nextLeads);
    setLeads(nextLeads);
    setTasks(nextTasks);
    setSelectedLeadIds((current) => current.filter((id) => !touched.has(id)));
    setAssignmentDrafts((current) => {
      const next = { ...current };
      leadIds.forEach((leadId) => {
        delete next[leadId];
      });
      return next;
    });
  }

  async function handleAssignVisibleBatch() {
    const target = operatorUsers.find((user) => user.username === defaultOperatorUsername);
    if (!target || !batchTargetIds.length) return;
    setBatchAssigning(true);
    setError("");
    setNotice("");
    const results = await Promise.allSettled(batchTargetIds.map((leadId) => api(`/api/leads/${leadId}/assign`, {
      method: "POST", body: JSON.stringify({ userId: target.id })
    })));
    const succeeded = batchTargetIds.filter((_, index) => results[index].status === "fulfilled");
    applyAssignmentLocally(succeeded, target.username);
    const failed = results.filter((result) => result.status === "rejected");
    setNotice(`${succeeded.length} lead assegnate a ${getOperatorDisplay(target)}.`);
    if (failed.length) setError(`${failed.length} assegnazioni non riuscite. ${(failed[0] as PromiseRejectedResult).reason?.message || "Riprova sulle lead rimaste selezionate."}`);
    try { await refreshManagement(); } catch { setError("Assegnazioni salvate; aggiornamento elenco non riuscito. Premi Aggiorna."); }
    setBatchAssigning(false);
  }

  if (!canView) return <Navigate to="/dashboard" replace />;

  return (
    <div className="ops-control">
      <section className="ops-header">
        <div>
          <span className="ops-eyebrow">Lead inbox</span>
          <h1>Gestione operativa</h1>
        </div>
        <div className="ops-header-meta">
          <span>{summary.leadsToAssign} lead da assegnare</span>
          <button type="button" className="ops-refresh-btn" onClick={() => navigate("/tasks/import")}>
            Importa lead
          </button>
          <button type="button" className="ops-refresh-btn" onClick={() => window.location.reload()}>
            Aggiorna
          </button>
        </div>
      </section>

      {leadAction && <LeadActionDialog key={`${leadAction.lead.id}-${leadAction.action}`} lead={leadAction.lead} action={leadAction.action}
        onClose={() => setLeadAction(null)} onDone={async () => {
          setNotice("Contatto aggiornato. Operazione registrata nello storico.");
          try { await refreshManagement(); } catch { setError("Operazione salvata; aggiorna l'elenco per vedere i dati recenti."); }
        }} />}
      {notice && <div className="ops-alert neutral" role="status">{notice}</div>}
      <nav className="ops-management-tabs" aria-label="Elenchi gestione">
        <button type="button" aria-pressed={view === "inbox"} onClick={() => setView("inbox")}>Da assegnare</button>
        <button type="button" aria-pressed={view === "all"} onClick={() => setView("all")}>Tutte le lead</button>
        <button type="button" aria-pressed={view === "archived"} onClick={() => setView("archived")}>Archiviate</button>
        {!["inbox", "all", "archived"].includes(view) && <strong>Lead di {operatorChoices.find((operator) => operator.username === view)?.label}</strong>}
      </nav>
      {error ? <div className="ops-alert">{error}</div> : null}
      {loading ? <div className="ops-alert neutral">Caricamento coda lead...</div> : null}

      <div className="ops-layout">
        <section className="ops-panel ops-inbox-panel">
          <div className="ops-toolbar">
            <label className="ops-field search">
              <span>Cerca</span>
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Nome, telefono, email..."
                aria-label="Cerca lead da assegnare"
              />
            </label>

            <label className="ops-field">
              <span>Dati</span>
              <select value={dataFilter} onChange={(event) => setDataFilter(event.target.value as DataFilter)} aria-label="Filtro completezza dati">
                <option value="all">Tutte</option>
                <option value="complete">Complete</option>
                <option value="missing-phone">Senza telefono</option>
                <option value="missing-email">Senza email</option>
              </select>
            </label>

            <label className="ops-field">
              <span>Ordina</span>
              <select value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)} aria-label="Ordina lead">
                <option value="newest">Piu recenti</option>
                <option value="name">Nome cliente</option>
                <option value="lightest-load">Operatore suggerito</option>
              </select>
            </label>
          </div>

          <div className="ops-list-head">
            <div className="ops-list-summary">
              <strong>{view === "inbox" ? "Coda da assegnare" : view === "archived" ? "Contatti archiviati" : view === "all" ? "Tutte le lead" : "Lead assegnate all’operatore"}</strong>
              <span>{summary.visibleLeads} visibili</span>
            </div>
            <label className="ops-select-all">
              <input type="checkbox" checked={allVisibleSelected} onChange={toggleVisibleSelection} />
              <span>Seleziona tutti</span>
            </label>
          </div>

          <div className="ops-grid-head" aria-hidden="true">
            <span />
            <span>Lead</span>
            <span>Contatti</span>
            <span>Origine</span>
            <span>Operatore e azioni</span>
          </div>

          <div className="ops-grid-body" role="list" aria-label="Elenco lead">
            {filteredLeads.map((lead) => {
              const currentDraft = getLeadAssigneeDraft(lead.id);
              const suggestedOperator = operatorChoices.find((operator) => operator.username === currentDraft) || null;
              return (
                <article key={lead.id} className={`ops-row ${selectedLeadSet.has(lead.id) ? "selected" : ""}`} role="listitem">
                  <div className="ops-row-cell checkbox">
                    <input
                      type="checkbox"
                      checked={selectedLeadSet.has(lead.id)}
                      onChange={() => toggleLeadSelection(lead.id)}
                      aria-label={`Seleziona ${lead.fullName}`}
                    />
                  </div>

                  <div className="ops-row-cell lead">
                    <button type="button" className="ops-refresh-btn" onClick={() => navigate(`/pratiche/${lead.id}`)}>{lead.fullName}</button>
                    <small>Importata {formatImportDate(lead.createdAt || lead.updatedAt)}</small>
                  </div>

                  <div className="ops-row-cell contacts">
                    <span>{lead.phone || "Telefono mancante"}</span>
                    <small>{lead.email || "Email non disponibile"}</small>
                  </div>

                  <div className="ops-row-cell source">
                    <span className="ops-inline-badge source">{lead.source || "import"}</span>
                  </div>

                  <div className="ops-row-cell assignee">
                    <strong>{lead.assignedTo || suggestedOperator?.label || "Nessun operatore"}</strong>
                    <small>
                      {suggestedOperator
                        ? formatOperatorLoad(suggestedOperator)
                        : "Assegna dal pannello"}
                    </small>
                    {view === "archived" ? <>
                      <small>{lead.archivedBy} · {formatImportDate(lead.archivedAt || undefined)} · {lead.archiveReason}</small>
                      <button type="button" className="ops-refresh-btn" onClick={() => setLeadAction({ lead, action: "restore" })}>Ripristina</button>
                    </> : <button type="button" className="ops-refresh-btn" disabled={batchAssigning} onClick={() => setLeadAction({ lead, action: "archive" })}>Archivia</button>}
                  </div>

                </article>
              );
            })}

            {!filteredLeads.length ? (
              <div className="ops-empty-state">
                <strong>Nessuna lead in questo elenco.</strong>
                <p>
                  {"Scegli un altro elenco oppure modifica ricerca e filtri."}
                </p>
              </div>
            ) : null}
          </div>
        </section>

        <aside className="ops-panel ops-side-panel">
          <div className="ops-side-block">
            <div className="ops-side-head">
              <strong>Assegnazione bulk</strong>
              <span>{batchTargetIds.length} selezionate</span>
            </div>

            <label className="ops-field">
              <span>Operatore</span>
              <select
                value={defaultOperatorUsername}
                onChange={(event) => setDefaultOperatorUsername(event.target.value)}
                aria-label="Operatore predefinito"
              >
                <option value="">Seleziona operatore</option>
                {operatorChoices.map((operator) => (
                  <option key={operator.username} value={operator.username}>
                    {operator.label} - {formatOperatorLoad(operator)}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              className="ops-assign-btn secondary"
              onClick={handleAssignVisibleBatch}
              disabled={view === "archived" || !selectedDefaultOperator || !batchTargetIds.length || batchAssigning}
            >
              {batchAssigning ? "Assegno..." : `Assegna ${batchTargetIds.length} lead`}
            </button>

            <p className="ops-side-note">
              {selectedDefaultOperator
                ? `Destinazione corrente: ${selectedDefaultOperator.label}`
                : "Seleziona prima l'operatore destinatario."}
            </p>
          </div>

          <div className="ops-side-block">
            <div className="ops-side-head">
              <strong>Carico operatori</strong>
              <span>{summary.operatorsAvailable} attivi</span>
            </div>

            <div className="ops-operator-stack">
              {operatorChoices.map((operator) => (
                <button
                  key={operator.username}
                  type="button"
                  className={`ops-operator-item ${view === operator.username ? "active" : ""} ${operator.openCount > 10 ? "warning" : ""}`}
                  onClick={() => { setView(operator.username); setSearch(""); }}
                >
                  <div>
                    <strong>{operator.label}</strong>
                    <small>{formatOperatorLoad(operator)}</small>
                  </div>
                  <span title="Pratiche aperte assegnate">{operator.leadCount}</span>
                </button>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function formatOperatorLoad(operator: OperatorOption) {
  const practices = `${operator.leadCount} ${operator.leadCount === 1 ? "pratica" : "pratiche"}`;
  const tasks = `${operator.openCount} ${operator.openCount === 1 ? "attività aperta" : "attività aperte"}`;
  return `${practices} · ${tasks}${operator.overdueCount ? ` · ${operator.overdueCount} SLA` : ""}`;
}

export function LegacyLeadBoardRedirect() {
  return <Navigate to="/tasks" replace />;
}
