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
  id: string;
  fullName: string;
  phone: string;
  email?: string;
  source?: string;
  assignedTo?: string;
  status: string;
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
  openCount: number;
  overdueCount: number;
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
  return new Date(value).toLocaleString("it-IT", {
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
  const authUser = getAuthUser();
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<CrmTask[]>(() => getTaskBoardCache()?.data.tasks.map(normalizeTask) || []);
  const [leads, setLeads] = useState<Lead[]>(() => getTaskBoardCache()?.data.leads.map(normalizeLead) || []);
  const [users, setUsers] = useState<CrmUser[]>(() => getUsersCache()?.data || []);
  const [defaultOperatorUsername, setDefaultOperatorUsername] = useState("");
  const [assignmentDrafts, setAssignmentDrafts] = useState<Record<string, string>>({});
  const [assigningLeadId, setAssigningLeadId] = useState("");
  const [search, setSearch] = useState("");
  const [dataFilter, setDataFilter] = useState<DataFilter>("all");
  const [sortMode, setSortMode] = useState<SortMode>("newest");
  const [batchAssigning, setBatchAssigning] = useState(false);
  const [selectedLeadIds, setSelectedLeadIds] = useState<string[]>([]);
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

  const operatorUsers = useMemo(() => users.filter((user) => user.role === "operatore"), [users]);

  const operatorChoices = useMemo<OperatorOption[]>(() => {
    const openByAssignee = new Map<string, number>();
    const overdueByAssignee = new Map<string, number>();

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
        return {
          key: usernameKey,
          username: user.username,
          label: displayName,
          openCount,
          overdueCount
        };
      })
      .sort((a, b) => a.openCount - b.openCount || a.label.localeCompare(b.label, "it"));
  }, [operatorUsers, tasks]);

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
    const filtered = importedUnassignedLeads.filter((lead) => {
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
  }, [assignmentDrafts, dataFilter, defaultOperatorUsername, importedUnassignedLeads, operatorChoices, search, sortMode]);

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

  async function handleAssignLead(lead: Lead) {
    const assignedTo = getLeadAssigneeDraft(lead.id).trim();
    if (!assignedTo) {
      setError("Seleziona un operatore prima di assegnare la lead.");
      return;
    }

    setAssigningLeadId(lead.id);
    setError("");
    try {
      await api(`/api/leads/${lead.id}`, {
        method: "PATCH",
        body: JSON.stringify({ assignedTo })
      });
      applyAssignmentLocally([lead.id], assignedTo);
    } catch (assignError) {
      setError(assignError instanceof Error ? assignError.message : "Errore assegnazione lead.");
    } finally {
      setAssigningLeadId("");
    }
  }

  async function handleAssignVisibleBatch() {
    const assignedTo = defaultOperatorUsername.trim();
    if (!assignedTo) {
      setError("Seleziona un operatore predefinito per l'assegnazione batch.");
      return;
    }
    const targetLeadIds = selectedLeadIds.filter((leadId) => filteredLeads.some((lead) => lead.id === leadId));
    if (!targetLeadIds.length) return;

    setBatchAssigning(true);
    setError("");
    try {
      await Promise.all(
        targetLeadIds.map((leadId) =>
          api(`/api/leads/${leadId}`, {
            method: "PATCH",
            body: JSON.stringify({ assignedTo })
          })
        )
      );
      applyAssignmentLocally(targetLeadIds, assignedTo);
    } catch (assignError) {
      setError(assignError instanceof Error ? assignError.message : "Errore assegnazione batch.");
    } finally {
      setBatchAssigning(false);
    }
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
                <option value="lightest-load">Owner suggerito</option>
              </select>
            </label>
          </div>

          <div className="ops-list-head">
            <div className="ops-list-summary">
              <strong>Coda da assegnare</strong>
              <span>{summary.visibleLeads} visibili</span>
            </div>
            <label className="ops-select-all">
              <input type="checkbox" checked={allVisibleSelected} onChange={toggleVisibleSelection} />
              <span>Seleziona visibili</span>
            </label>
          </div>

          <div className="ops-grid-head" aria-hidden="true">
            <span />
            <span>Lead</span>
            <span>Contatti</span>
            <span>Origine</span>
            <span>Stato dati</span>
            <span>Owner suggerito</span>
            <span>Apri</span>
          </div>

          <div className="ops-grid-body" role="list" aria-label="Lead senza assegnazione">
            {filteredLeads.map((lead) => {
              const currentDraft = getLeadAssigneeDraft(lead.id);
              const suggestedOperator = operatorChoices.find((operator) => operator.username === currentDraft) || null;
              const completeness = getLeadCompleteness(lead);
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
                    <strong>{lead.fullName}</strong>
                    <small>Importata {formatImportDate(lead.createdAt || lead.updatedAt)}</small>
                  </div>

                  <div className="ops-row-cell contacts">
                    <span>{lead.phone || "Telefono mancante"}</span>
                    <small>{lead.email || "Email non disponibile"}</small>
                  </div>

                  <div className="ops-row-cell source">
                    <span className="ops-inline-badge source">{lead.source || "import"}</span>
                  </div>

                  <div className="ops-row-cell quality">
                    {completeness === "complete" ? <span className="ops-inline-badge good">Completa</span> : null}
                    {completeness === "missing-phone" ? <span className="ops-inline-badge warning">No telefono</span> : null}
                    {completeness === "missing-email" ? <span className="ops-inline-badge warning">No email</span> : null}
                    {completeness === "missing-both" ? <span className="ops-inline-badge danger">Dati minimi</span> : null}
                  </div>

                  <div className="ops-row-cell assignee">
                    <strong>{suggestedOperator?.label || "Nessun owner"}</strong>
                    <small>
                      {suggestedOperator
                        ? `${suggestedOperator.openCount} aperte${suggestedOperator.overdueCount ? ` - ${suggestedOperator.overdueCount} SLA` : ""}`
                        : "Assegna dal pannello"}
                    </small>
                  </div>

                  <div className="ops-row-cell action">
                    <button type="button" className="ops-open-btn">
                      Apri
                    </button>
                  </div>
                </article>
              );
            })}

            {!filteredLeads.length ? (
              <div className="ops-empty-state">
                <strong>{importedUnassignedLeads.length ? "Nessuna lead trovata con questo filtro." : "Coda pulita."}</strong>
                <p>
                  {importedUnassignedLeads.length
                    ? "Prova a cambiare ricerca o filtro."
                    : "Le lead importate da Excel sono tutte assegnate."}
                </p>
              </div>
            ) : null}
          </div>
        </section>

        <aside className="ops-panel ops-side-panel">
          <div className="ops-side-block">
            <div className="ops-side-head">
              <strong>Assegnazione bulk</strong>
              <span>{selectedLeadIds.length} selezionate</span>
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
                    {operator.label} - {operator.openCount} aperte{operator.overdueCount ? ` - ${operator.overdueCount} SLA` : ""}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              className="ops-assign-btn secondary"
              onClick={handleAssignVisibleBatch}
              disabled={!selectedDefaultOperator || !selectedLeadIds.length || batchAssigning}
            >
              {batchAssigning ? "Assegno..." : `Assegna ${selectedLeadIds.length} lead`}
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
                  className={`ops-operator-item ${defaultOperatorUsername === operator.username ? "active" : ""} ${operator.openCount > 10 ? "warning" : ""}`}
                  onClick={() => setDefaultOperatorUsername(operator.username)}
                >
                  <div>
                    <strong>{operator.label}</strong>
                    <small>{operator.overdueCount ? `${operator.overdueCount} SLA aperte` : "Nessuna SLA aperta"}</small>
                  </div>
                  <span>{operator.openCount}</span>
                </button>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

export function LegacyLeadBoardRedirect() {
  return <Navigate to="/tasks" replace />;
}
