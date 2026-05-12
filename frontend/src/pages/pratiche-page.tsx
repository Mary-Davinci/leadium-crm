import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PracticeCard } from "../features/practices/components/PracticeCard";
import { PracticesQuickDetail } from "../features/practices/components/PracticesQuickDetail";
import { buildPracticeUrl } from "../features/practices/practice-links";
import { CallOutcome, Lead, LeadDetail, Workflow } from "../features/practices/pratiche.types";
import { getPriority, getPriorityScore, getSmartBucket, includesAny, normalizeLead } from "../features/practices/pratiche.utils";
import { api } from "../lib/api";
import { build3CXCallUri, clearPending3CXCall, createPending3CXCall } from "../lib/threecx";
import {
  CrmTask,
  getLeadDetailCacheEntry,
  getPracticeListCache,
  getTaskBoardCache,
  getWorkflowCache as getGlobalWorkflowCache,
  invalidateDashboardCache,
  invalidateLeadDetailCache,
  invalidateTaskBoardCache,
  isLeadDetailCacheFresh,
  isTaskBoardCacheFresh,
  isPracticeListCacheFresh,
  isWorkflowCacheFresh,
  patchLeadAcrossStore,
  setLeadDetailCacheEntry,
  setPracticeListCache,
  setTaskBoardCache,
  setWorkflowCache as setGlobalWorkflowCache,
  upsertTaskInBoard
} from "../store/crm-store";
import "../styles/pratiche-page.css";

const PRACTICE_WORKFLOW_CACHE_KEY = "leadium_pratiche_workflow_cache";
const PRACTICE_WORKFLOW_CACHE_TTL_MS = 10 * 60 * 1000;
const PRACTICE_DETAIL_CACHE_TTL_MS = 5 * 60 * 1000;
let workflowCache: Workflow | null = null;
const practiceDetailCache = new Map<string, LeadDetail>();

function dedupeTasksById(tasks: CrmTask[]) {
  const byId = new Map<string, CrmTask>();
  tasks.forEach((task) => {
    if (!task?.id) return;
    byId.set(String(task.id), task);
  });
  return Array.from(byId.values());
}

function isValidWorkflow(value: unknown): value is Workflow {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Workflow;
  return Array.isArray(candidate.statuses) && Boolean(candidate.flow) && typeof candidate.flow === "object";
}

function isValidLeadDetail(value: unknown): value is LeadDetail {
  if (!value || typeof value !== "object") return false;
  const candidate = value as LeadDetail;
  return Boolean(candidate.lead && typeof candidate.lead === "object") && Array.isArray(candidate.timeline);
}

