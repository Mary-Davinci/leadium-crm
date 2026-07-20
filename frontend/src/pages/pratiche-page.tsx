import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PracticeCard } from "../features/practices/components/PracticeCard";
import { PracticesQuickDetail } from "../features/practices/components/PracticesQuickDetail";
import { buildPracticeUrl } from "../features/practices/practice-links";
import { CallOutcome, Lead, LeadDetail, Workflow } from "../features/practices/pratiche.types";
import { getPriority, getPriorityScore, getSmartBucket, includesAny, normalizeLead } from "../features/practices/pratiche.utils";
import { api } from "../lib/api";
import { getAuthUser } from "../lib/auth";
import { build3CXCallUri, clearPending3CXCall, createPending3CXCall, launch3CXUri } from "../lib/threecx";
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
const MAX_PRACTICE_DETAIL_CACHE_ENTRIES = 4;
let workflowCache: Workflow | null = null;
const practiceDetailCache = new Map<string, LeadDetail>();
const PRACTICE_READY_STATUS = "pronta per chiusura";
const PRACTICE_CLOSED_STATUS = "chiusa 100";

type PracticeView = "active" | "ready" | "closed";
type CallConnection = "answered" | "no_answer" | "busy";
type AnsweredCallOutcome = "completed" | "interested" | "call_back" | "not_interested";

function getPracticeViewFromStatus(status?: string | null): PracticeView {
  const normalized = String(status || "").trim().toLowerCase();
  if (normalized.includes(PRACTICE_CLOSED_STATUS)) return "closed";
  if (normalized.includes(PRACTICE_READY_STATUS)) return "ready";
  return "active";
}

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

function compactLeadDetailForCache(detail: LeadDetail): LeadDetail {
  return {
    ...detail,
    lead: {
      ...detail.lead,
      documents: detail.lead.documents
        ? {
            ...detail.lead.documents,
            items: (detail.lead.documents.items || []).map((item) => ({
              ...item,
              attachments: (item.attachments || []).map((attachment) => ({
                ...attachment,
                dataUrl: attachment.storageKey ? "" : attachment.dataUrl
              }))
            }))
          }
        : detail.lead.documents
    },
    timeline: Array.isArray(detail.timeline) ? detail.timeline.slice(-24) : [],
    callLogs: Array.isArray(detail.callLogs) ? detail.callLogs.slice(-12) : []
  };
}