function readWorkflowCacheStorage() {
  try {
    const raw = window.sessionStorage.getItem(PRACTICE_WORKFLOW_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { expiresAt: number; data: Workflow };
    if (!parsed?.expiresAt || parsed.expiresAt < Date.now() || !isValidWorkflow(parsed.data)) {
      window.sessionStorage.removeItem(PRACTICE_WORKFLOW_CACHE_KEY);
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

function writeWorkflowCacheStorage(data: Workflow) {
  try {
    window.sessionStorage.setItem(
      PRACTICE_WORKFLOW_CACHE_KEY,
      JSON.stringify({
        expiresAt: Date.now() + PRACTICE_WORKFLOW_CACHE_TTL_MS,
        data
      })
    );
  } catch {}
}

function getPracticeDetailCacheKey(leadId: string) {
  return `leadium_pratiche_detail_${leadId}`;
}

function readPracticeDetailCacheStorage(leadId: string) {
  try {
    const raw = window.sessionStorage.getItem(getPracticeDetailCacheKey(leadId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { expiresAt: number; data: LeadDetail };
    if (!parsed?.expiresAt || parsed.expiresAt < Date.now() || !isValidLeadDetail(parsed.data)) {
      window.sessionStorage.removeItem(getPracticeDetailCacheKey(leadId));
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

function writePracticeDetailCacheStorage(leadId: string, data: LeadDetail) {
  try {
    window.sessionStorage.setItem(
      getPracticeDetailCacheKey(leadId),
      JSON.stringify({
        expiresAt: Date.now() + PRACTICE_DETAIL_CACHE_TTL_MS,
        data
      })
    );
  } catch {}
}

export function PratichePage() {
  const defaultFollowUpAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 16);
  const navigate = useNavigate();
  const [smartFilter, setSmartFilter] = useState<"" | "overdue" | "today" | "planned" | "new">("");
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
  const [detailPanelDismissed, setDetailPanelDismissed] = useState(false);
  const [selectedDetail, setSelectedDetail] = useState<LeadDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [assignedFilter, setAssignedFilter] = useState("");
  const [priorityFilter, setPriorityFilter] = useState("");
  const [callOutcomeFilter, setCallOutcomeFilter] = useState("");
  const [documentFilter, setDocumentFilter] = useState(false);
  const [paymentFilter, setPaymentFilter] = useState(false);
  const [showExtraFilters, setShowExtraFilters] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [callModalLead, setCallModalLead] = useState<Lead | null>(null);
  const [callSubmitting, setCallSubmitting] = useState(false);
  const [callOutcome, setCallOutcome] = useState<CallOutcome>("completed");
  const [callNote, setCallNote] = useState("");
  const [callCreateFollowUp, setCallCreateFollowUp] = useState(false);
  const [callFollowUpAt, setCallFollowUpAt] = useState(defaultFollowUpAt);
  const [callStartedAt, setCallStartedAt] = useState("");
  const [callRequestKey, setCallRequestKey] = useState("");
  const [taskBoardTasks, setTaskBoardTasks] = useState<CrmTask[]>(() => getTaskBoardCache()?.data.tasks || []);
  const practiceCacheKey = useMemo(
    () => `search=${debouncedSearch.trim().toLowerCase()}|status=${String(statusFilter || "").toLowerCase()}`,
    [debouncedSearch, statusFilter]
  );

  function compareTasks(a: CrmTask, b: CrmTask) {
    const getLaneWeight = (task: CrmTask) => {
      if (task.status === "done") return 3;
      if (!task.dueAt) return 2;
      const due = new Date(task.dueAt);
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate()).getTime();
      if (due.getTime() < now.getTime()) return 0;
      if (dueDay === today) return 1;
      return 2;
    };
    const laneDiff = getLaneWeight(a) - getLaneWeight(b);
    if (laneDiff !== 0) return laneDiff;
    if (b.priority !== a.priority) return b.priority - a.priority;
    const aTs = a.dueAt ? new Date(a.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
    const bTs = b.dueAt ? new Date(b.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
    return aTs - bTs;
  }

  function patchLeadState(leadId: string, updates: Partial<Lead>) {
    patchLeadAcrossStore(leadId, updates);
    setLeads((prev) => prev.map((lead) => (lead.id === leadId ? { ...lead, ...updates } : lead)));
    setSelectedDetail((prev) =>
      prev && prev.lead.id === leadId ? { ...prev, lead: { ...prev.lead, ...updates } } : prev
    );
  }

  async function prefetchLeadDetail(leadId: string) {
    if (!leadId) return;
    if (isLeadDetailCacheFresh(leadId) && getLeadDetailCacheEntry(leadId)?.data) return;
    if (practiceDetailCache.has(leadId)) return;
    try {
      const payload = await api<LeadDetail>(`/api/leads/${leadId}`);
      practiceDetailCache.set(leadId, payload);
      writePracticeDetailCacheStorage(leadId, payload);
      setLeadDetailCacheEntry(leadId, payload);
    } catch {}
  }

  function patchLeadFromServer(lead: Lead) {
    patchLeadState(lead.id, lead);
  }

  function prependTimelineItem(leadId: string, item: { type: string; text: string; actor: string; createdAt: string }) {
    setSelectedDetail((prev) =>
      prev && prev.lead.id === leadId
        ? {
            ...prev,
            timeline: [item, ...(prev.timeline || [])]
          }
        : prev
    );
  }

  function prependCallLog(
    leadId: string,
    item: { id: string; leadId: string; startedAt: string; endedAt?: string; outcome: CallOutcome; actor: string; note?: string }
  ) {
    setSelectedDetail((prev) =>
      prev && prev.lead.id === leadId
        ? {
            ...prev,
            callLogs: [item, ...(prev.callLogs || [])]
          }
        : prev
    );
  }

  function toIsoDateTime(value: string) {
    return new Date(value).toISOString();
  }

  function getTomorrowIso() {
    return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  }

  async function createAutoFollowUp(lead: Lead, dueAt: string, description: string) {
    await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        leadId: lead.id,
        kind: "follow_up",
        title: `Follow-up ${lead.fullName}`,
        description,
        source: "pratiche",
        priority: 80,
        dueAt
      })
    });

    patchLeadState(lead.id, { nextActionAt: dueAt });
    invalidateTaskBoardCache();
    invalidateDashboardCache();
    prependTimelineItem(lead.id, {
      type: "task",
      text: description,
      actor: "operatore pratiche",
      createdAt: new Date().toISOString()
    });
  }

  function openCallOutcomeModal(lead: Lead, callMeta?: { startedAt?: string; requestKey?: string }) {
    setCallModalLead(lead);
    setCallOutcome("completed");
    setCallNote("");
    setCallCreateFollowUp(false);
    setCallFollowUpAt(defaultFollowUpAt);
    setCallStartedAt(callMeta?.startedAt || new Date().toISOString());
    setCallRequestKey(callMeta?.requestKey || `callreq_${lead.id}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`);
  }

  async function loadPratiche() {
    setError("");
    const localWorkflow = getGlobalWorkflowCache();
    const localList = getPracticeListCache(practiceCacheKey);
    const hasWorkflowSnapshot = Boolean(localWorkflow?.data);
    const hasListSnapshot = Boolean(localList?.data?.length);

    if (hasWorkflowSnapshot) {
      setWorkflow(localWorkflow!.data);
    }
    if (localList?.data) {
      setLeads(localList.data);
    }

    const workflowFresh = isWorkflowCacheFresh();
    const listFresh = isPracticeListCacheFresh(practiceCacheKey);
    if (workflowFresh && listFresh) {
      setLoading(false);
      return;
    }

    setLoading(!hasListSnapshot);
    try {
      const params = new URLSearchParams();
      if (debouncedSearch.trim()) params.set("search", debouncedSearch.trim());
      if (statusFilter) params.set("status", statusFilter);
      const cachedWorkflow =
        (isWorkflowCacheFresh() && getGlobalWorkflowCache()?.data) ||
        (isValidWorkflow(workflowCache) ? workflowCache : readWorkflowCacheStorage());

      const [workflowData, leadsData] = await Promise.all([
        cachedWorkflow ? Promise.resolve(cachedWorkflow) : api<Workflow>("/api/workflow"),
        api<Lead[]>(`/api/leads?${params.toString()}`)
      ]);

      if (!isValidWorkflow(workflowData)) {
        throw new Error("Workflow pratiche non valido.");
      }

      workflowCache = workflowData;
      writeWorkflowCacheStorage(workflowData);
      setGlobalWorkflowCache(workflowData);
      setWorkflow(workflowData);
      const normalizedLeads = (Array.isArray(leadsData) ? leadsData : []).map(normalizeLead);
      setPracticeListCache(practiceCacheKey, normalizedLeads);
      setLeads(normalizedLeads);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Errore caricamento pratiche.");
    } finally {
      setLoading(false);
    }
  }

  async function handleRegisterCall(id: string) {
    try {
      const createdAt = new Date().toISOString();
      const updatedLead = normalizeLead(
        await api<Lead>(`/api/leads/${id}/calls`, {
          method: "POST",
          body: JSON.stringify({
            disposition: "completed",
            actor: "operatore pratiche",
            startedAt: createdAt,
            endedAt: createdAt,
            idempotencyKey: `quickcall_${id}_${Date.now()}`
          })
        })
      );
      patchLeadFromServer(updatedLead);
      prependCallLog(id, {
        id: `quickcall_${id}_${Date.now()}`,
        leadId: id,
        startedAt: createdAt,
        endedAt: createdAt,
        outcome: "completed",
        actor: "operatore pratiche"
      });
      prependTimelineItem(id, {
        type: "call",
        text: "Chiamata registrata (completed).",
        actor: "operatore pratiche",
        createdAt
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Errore registrazione chiamata.");
    }
  }

  async function handleSubmitCallOutcome() {
    if (!callModalLead || callSubmitting) return;
    setCallSubmitting(true);
    try {
      const targetLeadId = callModalLead.id;
      const endedAt = new Date().toISOString();
      const previousStatus = callModalLead.status;
      const hasAutomaticFollowUp = callOutcome === "call_back" || callOutcome === "no_answer";
      const closesPractice = callOutcome === "not_interested";
      const automatedFollowUpAt =
        callOutcome === "call_back"
          ? callFollowUpAt
            ? toIsoDateTime(callFollowUpAt)
            : toIsoDateTime(defaultFollowUpAt)
          : callOutcome === "no_answer"
            ? getTomorrowIso()
            : "";
      const updatedLead = normalizeLead(
        await api<Lead>(`/api/leads/${callModalLead.id}/calls`, {
          method: "POST",
          body: JSON.stringify({
            disposition: callOutcome,
            actor: "operatore pratiche",
            note: callNote.trim(),
            endedAt,
            startedAt: callStartedAt || undefined,
            followUpAt: automatedFollowUpAt || undefined,
            idempotencyKey: callRequestKey || undefined
          })
        })
      );

      patchLeadFromServer(updatedLead);
      invalidateDashboardCache();
      invalidateTaskBoardCache();
      prependCallLog(callModalLead.id, {
        id: callRequestKey || `call_${Date.now()}`,
        leadId: callModalLead.id,
        startedAt: callStartedAt || endedAt,
        endedAt,
        outcome: callOutcome,
        actor: "operatore pratiche",
        note: callNote.trim() || undefined
      });

      prependTimelineItem(callModalLead.id, {
        type: "call",
        text: callNote.trim() ? `Chiamata registrata (${callOutcome}) - ${callNote.trim()}` : `Chiamata registrata (${callOutcome}).`,
        actor: "operatore pratiche",
        createdAt: endedAt
      });

      if (callOutcome === "call_back") {
        prependTimelineItem(callModalLead.id, {
          type: "task",
          text: callNote.trim()
            ? `Richiamo automatico pianificato: ${callNote.trim()}`
            : `Richiamo automatico creato dopo esito "da richiamare".`,
          actor: "operatore pratiche",
          createdAt: new Date().toISOString()
        });
      }

      if (callOutcome === "no_answer") {
        prependTimelineItem(callModalLead.id, {
          type: "task",
          text: callNote.trim()
            ? `Richiamo automatico domani: ${callNote.trim()}`
            : `Richiamo automatico creato per domani dopo mancata risposta.`,
          actor: "operatore pratiche",
          createdAt: new Date().toISOString()
        });
      }

      if (updatedLead.status !== previousStatus) {
        prependTimelineItem(callModalLead.id, {
          type: "status_changed",
          text: `Stato aggiornato a "${updatedLead.status}".`,
          actor: "operatore pratiche",
          createdAt: new Date().toISOString()
        });
      }

      if (!hasAutomaticFollowUp && !closesPractice && !updatedLead.nextActionAt && callOutcome === "interested") {
        const suggestedFollowUpAt = getTomorrowIso();
        await createAutoFollowUp(
          callModalLead,
          suggestedFollowUpAt,
          callNote.trim() || "Follow-up automatico creato dopo lead interessato."
        );
      }

      if (!automatedFollowUpAt && !closesPractice && callCreateFollowUp && callFollowUpAt) {
        await createAutoFollowUp(
          callModalLead,
          toIsoDateTime(callFollowUpAt),
          callNote.trim() || `Follow-up creato dopo chiamata con esito ${callOutcome}.`
        );
      }

      setCallModalLead(null);
      setCallStartedAt("");
      setCallRequestKey("");
      clearPending3CXCall();
      navigate(buildPracticeUrl(targetLeadId, hasAutomaticFollowUp || callCreateFollowUp || callOutcome === "interested" ? "task" : "timeline"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Errore registrazione esito chiamata.");
    } finally {
      setCallSubmitting(false);
    }
  }

  function handleStartCall(lead: Lead) {
    const pendingCall = createPending3CXCall(lead);
    const uri = build3CXCallUri(lead, pendingCall);
    if (!uri) {
      clearPending3CXCall();
      setError("Numero cliente non disponibile per avviare la chiamata.");
      return;
    }

    openCallOutcomeModal(lead, {
      startedAt: pendingCall.startedAt,
      requestKey: pendingCall.requestKey
    });
    window.location.href = uri;
  }

  async function handleCreateTask(lead: Lead) {
    const dueAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    try {
      const task = await api<CrmTask>("/api/tasks", {
        method: "POST",
        body: JSON.stringify({
          leadId: lead.id,
          kind: "follow_up",
          title: `Follow-up ${lead.fullName}`,
          description: `Task creato dalla pagina Pratiche per ${lead.fullName}.`,
          source: "pratiche",
          priority: 75,
          dueAt
        })
      });
      setTaskBoardTasks((prev) => dedupeTasksById([task, ...prev]));
      upsertTaskInBoard(task);
      patchLeadState(lead.id, { nextActionAt: dueAt });
      prependTimelineItem(lead.id, {
        type: "task",
        text: `Task creato dalla pagina Pratiche per ${lead.fullName}.`,
        actor: "operatore pratiche",
        createdAt: new Date().toISOString()
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Errore creazione task.");
    }
  }

  async function handleInlineStatusChange(leadId: string, toStatus: string) {
    const prevLeads = leads;
    const prevDetail = selectedDetail;

    setLeads((prev) => prev.map((lead) => (lead.id === leadId ? { ...lead, status: toStatus } : lead)));
    setSelectedDetail((prev) => (prev && prev.lead.id === leadId ? { ...prev, lead: { ...prev.lead, status: toStatus } } : prev));

    try {
      await api(`/api/leads/${leadId}/status`, {
        method: "POST",
        body: JSON.stringify({ toStatus, actor: "operatore pratiche" })
      });
      prependTimelineItem(leadId, {
        type: "status_changed",
        text: `Stato aggiornato a "${toStatus}".`,
        actor: "operatore pratiche",
        createdAt: new Date().toISOString()
      });
      invalidateLeadDetailCache(leadId);
      invalidateDashboardCache();
    } catch (e) {
      setLeads(prevLeads);
      setSelectedDetail(prevDetail);
      setError(e instanceof Error ? e.message : "Errore aggiornamento stato.");
    }
  }

  async function handleAssign(lead: Lead) {
    const current = String(lead.assignedTo || "").trim();
    const next = window.prompt("Assegna pratica a:", current || "me");
    if (next === null) return;
    const assignedTo = next.trim() || "me";
    try {
      await api(`/api/leads/${lead.id}`, {
        method: "PATCH",
        body: JSON.stringify({ assignedTo })
      });
      invalidateLeadDetailCache(lead.id);
      setLeads((prev) => prev.map((item) => (item.id === lead.id ? { ...item, assignedTo } : item)));
      setSelectedDetail((prev) => (prev && prev.lead.id === lead.id ? { ...prev, lead: { ...prev.lead, assignedTo } } : prev));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Errore assegnazione pratica.");
    }
  }

  async function handleMarkUrgent(lead: Lead) {
    const urgentTag = "URGENTE";
    const currentNotes = String(lead.notes || "").trim();
    const notes = currentNotes.toLowerCase().includes("urgente") ? currentNotes : `${urgentTag} - ${currentNotes || "Da gestire con prioritÃ  alta."}`;
    try {
      await api(`/api/leads/${lead.id}`, {
        method: "PATCH",
        body: JSON.stringify({ notes })
      });
      invalidateLeadDetailCache(lead.id);
      invalidateDashboardCache();
      setLeads((prev) => prev.map((item) => (item.id === lead.id ? { ...item, notes } : item)));
      setSelectedDetail((prev) => (prev && prev.lead.id === lead.id ? { ...prev, lead: { ...prev.lead, notes } } : prev));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Errore aggiornamento prioritÃ .");
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search);
    }, 300);

    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    loadPratiche().catch(() => null);
  }, [debouncedSearch, statusFilter]);

  useEffect(() => {
    const boardCache = getTaskBoardCache();
    if (boardCache?.data?.tasks?.length) {
      setTaskBoardTasks(dedupeTasksById(boardCache.data.tasks));
    }
    if (isTaskBoardCacheFresh()) return;

    api<{ tasks: CrmTask[]; leads: Lead[] }>("/api/tasks/board")
      .then((payload) => {
        const nextTasks = dedupeTasksById(Array.isArray(payload?.tasks) ? payload.tasks : []);
        const nextLeads = Array.isArray(payload?.leads) ? payload.leads : [];
        setTaskBoardCache(nextTasks, nextLeads);
        setTaskBoardTasks(nextTasks);
      })
      .catch(() => null);
  }, []);

  useEffect(() => {
    if (!selectedLeadId) {
      setSelectedDetail(null);
      setDetailError("");
      return;
    }

    let canceled = false;
    const globalCached = getLeadDetailCacheEntry(selectedLeadId);
    if (globalCached && isLeadDetailCacheFresh(selectedLeadId)) {
      practiceDetailCache.set(selectedLeadId, globalCached.data);
      setSelectedDetail(globalCached.data);
      setDetailLoading(false);
      setDetailError("");
      return;
    }
    const memoryCached = practiceDetailCache.get(selectedLeadId);
    if (memoryCached && isValidLeadDetail(memoryCached)) {
      setLeadDetailCacheEntry(selectedLeadId, memoryCached);
      setSelectedDetail(memoryCached);
      setDetailLoading(false);
      setDetailError("");
      return;
    }
    const storageCached = readPracticeDetailCacheStorage(selectedLeadId);
    if (storageCached) {
      practiceDetailCache.set(selectedLeadId, storageCached);
      setLeadDetailCacheEntry(selectedLeadId, storageCached);
      setSelectedDetail(storageCached);
      setDetailLoading(false);
      setDetailError("");
      return;
    }

    setDetailLoading(true);
    setDetailError("");
    api<LeadDetail>(`/api/leads/${selectedLeadId}`)
      .then((payload) => {
        if (canceled) return;
        practiceDetailCache.set(selectedLeadId, payload);
        writePracticeDetailCacheStorage(selectedLeadId, payload);
        setLeadDetailCacheEntry(selectedLeadId, payload);
        setSelectedDetail(payload);
      })
      .catch((e) => {
        if (canceled) return;
        setDetailError(e instanceof Error ? e.message : "Errore caricamento dettaglio pratica.");
        setSelectedDetail(null);
      })
      .finally(() => {
        if (canceled) return;
        setDetailLoading(false);
      });

    return () => {
      canceled = true;
    };
  }, [selectedLeadId]);

  const assignees = useMemo(
    () =>
      Array.from(new Set(leads.map((lead) => String(lead.assignedTo || "").trim()).filter(Boolean))).sort((a, b) =>
        a.localeCompare(b, "it")
      ),
    [leads]
  );

  const primaryTaskByLeadId = useMemo(() => {
    const grouped = new Map<string, CrmTask[]>();
    taskBoardTasks
      .filter((task) => task.status === "open" && task.leadId)
      .forEach((task) => {
        const key = String(task.leadId);
        const bucket = grouped.get(key) || [];
        bucket.push(task);
        grouped.set(key, bucket);
      });

    const result = new Map<string, CrmTask>();
    grouped.forEach((items, leadId) => {
      const ordered = [...items].sort(compareTasks);
      if (ordered[0]) result.set(leadId, ordered[0]);
    });
    return result;
  }, [taskBoardTasks]);

  const getOperationalBucket = (lead: Lead) => {
    const task = primaryTaskByLeadId.get(lead.id);
    if (!task || task.status === "done") return getSmartBucket(lead);
    if (!task.dueAt) return "new" as const;
    const due = new Date(task.dueAt);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate()).getTime();
    if (due.getTime() < now.getTime()) return "overdue" as const;
    if (dueDay === today) return "today" as const;
    return "planned" as const;
  };

  const rows = useMemo(
    () =>
      leads.filter((lead) => {
        if (assignedFilter && String(lead.assignedTo || "") !== assignedFilter) return false;

        const priority = getPriority(lead);
        if (priorityFilter && priority !== priorityFilter) return false;
        if (callOutcomeFilter && String(lead.latestCallOutcome || "") !== callOutcomeFilter) return false;

        const stack = `${lead.status} ${lead.notes}`.toLowerCase();
        if (documentFilter && !includesAny(stack, ["document", "doc"])) return false;
        if (paymentFilter && !includesAny(stack, ["saldo", "pagament", "rata", "scaden"])) return false;
        if (smartFilter && getOperationalBucket(lead) !== smartFilter) return false;
        return true;
      }),
    [leads, assignedFilter, priorityFilter, callOutcomeFilter, documentFilter, paymentFilter, smartFilter, primaryTaskByLeadId]
  );

  const sortedRows = useMemo(() => {
    const getTaskLaneWeight = (task: CrmTask) => {
      if (task.status === "done") return 3;
      if (!task.dueAt) return 2;
      const due = new Date(task.dueAt);
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate()).getTime();
      if (due.getTime() < now.getTime()) return 0;
      if (dueDay === today) return 1;
      return 2;
    };

    return [...rows].sort((a, b) => {
      const taskA = primaryTaskByLeadId.get(a.id) || null;
      const taskB = primaryTaskByLeadId.get(b.id) || null;

      if (taskA && !taskB) return -1;
      if (!taskA && taskB) return 1;

      if (taskA && taskB) {
        const laneDiff = getTaskLaneWeight(taskA) - getTaskLaneWeight(taskB);
        if (laneDiff !== 0) return laneDiff;
        if (taskB.priority !== taskA.priority) return taskB.priority - taskA.priority;
        const taskADue = taskA.dueAt ? new Date(taskA.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
        const taskBDue = taskB.dueAt ? new Date(taskB.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
        if (taskADue !== taskBDue) return taskADue - taskBDue;
      }

      const byPriority = getPriorityScore(b) - getPriorityScore(a);
      if (byPriority !== 0) return byPriority;
      const aTs = a.nextActionAt ? new Date(a.nextActionAt).getTime() : Number.MAX_SAFE_INTEGER;
      const bTs = b.nextActionAt ? new Date(b.nextActionAt).getTime() : Number.MAX_SAFE_INTEGER;
      return aTs - bTs;
    });
  }, [rows, primaryTaskByLeadId]);

  const smartCounts = useMemo(() => {
    const overdue = leads.filter((lead) => getOperationalBucket(lead) === "overdue").length;
    const today = leads.filter((lead) => getOperationalBucket(lead) === "today").length;
    const planned = leads.filter((lead) => getOperationalBucket(lead) === "planned").length;
    const fresh = leads.filter((lead) => getOperationalBucket(lead) === "new").length;
    return { overdue, today, planned, fresh };
  }, [leads, primaryTaskByLeadId]);

  useEffect(() => {
    if (!selectedLeadId) return;
    const exists = sortedRows.some((lead) => lead.id === selectedLeadId);
    if (!exists) setSelectedLeadId(null);
  }, [sortedRows, selectedLeadId]);

  useEffect(() => {
    if (selectedLeadId) {
      setDetailPanelDismissed(false);
    }
  }, [selectedLeadId]);

  function handleSelectLead(leadId: string | null) {
    setDetailPanelDismissed(false);
    setSelectedLeadId(leadId);
  }

  function handleCloseQuickDetail() {
    setDetailPanelDismissed(true);
    setSelectedLeadId(null);
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const isTypingTarget = tag === "input" || tag === "textarea" || tag === "select" || Boolean(target?.isContentEditable);
      if (isTypingTarget) return;
      if (!sortedRows.length) return;

      const currentIndex = sortedRows.findIndex((lead) => lead.id === selectedLeadId);
      if (event.key === "ArrowDown") {
        event.preventDefault();
        const nextIndex = currentIndex < 0 ? 0 : Math.min(sortedRows.length - 1, currentIndex + 1);
        setSelectedLeadId(sortedRows[nextIndex].id);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        const nextIndex = currentIndex < 0 ? 0 : Math.max(0, currentIndex - 1);
        setSelectedLeadId(sortedRows[nextIndex].id);
      } else if (event.key === "Enter" && selectedLeadId) {
        event.preventDefault();
        navigate(buildPracticeUrl(selectedLeadId));
      } else if ((event.key === "c" || event.key === "C") && selectedLeadId) {
        event.preventDefault();
        const selected = sortedRows.find((lead) => lead.id === selectedLeadId);
        if (selected) handleStartCall(selected);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sortedRows, selectedLeadId, navigate]);

  function handleSuggestedAction(lead: Lead, kind: "call" | "open" | "task") {
    if (kind === "call") {
      handleStartCall(lead);
      return;
    }
    if (kind === "task") {
      void handleCreateTask(lead);
      return;
    }
    navigate(buildPracticeUrl(lead.id));
  }

  const modalAutoFollowUp = callOutcome === "call_back" || callOutcome === "no_answer";
  const modalClosedOutcome = callOutcome === "not_interested";
  const isQuickDetailVisible = Boolean(selectedLeadId);

  return (
    <div className="pr-page">
      <section className="panel pr-main">
        <header className="pr-header">
          <div className="pr-smart-badges">
              <button
                type="button"
                className={`pr-smart-badge all ${smartFilter === "" ? "active" : ""}`}
                onClick={() => setSmartFilter("")}
              >
                Tutte <span>{leads.length}</span>
              </button>
              <button
                type="button"
                className={`pr-smart-badge overdue ${smartFilter === "overdue" ? "active" : ""}`}
                onClick={() => setSmartFilter((current) => (current === "overdue" ? "" : "overdue"))}
              >
                Urgenti <span>{smartCounts.overdue}</span>
              </button>
              <button
                type="button"
                className={`pr-smart-badge today ${smartFilter === "today" ? "active" : ""}`}
                onClick={() => setSmartFilter((current) => (current === "today" ? "" : "today"))}
              >
                Oggi <span>{smartCounts.today}</span>
              </button>
              <button
                type="button"
                className={`pr-smart-badge planned ${smartFilter === "planned" ? "active" : ""}`}
                onClick={() => setSmartFilter((current) => (current === "planned" ? "" : "planned"))}
              >
                Pianificate <span>{smartCounts.planned}</span>
              </button>
              <button
                type="button"
                className={`pr-smart-badge fresh ${smartFilter === "new" ? "active" : ""}`}
                onClick={() => setSmartFilter((current) => (current === "new" ? "" : "new"))}
              >
                Nuove <span>{smartCounts.fresh}</span>
              </button>
          </div>
        </header>

        <div className="pr-filters">
          <label className="pr-search-field">
            <span className="pr-search-icon" aria-hidden="true">
              <svg viewBox="0 0 16 16">
                <circle cx="7" cy="7" r="4.5" />
                <path d="M10.5 10.5 14 14" />
              </svg>
            </span>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Cerca nelle pratiche..." />
          </label>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">Tutti gli stati</option>
            {workflow?.statuses.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
          <select value={assignedFilter} onChange={(e) => setAssignedFilter(e.target.value)}>
            <option value="">Tutti gli assegnati</option>
            {assignees.map((assignee) => (
              <option key={assignee} value={assignee}>
                {assignee}
              </option>
            ))}
          </select>
          <select value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value)}>
            <option value="">Tutte le priorità </option>
            <option value="alta">Alta</option>
            <option value="media">Media</option>
            <option value="bassa">Bassa</option>
          </select>
          <button
            type="button"
            className={`pr-filter-toggle ${showExtraFilters ? "active" : ""}`}
            onClick={() => setShowExtraFilters((current) => !current)}
          >
            <span className="pr-filter-toggle-icon" aria-hidden="true">
              <svg viewBox="0 0 16 16">
                <path d="M2 4h12M4.5 8h7M6.5 12h3" />
              </svg>
            </span>
            Extra filtri
          </button>
        </div>

        {showExtraFilters ? (
          <div className="pr-filters pr-filters-extra">
            <select value={callOutcomeFilter} onChange={(e) => setCallOutcomeFilter(e.target.value)}>
              <option value="">Tutti gli esiti chiamata</option>
              <option value="completed">Completata</option>
              <option value="no_answer">Nessuna risposta</option>
              <option value="busy">Occupato</option>
              <option value="call_back">Da richiamare</option>
              <option value="interested">Interessato</option>
              <option value="not_interested">Non interessato</option>
            </select>
            <label className="pr-check">
              <input type="checkbox" checked={documentFilter} onChange={(e) => setDocumentFilter(e.target.checked)} />
              Documenti mancanti
            </label>
            <label className="pr-check">
              <input type="checkbox" checked={paymentFilter} onChange={(e) => setPaymentFilter(e.target.checked)} />
              Pagamenti in scadenza
            </label>
          </div>
        ) : null}

        {loading ? <p className="muted">Caricamento pratiche...</p> : null}
        {error ? <p className="pr-error">{error}</p> : null}

        <div className="pr-list">
          <div className="pr-list-head" aria-hidden="true">
            <span>Priorita</span>
            <span>Cliente</span>
            <span>Ultimo contatto</span>
            <span>Prossima azione</span>
            <span>Scadenza</span>
            <span>Assegnato</span>
          </div>
          {sortedRows.length ? (
            sortedRows.map((lead) => (
              <PracticeCard
                key={lead.id}
                lead={lead}
                linkedTask={primaryTaskByLeadId.get(lead.id) || null}
                isSelected={selectedLeadId === lead.id}
                isBusy={loading}
                availableStatuses={workflow?.flow[lead.status] || []}
                onSelect={handleSelectLead}
                onPrefetchDetail={prefetchLeadDetail}
                onOpen={(id) => navigate(buildPracticeUrl(id))}
                onStartCall={handleStartCall}
                onRegisterCall={(item) => handleRegisterCall(item.id)}
                onWrite={(_lead) => navigate("/chat")}
                onQuickTask={handleCreateTask}
                onStatusChange={handleInlineStatusChange}
                onAssign={handleAssign}
                onMarkUrgent={handleMarkUrgent}
                onSuggestedAction={handleSuggestedAction}
              />
            ))
          ) : (
            <p className="muted pr-empty-list">Nessuna pratica trovata con i filtri attuali.</p>
          )}
        </div>
      </section>

      {isQuickDetailVisible ? <div className="pr-drawer-backdrop" onClick={handleCloseQuickDetail} /> : null}
      {isQuickDetailVisible ? (
        <aside className={`pr-sidebar ${selectedLeadId ? "open" : "closed"}`}>
          {detailError ? <p className="pr-error">{detailError}</p> : null}
          <PracticesQuickDetail detail={selectedDetail} loading={detailLoading} />
        </aside>
      ) : null}

      {callModalLead ? (
        <div
          className="pr-call-modal-backdrop"
          onClick={() => {
            if (callSubmitting) return;
            setCallModalLead(null);
            setCallStartedAt("");
            setCallRequestKey("");
            clearPending3CXCall();
          }}
        >
          <div className="pr-call-modal panel" onClick={(event) => event.stopPropagation()}>
            <div className="pr-call-modal-head">
              <div>
                <h3>Esito chiamata</h3>
                <p>
                  {callModalLead.fullName} Â· {callModalLead.phone || "-"}
                </p>
              </div>
            </div>

            <div className="pr-call-modal-grid">
              <label>
                Esito
                <select value={callOutcome} onChange={(event) => setCallOutcome(event.target.value as CallOutcome)}>
                  <option value="completed">Completata</option>
                  <option value="no_answer">Nessuna risposta</option>
                  <option value="busy">Occupato</option>
                  <option value="call_back">Da richiamare</option>
                  <option value="interested">Interessato</option>
                  <option value="not_interested">Non interessato</option>
                </select>
              </label>

              <label className="pr-call-modal-note">
                Nota breve
                <textarea
                  value={callNote}
                  onChange={(event) => setCallNote(event.target.value)}
                  placeholder="Aggiungi un appunto operativo sulla chiamata..."
                />
              </label>

              {modalAutoFollowUp ? (
                <div className="pr-call-hint">
                  {callOutcome === "call_back"
                    ? "Follow-up automatico: verrÃ  impostato un richiamo con la data selezionata."
                    : "Follow-up automatico: verrÃ  creato un richiamo per domani."}
                </div>
              ) : !modalClosedOutcome ? (
                <>
                  <label className="pr-call-check">
                    <input
                      type="checkbox"
                      checked={callCreateFollowUp}
                      onChange={(event) => setCallCreateFollowUp(event.target.checked)}
                    />
                    Crea follow-up
                  </label>

                  <label>
                    Data follow-up
                    <input
                      type="datetime-local"
                      value={callFollowUpAt}
                      onChange={(event) => setCallFollowUpAt(event.target.value)}
                      disabled={!callCreateFollowUp}
                    />
                  </label>
                </>
              ) : (
                <div className="pr-call-hint pr-call-hint-closed">
                  La pratica verrÃ  chiusa senza creare una prossima azione.
                </div>
              )}
            </div>

              <div className="pr-call-modal-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={callSubmitting}
                  onClick={() => {
                    setCallModalLead(null);
                    setCallStartedAt("");
                    setCallRequestKey("");
                    clearPending3CXCall();
                  }}
                >
                  Annulla
                </button>
              <button type="button" className="primary" disabled={callSubmitting} onClick={() => void handleSubmitCallOutcome()}>
                {callSubmitting ? "Salvataggio..." : "Salva esito"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