function rememberPracticeDetailCache(leadId: string, detail: LeadDetail) {
  const compacted = compactLeadDetailForCache(detail);
  if (practiceDetailCache.has(leadId)) {
    practiceDetailCache.delete(leadId);
  }
  practiceDetailCache.set(leadId, compacted);
  while (practiceDetailCache.size > MAX_PRACTICE_DETAIL_CACHE_ENTRIES) {
    const oldestKey = practiceDetailCache.keys().next().value;
    if (!oldestKey) break;
    practiceDetailCache.delete(oldestKey);
  }
  writePracticeDetailCacheStorage(leadId, compacted);
  setLeadDetailCacheEntry(leadId, compacted);
  return compacted;
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
  const authUser = getAuthUser();
  const isAdmin = authUser?.role === "admin" || authUser?.role === "super_admin";
  const [scopeFilter, setScopeFilter] = useState<"mine" | "all">(isAdmin ? "all" : "mine");
  const [practiceView, setPracticeView] = useState<PracticeView>("active");
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
  const [callConnection, setCallConnection] = useState<CallConnection>("answered");
  const [answeredCallOutcome, setAnsweredCallOutcome] = useState<AnsweredCallOutcome>("completed");
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
  const selectedLeadSummary = useMemo(
    () => leads.find((lead) => lead.id === selectedLeadId) || null,
    [leads, selectedLeadId]
  );
  const resolvedCallOutcome: CallOutcome = callConnection === "answered" ? answeredCallOutcome : callConnection;

  function normalizeIdentity(value?: string | null) {
    return String(value || "").trim().toLocaleLowerCase("it");
  }

  const currentUserKeys = useMemo(() => {
    const keys = new Set<string>();
    const fullName = [String(authUser?.name || "").trim(), String(authUser?.surname || "").trim()].filter(Boolean).join(" ").trim();
    [authUser?.username, authUser?.name, authUser?.email, fullName].forEach((value) => {
      const normalized = normalizeIdentity(value);
      if (normalized) keys.add(normalized);
    });
    return keys;
  }, [authUser]);

  function isLeadAssignedToCurrentUser(lead: Lead) {
    return currentUserKeys.has(normalizeIdentity(lead.assignedTo));
  }

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
  }

  async function prefetchLeadDetail(leadId: string) {
    if (!leadId) return;
    if (isLeadDetailCacheFresh(leadId) && getLeadDetailCacheEntry(leadId)?.data) return;
    if (practiceDetailCache.has(leadId)) return;
    try {
      const payload = await api<LeadDetail>(`/api/leads/${leadId}`);
      rememberPracticeDetailCache(leadId, payload);
    } catch {}
  }

  function patchLeadFromServer(lead: Lead) {
    patchLeadState(lead.id, lead);
  }

  function prependTimelineItem(leadId: string, item: { type: string; text: string; actor: string; createdAt: string }) {
    void leadId;
    void item;
  }

  function prependCallLog(
    leadId: string,
    item: { id: string; leadId: string; startedAt: string; endedAt?: string; outcome: CallOutcome; actor: string; note?: string }
  ) {
    void leadId;
    void item;
  }

  function toIsoDateTime(value: string) {
    return new Date(value).toISOString();
  }

  function getTomorrowIso() {
    return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  }

  function getBusyFollowUpAt() {
    return new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString().slice(0, 16);
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
    setCallConnection("answered");
    setAnsweredCallOutcome("completed");
    setCallNote("");
    setCallCreateFollowUp(false);
    setCallFollowUpAt(defaultFollowUpAt);
    setCallStartedAt(callMeta?.startedAt || new Date().toISOString());
    setCallRequestKey(callMeta?.requestKey || `callreq_${lead.id}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`);
  }

  function selectCallConnection(nextConnection: CallConnection) {
    setCallConnection(nextConnection);
    if (nextConnection === "answered") {
      setCallCreateFollowUp(false);
      setCallFollowUpAt(defaultFollowUpAt);
    }
    if (nextConnection === "busy") {
      setCallCreateFollowUp(true);
      setCallFollowUpAt(getBusyFollowUpAt());
    }
    if (nextConnection === "no_answer") {
      setCallCreateFollowUp(false);
      setCallFollowUpAt(defaultFollowUpAt);
    }
  }

  function selectAnsweredCallOutcome(nextOutcome: AnsweredCallOutcome) {
    setAnsweredCallOutcome(nextOutcome);
    if (nextOutcome === "call_back") {
      setCallCreateFollowUp(false);
      setCallFollowUpAt(defaultFollowUpAt);
    }
    if (nextOutcome === "not_interested") {
      setCallCreateFollowUp(false);
    }
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
        api<Lead[]>(`/api/leads?${params.toString()}${params.toString() ? "&" : ""}view=summary`)
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
      const callOutcome = resolvedCallOutcome;
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
    const launched = launch3CXUri(uri);
    if (!launched) {
      setError("Impossibile avviare il client chiamate. Verifica che 3CX sia l'app predefinita per i link telefonici.");
    }
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

    setLeads((prev) => prev.map((lead) => (lead.id === leadId ? { ...lead, status: toStatus } : lead)));

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
    } catch (e) {
      setError(e instanceof Error ? e.message : "Errore assegnazione pratica.");
    }
  }

  async function handleMarkUrgent(lead: Lead) {
    const urgentTag = "URGENTE";
    const currentNotes = String(lead.notes || "").trim();
    const notes = currentNotes.toLowerCase().includes("urgente") ? currentNotes : `${urgentTag} - ${currentNotes || "Da gestire con priorita alta."}`;
    try {
      await api(`/api/leads/${lead.id}`, {
        method: "PATCH",
        body: JSON.stringify({ notes })
      });
      invalidateLeadDetailCache(lead.id);
      invalidateDashboardCache();
      setLeads((prev) => prev.map((item) => (item.id === lead.id ? { ...item, notes } : item)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Errore aggiornamento priorita.");
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search);
    }, 300);

    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    setScopeFilter(isAdmin ? "all" : "mine");
  }, [isAdmin]);

  useEffect(() => {
    if (!isAdmin && practiceView !== "active") {
      setPracticeView("active");
    }
  }, [isAdmin, practiceView]);

  useEffect(() => {
    loadPratiche().catch(() => null);
  }, [debouncedSearch, statusFilter]);

  useEffect(() => {
    if (practiceView === "active") return;
    if (documentFilter) setDocumentFilter(false);
    if (paymentFilter) setPaymentFilter(false);
  }, [practiceView, documentFilter, paymentFilter]);

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

  const getBaseScopeRows = (input: Lead[]) =>
    input.filter((lead) => {
      if (assignedFilter && String(lead.assignedTo || "") !== assignedFilter) return false;
      if (!isAdmin && !isLeadAssignedToCurrentUser(lead)) return false;
      if (scopeFilter === "mine" && !isLeadAssignedToCurrentUser(lead)) return false;
      return true;
    });

  const scopedRows = useMemo(() => getBaseScopeRows(leads), [leads, assignedFilter, scopeFilter, currentUserKeys]);
  const activeScopedRows = useMemo(
    () => scopedRows.filter((lead) => getPracticeViewFromStatus(lead.status) === "active"),
    [scopedRows]
  );
  const viewCounts = useMemo(
    () => ({
      active: activeScopedRows.length,
      ready: scopedRows.filter((lead) => getPracticeViewFromStatus(lead.status) === "ready").length,
      closed: scopedRows.filter((lead) => getPracticeViewFromStatus(lead.status) === "closed").length
    }),
    [activeScopedRows.length, scopedRows]
  );
  const viewScopedRows = useMemo(
    () => scopedRows.filter((lead) => getPracticeViewFromStatus(lead.status) === practiceView),
    [scopedRows, practiceView]
  );

  const rows = useMemo(
    () =>
      viewScopedRows.filter((lead) => {
        const priority = getPriority(lead);
        if (priorityFilter === "alta" || priorityFilter === "media" || priorityFilter === "bassa") {
          if (priority !== priorityFilter) return false;
        }
        if (priorityFilter === "overdue" && getOperationalBucket(lead) !== "overdue") return false;
        if (priorityFilter === "today" && getOperationalBucket(lead) !== "today") return false;
        if (
          priorityFilter === "callbacks" &&
          !includesAny(`${lead.status} ${lead.notes} ${lead.latestCallOutcome || ""}`.toLowerCase(), ["richiam", "call_back"])
        ) {
          return false;
        }
        if (callOutcomeFilter && String(lead.latestCallOutcome || "") !== callOutcomeFilter) return false;

        const stack = `${lead.status} ${lead.notes}`.toLowerCase();
        if (documentFilter && !includesAny(stack, ["document", "doc"])) return false;
        if (paymentFilter && !includesAny(stack, ["saldo", "pagament", "rata", "scaden"])) return false;
        return true;
      }),
    [viewScopedRows, priorityFilter, callOutcomeFilter, documentFilter, paymentFilter, primaryTaskByLeadId]
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
      if (practiceView === "closed") {
        const aTs = new Date(a.updatedAt || a.createdAt || 0).getTime();
        const bTs = new Date(b.updatedAt || b.createdAt || 0).getTime();
        return bTs - aTs;
      }

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
  }, [rows, primaryTaskByLeadId, practiceView]);

  const scopeCounts = useMemo(() => {
    const mine = leads.filter((lead) => isLeadAssignedToCurrentUser(lead)).length;
    return { mine, all: leads.length };
  }, [leads, currentUserKeys]);

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

  const modalAutoFollowUp = resolvedCallOutcome === "call_back" || resolvedCallOutcome === "no_answer";
  const modalClosedOutcome = resolvedCallOutcome === "not_interested";
  const isQuickDetailVisible = Boolean(selectedLeadId);
  const pageTitle =
    practiceView === "closed"
      ? "Archivio pratiche"
      : practiceView === "ready"
        ? "Pratiche pronte alla chiusura"
        : isAdmin
          ? "Pratiche del team"
          : "Il mio lavoro";
  const pageSubtitle =
    practiceView === "closed"
      ? "Storico delle pratiche completate, consultabili e riapribili se serve."
      : practiceView === "ready"
        ? "Ultimo controllo prima della chiusura definitiva del cliente."
        : isAdmin
          ? "Vista universale per controllare owner, contatti, SLA e prossime azioni del team."
          : "Qui trovi solo le pratiche assegnate a te e le priorita su cui muoverti oggi.";
  const emptyStateMessage =
    practiceView === "closed"
      ? "Nessuna pratica chiusa trovata con i filtri attuali."
      : practiceView === "ready"
        ? "Nessuna pratica pronta alla chiusura con i filtri attuali."
        : "Nessuna pratica trovata con i filtri attuali.";
  const viewHintText =
    practiceView === "ready"
      ? "Qui restano solo le pratiche che hanno completato checklist e attendono conferma finale."
      : practiceView === "closed"
        ? "Questa vista e pensata come archivio operativo: consulta, verifica e riapri solo quando serve."
        : "Qui lavori sulle pratiche attive, con priorita, follow-up e azioni operative ancora in corso.";

  return (
    <div className="pr-page">
      <section className="panel pr-main">
        <header className="pr-header">
          <div className="pr-header-groups">
            <div className="pr-header-copy">
              <h2>{pageTitle}</h2>
              <p>{pageSubtitle}</p>
            </div>

            <div className="pr-smart-badges">
              {isAdmin ? (
                <>
                  <span className="pr-smart-badge active">
                    Tutte le pratiche <span>{scopeCounts.all}</span>
                  </span>
                  <span className="pr-smart-badge">
                    Assegnate a me <span>{scopeCounts.mine}</span>
                  </span>
                </>
              ) : (
                <span className="pr-smart-badge active">
                  Assegnate a te <span>{scopeCounts.mine}</span>
                </span>
              )}
            </div>

            <div className={`pr-view-switcher ${isAdmin ? "" : "pr-view-switcher-operator"}`} role="tablist" aria-label="Vista pratiche">
              <button
                type="button"
                role="tab"
                aria-selected={practiceView === "active"}
                className={`pr-view-tile pr-view-tone-active ${practiceView === "active" ? "active" : ""}`}
                onClick={() => setPracticeView("active")}
              >
                <strong>Attive</strong>
                <span>{viewCounts.active} da lavorare</span>
              </button>
              {isAdmin ? (
                <button
                  type="button"
                  role="tab"
                  aria-selected={practiceView === "ready"}
                  className={`pr-view-tile pr-view-tone-ready ${practiceView === "ready" ? "active" : ""}`}
                  onClick={() => setPracticeView("ready")}
                >
                  <strong>Pronte</strong>
                  <span>{viewCounts.ready} in attesa chiusura</span>
                </button>
              ) : null}
              {isAdmin ? (
                <button
                  type="button"
                  role="tab"
                  aria-selected={practiceView === "closed"}
                  className={`pr-view-tile pr-view-tone-closed ${practiceView === "closed" ? "active" : ""}`}
                  onClick={() => setPracticeView("closed")}
                >
                  <strong>Archivio</strong>
                  <span>{viewCounts.closed} in archivio</span>
                </button>
              ) : null}
            </div>

            <p className="pr-view-hint">{viewHintText}</p>
          </div>
        </header>

        <div className={`pr-filters ${isAdmin ? "" : "pr-filters-compact"}`}>
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
          {isAdmin ? (
            <select value={assignedFilter} onChange={(e) => setAssignedFilter(e.target.value)}>
              <option value="">Tutti gli assegnati</option>
              {assignees.map((assignee) => (
                <option key={assignee} value={assignee}>
                  {assignee}
                </option>
              ))}
            </select>
          ) : null}
          <select value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value)}>
            <option value="">Tutte le priorita</option>
            <option value="alta">Alta</option>
            <option value="media">Media</option>
            <option value="bassa">Bassa</option>
            {practiceView === "active" ? (
              <>
                <option value="overdue">In ritardo</option>
                <option value="today">Da fare oggi</option>
                <option value="callbacks">Da richiamare</option>
              </>
            ) : null}
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
          <div className={`pr-filters pr-filters-extra ${practiceView === "active" ? "" : "pr-filters-extra-compact"}`}>
            <select value={callOutcomeFilter} onChange={(e) => setCallOutcomeFilter(e.target.value)}>
              <option value="">Tutti gli esiti chiamata</option>
              <option value="completed">Completata</option>
              <option value="no_answer">Nessuna risposta</option>
              <option value="busy">Occupato</option>
              <option value="call_back">Da richiamare</option>
              <option value="interested">Interessato</option>
              <option value="not_interested">Non interessato</option>
            </select>
            {practiceView === "active" ? (
              <>
                <label className="pr-check">
                  <input type="checkbox" checked={documentFilter} onChange={(e) => setDocumentFilter(e.target.checked)} />
                  Documenti mancanti
                </label>
                <label className="pr-check">
                  <input type="checkbox" checked={paymentFilter} onChange={(e) => setPaymentFilter(e.target.checked)} />
                  Pagamenti in scadenza
                </label>
              </>
            ) : null}
          </div>
        ) : null}

        {loading ? <p className="muted">Caricamento pratiche...</p> : null}
        {error ? <p className="pr-error">{error}</p> : null}

        <div className="pr-list">
          <div className="pr-list-head" aria-hidden="true">
            <span>Priorita</span>
            <span>Cliente</span>
            <span>Contatti</span>
            <span>Prossima azione</span>
            <span>SLA</span>
            <span>Owner</span>
          </div>
          {sortedRows.length ? (
            sortedRows.map((lead) => (
              <PracticeCard
                key={lead.id}
                lead={lead}
                linkedTask={primaryTaskByLeadId.get(lead.id) || null}
                isAdminView={isAdmin}
                isSelected={selectedLeadId === lead.id}
                isBusy={loading}
                availableStatuses={workflow?.flow[lead.status] || []}
                onSelect={handleSelectLead}
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
            <p className="muted pr-empty-list">{emptyStateMessage}</p>
          )}
        </div>
      </section>

      {isQuickDetailVisible ? <div className="pr-drawer-backdrop" onClick={handleCloseQuickDetail} /> : null}
      {isQuickDetailVisible ? (
        <aside className={`pr-sidebar ${selectedLeadId ? "open" : "closed"}`}>
          <PracticesQuickDetail lead={selectedLeadSummary} />
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
                  {callModalLead.fullName} - {callModalLead.phone || "-"}
                </p>
              </div>
            </div>

            <div className="pr-call-modal-grid">
              <div className="pr-call-choice-group">
                <span className="pr-call-choice-label">Esito chiamata</span>
                <div className="pr-call-choice-row" role="group" aria-label="Esito chiamata">
                  <button
                    type="button"
                    className={callConnection === "answered" ? "active" : ""}
                    onClick={() => selectCallConnection("answered")}
                  >
                    Ha risposto
                  </button>
                  <button
                    type="button"
                    className={callConnection === "no_answer" ? "active" : ""}
                    onClick={() => selectCallConnection("no_answer")}
                  >
                    Nessuna risposta
                  </button>
                  <button type="button" className={callConnection === "busy" ? "active" : ""} onClick={() => selectCallConnection("busy")}>
                    Occupato
                  </button>
                </div>
              </div>

              {callConnection === "answered" ? (
                <div className="pr-call-choice-group">
                  <span className="pr-call-choice-label">Esito cliente</span>
                  <div className="pr-call-choice-row pr-call-choice-row-four" role="group" aria-label="Esito cliente">
                    <button
                      type="button"
                      className={answeredCallOutcome === "interested" ? "active" : ""}
                      onClick={() => selectAnsweredCallOutcome("interested")}
                    >
                      Interessato
                    </button>
                    <button
                      type="button"
                      className={answeredCallOutcome === "call_back" ? "active" : ""}
                      onClick={() => selectAnsweredCallOutcome("call_back")}
                    >
                      Da richiamare
                    </button>
                    <button
                      type="button"
                      className={answeredCallOutcome === "not_interested" ? "active" : ""}
                      onClick={() => selectAnsweredCallOutcome("not_interested")}
                    >
                      Non interessato
                    </button>
                    <button
                      type="button"
                      className={answeredCallOutcome === "completed" ? "active" : ""}
                      onClick={() => selectAnsweredCallOutcome("completed")}
                    >
                      Contatto completato
                    </button>
                  </div>
                </div>
              ) : null}

              <label className="pr-call-modal-note">
                Nota breve
                <textarea
                  value={callNote}
                  onChange={(event) => setCallNote(event.target.value)}
                  placeholder="Aggiungi un appunto operativo sulla chiamata..."
                />
              </label>

              {modalAutoFollowUp ? (
                <>
                  <div className="pr-call-hint">
                    {resolvedCallOutcome === "call_back"
                      ? "Follow-up automatico: verra impostato un richiamo con la data selezionata."
                      : "Follow-up automatico: verra creato un richiamo per domani."}
                  </div>
                  {resolvedCallOutcome === "call_back" ? (
                    <label>
                      Data richiamo
                      <input type="datetime-local" value={callFollowUpAt} onChange={(event) => setCallFollowUpAt(event.target.value)} />
                    </label>
                  ) : null}
                </>
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
                  La pratica verra chiusa senza creare una prossima azione.
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

