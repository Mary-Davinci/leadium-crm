import { DragEvent, FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import {
  getLeadDetailCacheEntry,
  getTaskBoardCache,
  getUsersCache as getGlobalUsersCache,
  invalidateDashboardCache,
  isLeadDetailCacheFresh,
  isTaskBoardCacheFresh,
  isUsersCacheFresh,
  setLeadDetailCacheEntry,
  setTaskBoardCache,
  setUsersCache as setGlobalUsersCache,
  upsertTaskInBoard
} from "../store/crm-store";
import { buildPracticeUrl, getPracticeFocusFromTask, getPracticeUrlOptionsFromTask } from "../features/practices/practice-links";
import "../styles/leadboard-page.css";

type Lead = {
  id: string;
  fullName: string;
  phone: string;
  email?: string;
  source?: string;
  assignedTo?: string;
  notes?: string;
  documents?: {
    items: Array<{
      key: string;
      required: boolean;
      received: boolean;
      verified: boolean;
    }>;
  };
  status: string;
  nextActionAt?: string | null;
};

type TimelineItem = {
  type: string;
  text: string;
  actor: string;
  createdAt: string;
};

type LeadDetail = {
  lead: Lead;
  timeline: TimelineItem[];
};

type TaskBoardPayload = {
  tasks: Task[];
  leads: Lead[];
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
  meta?: Record<string, unknown> | null;
};

type BoardTask = Task & {
  sourceLabel: string;
  kindLabel: string;
};

type UserItem = {
  id: string;
  username: string;
  name: string;
  role: "super_admin" | "admin" | "operatore";
  email?: string;
};

type Toast = { type: "success" | "error"; text: string } | null;
type TaskLaneKey = "overdue" | "today" | "planned" | "done";
type PriorityKey = "alta" | "media" | "bassa";

type EditDraft = {
  title: string;
  description: string;
  dueAt: string;
  assignedTo: string;
  priority: number;
  kind: string;
  source: string;
};

const TASK_LANES: Array<{ key: TaskLaneKey; label: string; className: string; emptyLabel: string }> = [
  { key: "overdue", label: "Scaduti", className: "lane-overdue", emptyLabel: "Nessun task scaduto." },
  { key: "today", label: "Oggi", className: "lane-today", emptyLabel: "Nessun task per oggi." },
  { key: "planned", label: "Pianificati", className: "lane-planned", emptyLabel: "Nessun task pianificato." },
  { key: "done", label: "Completati", className: "lane-done", emptyLabel: "Nessun task completato." }
];

const PRIORITY_OPTIONS: Array<{ key: PriorityKey; label: string; value: number }> = [
  { key: "alta", label: "Alta priorità", value: 90 },
  { key: "media", label: "Media priorità", value: 60 },
  { key: "bassa", label: "Bassa priorità", value: 30 }
];

const COMPLETED_LANE_LIMIT = 20;
const USERS_CACHE_KEY = "leadium_task_users_cache";
const USERS_CACHE_TTL_MS = 10 * 60 * 1000;
const LEAD_DETAIL_CACHE_TTL_MS = 5 * 60 * 1000;
let usersCache: UserItem[] | null = null;
const leadDetailCache = new Map<string, LeadDetail>();

function readUsersCacheStorage() {
  try {
    const raw = window.sessionStorage.getItem(USERS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { expiresAt: number; data: UserItem[] };
    if (!parsed?.expiresAt || parsed.expiresAt < Date.now() || !Array.isArray(parsed.data)) {
      window.sessionStorage.removeItem(USERS_CACHE_KEY);
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

function writeUsersCacheStorage(data: UserItem[]) {
  try {
    window.sessionStorage.setItem(
      USERS_CACHE_KEY,
      JSON.stringify({
        expiresAt: Date.now() + USERS_CACHE_TTL_MS,
        data
      })
    );
  } catch {}
}

function getLeadDetailCacheKey(leadId: string) {
  return `leadium_task_lead_detail_${leadId}`;
}

function readLeadDetailCacheStorage(leadId: string) {
  try {
    const raw = window.sessionStorage.getItem(getLeadDetailCacheKey(leadId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { expiresAt: number; data: LeadDetail };
    if (!parsed?.expiresAt || parsed.expiresAt < Date.now() || !parsed.data) {
      window.sessionStorage.removeItem(getLeadDetailCacheKey(leadId));
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

function writeLeadDetailCacheStorage(leadId: string, data: LeadDetail) {
  try {
    window.sessionStorage.setItem(
      getLeadDetailCacheKey(leadId),
      JSON.stringify({
        expiresAt: Date.now() + LEAD_DETAIL_CACHE_TTL_MS,
        data
      })
    );
  } catch {}
}

function normalizeLead(input: Lead): Lead {
  return {
    ...input,
    id: String(input?.id || ""),
    fullName: String(input?.fullName || "Cliente senza nome"),
    phone: String(input?.phone || "-"),
    email: String(input?.email || ""),
    source: String(input?.source || ""),
    assignedTo: String(input?.assignedTo || ""),
    notes: String(input?.notes || ""),
    documents: input?.documents && Array.isArray(input.documents.items) ? input.documents : { items: [] },
    status: String(input?.status || "Da contattare"),
    nextActionAt: input?.nextActionAt ? String(input.nextActionAt) : null
  };
}

function getMissingDocumentsCount(lead?: Lead | null) {
  const items = Array.isArray(lead?.documents?.items) ? lead?.documents?.items : [];
  return items.filter((item) => item.required && (!item.received || !item.verified)).length;
}

function normalizeTask(input: Task): Task {
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

function formatDate(value?: string | null) {
  if (!value) return "Da pianificare";
  return new Date(value).toLocaleString("it-IT");
}

function toDateTimeLocalValue(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  const offset = date.getTimezoneOffset();
  const local = new Date(date.getTime() - offset * 60_000);
  return local.toISOString().slice(0, 16);
}

function formatShortDate(value?: string | null) {
  if (!value) return "Da pianificare";
  return new Date(value).toLocaleDateString("it-IT", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function getTaskLane(task: Task): TaskLaneKey {
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

function getTaskBadge(task: Task): { label: string; tone: TaskLaneKey } {
  const lane = getTaskLane(task);
  if (lane === "overdue") return { label: "Scaduto", tone: "overdue" };
  if (lane === "today") return { label: "Oggi", tone: "today" };
  if (lane === "done") return { label: "Completato", tone: "done" };
  return { label: task.dueAt ? "Pianificato" : "Da pianificare", tone: "planned" };
}

function getTaskStatusLabel(task: Task) {
  if (task.status === "done") return "Completato";
  if (task.status === "dismissed") return "Annullato";
  return "Attivo";
}

function getTimelineMeta(type: string): { icon: string; label: string } {
  const value = String(type || "").toLowerCase();
  if (value.includes("call")) return { icon: "📞", label: "Chiamata" };
  if (value.includes("status")) return { icon: "🔄", label: "Cambio stato" };
  if (value.includes("task")) return { icon: "✅", label: "Task" };
  if (value.includes("lead_updated")) return { icon: "📝", label: "Aggiornamento" };
  if (value.includes("lead_created")) return { icon: "✨", label: "Creazione" };
  if (value.includes("payment")) return { icon: "💳", label: "Pagamento" };
  return { icon: "•", label: type || "Evento" };
}

function normalizeTimelineText(text: string) {
  const value = String(text || "").trim();
  if (!value) return "Attività registrata.";
  return value.replace(/\s+/g, " ");
}

function humanizeDisposition(value: string) {
  const normalized = String(value || "").toLowerCase();
  if (normalized.includes("completed")) return "completata";
  if (normalized.includes("no_answer")) return "senza risposta";
  if (normalized.includes("busy")) return "occupato";
  if (normalized.includes("call_back")) return "da richiamare";
  if (normalized.includes("interested")) return "interessato";
  if (normalized.includes("not_interested")) return "non interessato";
  return normalized || "registrata";
}

function humanizeTimelineText(item: TimelineItem) {
  const type = String(item.type || "").toLowerCase();
  const text = normalizeTimelineText(item.text);

  if (type.includes("lead_created")) return "Lead creata e presa in carico.";
  if (type.includes("lead_updated")) return "Anagrafica lead aggiornata.";

  if (type.includes("status")) {
    const match = text.match(/da\s+"?([^"]+)"?\s+a\s+"?([^"]+)"?/i);
    if (match) return `Stato aggiornato da ${match[1]} a ${match[2]}.`;
    return "Stato della pratica aggiornato.";
  }

  if (type.includes("call")) {
    const dispositionMatch = text.match(/\(([^)]+)\)/);
    if (dispositionMatch) return `Chiamata ${humanizeDisposition(dispositionMatch[1])}.`;
    return "Chiamata registrata.";
  }

  if (type.includes("task")) {
    if (/richiam/i.test(text)) return "Creato task di richiamo.";
    if (/preventiv/i.test(text)) return "Creato task preventivo.";
    if (/document/i.test(text)) return "Creato task documenti.";
    return "Attività operativa registrata.";
  }

  return text;
}

function getCleanTimelineItems(items: TimelineItem[] = []) {
  const sorted = items.slice().reverse();
  const compact: TimelineItem[] = [];

  for (const item of sorted) {
    const previous = compact[compact.length - 1];
    const isDuplicateUpdate =
      previous &&
      previous.type === item.type &&
      normalizeTimelineText(previous.text) === normalizeTimelineText(item.text) &&
      previous.actor === item.actor &&
      Math.abs(new Date(previous.createdAt).getTime() - new Date(item.createdAt).getTime()) < 2 * 60 * 1000;

    if (isDuplicateUpdate) continue;
    compact.push({
      ...item,
      text: humanizeTimelineText(item)
    });
    if (compact.length >= 5) break;
  }

  return compact;
}

function getTimelineSecondaryMeta(item: TimelineItem) {
  const parts: string[] = [];
  if (item.actor) parts.push(item.actor);
  parts.push(formatDate(item.createdAt));
  return parts.join(" · ");
}

function getKindLabel(kind: string) {
  const value = String(kind || "").toLowerCase();
  if (value.includes("next_action")) return "Prossima azione";
  if (value.includes("follow")) return "Follow-up";
  if (value.includes("call")) return "Richiamo";
  if (value.includes("payment") || value.includes("saldo")) return "Pagamento";
  if (value.includes("document")) return "Documenti";
  if (value.includes("manual")) return "Manuale";
  if (value.includes("sla")) return "SLA";
  return "Task";
}

function getSourceLabel(source: string) {
  const value = String(source || "").toLowerCase();
  if (!value) return "Manuale";
  if (value.includes("leadboard") || value.includes("task-board")) return "Board task";
  if (value.includes("pratiche")) return "Pratiche";
  if (value.includes("automation")) return "Automazione";
  if (value.includes("scheduler")) return "Scheduler";
  if (value.includes("dashboard")) return "Dashboard";
  if (value.includes("manual")) return "Manuale";
  return source;
}

function getPriorityMeta(priority: number) {
  if (priority >= 80) return { key: "alta" as const, label: "Alta priorità" };
  if (priority >= 50) return { key: "media" as const, label: "Media priorità" };
  return { key: "bassa" as const, label: "Bassa priorità" };
}

function getDropPayload(targetLane: TaskLaneKey) {
  const now = new Date();
  if (targetLane === "done") return { status: "done" as const, dueAt: null };
  if (targetLane === "overdue") {
    return { status: "open" as const, dueAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString() };
  }
  if (targetLane === "today") {
    const due = new Date(now);
    due.setHours(Math.max(now.getHours() + 1, 10), 0, 0, 0);
    return { status: "open" as const, dueAt: due.toISOString() };
  }
  const due = new Date(now);
  due.setDate(now.getDate() + 1);
  due.setHours(9, 0, 0, 0);
  return { status: "open" as const, dueAt: due.toISOString() };
}

function buildQuickPostponePayload(mode: "plus1hour" | "plus1day" | "tomorrowMorning") {
  const due = new Date();
  if (mode === "plus1hour") {
    due.setHours(due.getHours() + 1, 0, 0, 0);
  } else if (mode === "plus1day") {
    due.setDate(due.getDate() + 1);
  } else {
    due.setDate(due.getDate() + 1);
    due.setHours(9, 0, 0, 0);
  }
  return { status: "open" as const, dueAt: due.toISOString() };
}

export function LeadBoardPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [users, setUsers] = useState<UserItem[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedLeadDetail, setSelectedLeadDetail] = useState<LeadDetail | null>(null);
  const [detailActivated, setDetailActivated] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [completedVisibleCount, setCompletedVisibleCount] = useState(COMPLETED_LANE_LIMIT);
  const [search, setSearch] = useState("");
  const [assignedFilter, setAssignedFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [kindFilter, setKindFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [savingTaskId, setSavingTaskId] = useState<string | null>(null);
  const [dragLane, setDragLane] = useState<TaskLaneKey | null>(null);
  const [dragTaskId, setDragTaskId] = useState<string | null>(null);
  const [editTask, setEditTask] = useState<BoardTask | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [toast, setToast] = useState<Toast>(null);

  function showToast(type: "success" | "error", text: string) {
    setToast({ type, text });
  }

  async function loadBoardData() {
    const globalBoard = getTaskBoardCache();
    const globalUsers = getGlobalUsersCache();
    const storageUsers = !usersCache ? readUsersCacheStorage() : null;
    const usersSnapshot = globalUsers?.data || usersCache || storageUsers || [];

    if (globalBoard?.data) {
      setTasks(globalBoard.data.tasks.map(normalizeTask));
      setLeads(globalBoard.data.leads.map(normalizeLead));
    }
    if (usersSnapshot.length) {
      setUsers(usersSnapshot);
    }

    if (isTaskBoardCacheFresh() && isUsersCacheFresh()) {
      setLoading(false);
      return;
    }

    setLoading(!globalBoard?.data);
    try {
      const [boardData, usersData] = await Promise.all([
        api<TaskBoardPayload>("/api/tasks/board"),
        globalUsers?.data && isUsersCacheFresh()
          ? Promise.resolve(globalUsers.data)
          : usersCache
            ? Promise.resolve(usersCache)
            : storageUsers
              ? Promise.resolve(storageUsers)
              : api<UserItem[]>("/api/users")
      ]);
      const normalizedTasks = (Array.isArray(boardData?.tasks) ? boardData.tasks : []).map(normalizeTask);
      const normalizedLeads = (Array.isArray(boardData?.leads) ? boardData.leads : []).map(normalizeLead);
      setTaskBoardCache(normalizedTasks, normalizedLeads);
      setTasks(normalizedTasks);
      setLeads(normalizedLeads);
      usersCache = Array.isArray(usersData) ? usersData : [];
      writeUsersCacheStorage(usersCache);
      setGlobalUsersCache(usersCache);
      setUsers(usersCache);
    } finally {
      setLoading(false);
    }
  }

  async function loadLeadDetail(leadId?: string) {
    if (!leadId) {
      setSelectedLeadDetail(null);
      return;
    }
    const cached = leadDetailCache.get(leadId);
    if (cached) {
      setLeadDetailCacheEntry(leadId, cached);
      setSelectedLeadDetail(cached);
      setDetailLoading(false);
      return;
    }
    const globalCached = getLeadDetailCacheEntry(leadId);
    if (globalCached && isLeadDetailCacheFresh(leadId)) {
      leadDetailCache.set(leadId, globalCached.data);
      setSelectedLeadDetail(globalCached.data);
      setDetailLoading(false);
      return;
    }
    const storageCached = readLeadDetailCacheStorage(leadId);
    if (storageCached) {
      leadDetailCache.set(leadId, storageCached);
      setLeadDetailCacheEntry(leadId, storageCached);
      setSelectedLeadDetail(storageCached);
      setDetailLoading(false);
      return;
    }
    try {
      setDetailLoading(true);
      const payload = await api<LeadDetail>(`/api/leads/${leadId}`);
      leadDetailCache.set(leadId, payload);
      writeLeadDetailCacheStorage(leadId, payload);
      setLeadDetailCacheEntry(leadId, payload);
      setSelectedLeadDetail(payload);
    } catch (error) {
      showToast("error", error instanceof Error ? error.message : "Errore caricamento pratica collegata.");
    } finally {
      setDetailLoading(false);
    }
  }

  async function prefetchLeadDetail(leadId?: string) {
    if (!leadId) return;
    if (isLeadDetailCacheFresh(leadId) && getLeadDetailCacheEntry(leadId)?.data) return;
    if (leadDetailCache.has(leadId)) return;
    try {
      const payload = await api<LeadDetail>(`/api/leads/${leadId}`);
      leadDetailCache.set(leadId, payload);
      writeLeadDetailCacheStorage(leadId, payload);
      setLeadDetailCacheEntry(leadId, payload);
    } catch {}
  }

  async function patchTask(taskId: string, payload: Partial<Task>, successText: string) {
    setSavingTaskId(taskId);
    try {
      const updated = normalizeTask(
        await api<Task>(`/api/tasks/${taskId}`, {
          method: "PATCH",
          body: JSON.stringify(payload)
        })
      );
      upsertTaskInBoard(updated);
      invalidateDashboardCache();
      setTasks((prev) => prev.map((task) => (task.id === taskId ? updated : task)));
      if (detailActivated && selectedTaskId === taskId && updated.leadId) await loadLeadDetail(updated.leadId);
      showToast("success", successText);
      return updated;
    } catch (error) {
      showToast("error", error instanceof Error ? error.message : "Errore aggiornamento task.");
      return null;
    } finally {
      setSavingTaskId(null);
    }
  }

  async function handleCompleteTask(task: BoardTask) {
    await patchTask(task.id, { status: "done" }, "Task completato.");
  }

  async function handleReopenTask(task: BoardTask) {
    const fallbackDueAt = task.dueAt || (() => {
      const due = new Date();
      due.setDate(due.getDate() + 1);
      due.setHours(9, 0, 0, 0);
      return due.toISOString();
    })();
    await patchTask(task.id, { status: "open", dueAt: fallbackDueAt }, "Task riaperto.");
  }

  function handleOpenEdit(task: BoardTask) {
    setEditTask(task);
    setEditDraft({
      title: task.title,
      description: task.description || "",
      dueAt: toDateTimeLocalValue(task.dueAt),
      assignedTo: task.assignedTo || "",
      priority: task.priority,
      kind: task.kind,
      source: task.source || ""
    });
  }

  async function handleSaveEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editTask || !editDraft) return;
    const updated = await patchTask(
      editTask.id,
      {
        title: editDraft.title.trim() || editTask.title,
        description: editDraft.description.trim(),
        dueAt: editDraft.dueAt ? new Date(editDraft.dueAt).toISOString() : null,
        assignedTo: editDraft.assignedTo.trim(),
        priority: Number(editDraft.priority || editTask.priority),
        kind: editDraft.kind
      },
      "Task aggiornato."
    );
    if (updated) {
      setEditTask(null);
      setEditDraft(null);
    }
  }

  async function handleCreateTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const created = normalizeTask(
        await api<Task>("/api/tasks", {
          method: "POST",
          body: JSON.stringify({
            leadId: form.get("leadId") ? String(form.get("leadId")) : undefined,
            assignedTo: String(form.get("assignedTo") || ""),
            kind: "manual_task",
            title: String(form.get("title") || ""),
            description: String(form.get("description") || ""),
            source: "task-board",
            status: "open",
            priority: 60,
            dueAt: form.get("dueAt") ? new Date(String(form.get("dueAt"))).toISOString() : null
          })
        })
      );
      upsertTaskInBoard(created);
      invalidateDashboardCache();
      setTasks((prev) => [created, ...prev]);
      setSelectedTaskId(created.id);
      setDetailActivated(true);
      event.currentTarget.reset();
      setFormOpen(false);
      await loadLeadDetail(created.leadId);
      showToast("success", "Task creato correttamente.");
    } catch (error) {
      showToast("error", error instanceof Error ? error.message : "Errore creazione task.");
    }
  }

  function handleOpenPractice(task: BoardTask) {
    if (!task.leadId) {
      showToast("error", "Task non collegato a una pratica.");
      return;
    }
    navigate(buildPracticeUrl(task.leadId, getPracticeFocusFromTask(task), getPracticeUrlOptionsFromTask(task)));
  }

  function handleCallTask(task: BoardTask, lead?: Lead) {
    const phone = String(lead?.phone || "").trim();
    if (!phone) {
      showToast("error", "La pratica collegata non ha un numero disponibile.");
      return;
    }
    window.location.href = `tel:${phone}`;
  }

  async function handleDropLane(task: BoardTask, lane: TaskLaneKey) {
    const currentLane = getTaskLane(task);
    if (currentLane === lane) return;
    const payload = getDropPayload(lane);
    await patchTask(task.id, payload, `Task spostato in ${TASK_LANES.find((item) => item.key === lane)?.label || lane}.`);
  }

  async function handlePriorityDrop(taskId: string, priority: number, label: string) {
    await patchTask(taskId, { priority }, `Task aggiornato in ${label}.`);
  }

  async function handleAssignDrop(taskId: string, assignedTo: string) {
    await patchTask(taskId, { assignedTo }, `Task assegnato a ${assignedTo || "nessuno"}.`);
  }

  async function handleQuickPostpone(task: BoardTask, mode: "plus1hour" | "plus1day" | "tomorrowMorning") {
    const labels = {
      plus1hour: "+1 ora",
      plus1day: "+1 giorno",
      tomorrowMorning: "domani mattina"
    } as const;
    await patchTask(task.id, buildQuickPostponePayload(mode), `Task posticipato a ${labels[mode]}.`);
  }

  useEffect(() => {
    loadBoardData().catch((error: Error) => showToast("error", error.message));
  }, []);

  useEffect(() => {
    const lane = searchParams.get("lane");
    if (!lane) return;
    const isValidLane = TASK_LANES.some((item) => item.key === lane);
    if (isValidLane) {
      setStatusFilter(lane);
    }
  }, [searchParams]);

  useEffect(() => {
    setCompletedVisibleCount(COMPLETED_LANE_LIMIT);
  }, [search, assignedFilter, statusFilter, kindFilter, sourceFilter]);

  useEffect(() => {
    if (!toast) return;
    const timeout = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      const target = event.target as (HTMLElement & { tagName?: string }) | null;
      const tag = String(target?.tagName || "").toLowerCase();
      const isTypingField = tag === "input" || tag === "textarea" || tag === "select" || Boolean(target?.isContentEditable);
      if (!isTypingField && event.key === "/") {
        event.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      if (!isTypingField && (event.key === "n" || event.key === "N")) {
        event.preventDefault();
        setFormOpen((prev) => !prev);
      }
      if (!isTypingField && event.key === "Escape") {
        setEditTask(null);
        setEditDraft(null);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const leadMap = useMemo(() => new Map(leads.map((lead) => [lead.id, lead])), [leads]);

  const boardTasks = useMemo<BoardTask[]>(
    () =>
      tasks.map((task) => ({
        ...task,
        sourceLabel: getSourceLabel(task.source || ""),
        kindLabel: getKindLabel(task.kind)
      })),
    [tasks]
  );

  const assignees = useMemo(() => {
    const values = new Map<string, string>();
    const pushValue = (value?: string) => {
      const trimmed = String(value || "").trim();
      if (!trimmed) return;
      const normalized = trimmed.toLocaleLowerCase("it");
      if (!values.has(normalized)) values.set(normalized, trimmed);
    };

    users.forEach((user) => {
      pushValue(user.name || user.username);
    });
    boardTasks.forEach((task) => {
      pushValue(task.assignedTo);
    });
    leads.forEach((lead) => {
      pushValue(lead.assignedTo);
    });
    return Array.from(values.values()).sort((a, b) => a.localeCompare(b, "it"));
  }, [boardTasks, leads, users]);

  const kindOptions = useMemo(
    () => Array.from(new Set(boardTasks.map((task) => task.kindLabel))).sort((a, b) => a.localeCompare(b, "it")),
    [boardTasks]
  );

  const sourceOptions = useMemo(
    () => Array.from(new Set(boardTasks.map((task) => task.sourceLabel))).sort((a, b) => a.localeCompare(b, "it")),
    [boardTasks]
  );

  const filteredTasks = useMemo(() => {
    const query = search.trim().toLowerCase();
    return boardTasks.filter((task) => {
      const lead = task.leadId ? leadMap.get(task.leadId) : undefined;
      const haystack = [
        task.title,
        task.description,
        task.kind,
        task.assignedTo,
        task.sourceLabel,
        task.kindLabel,
        lead?.fullName,
        lead?.phone,
        lead?.status
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      if (query && !haystack.includes(query)) return false;
      if (assignedFilter && String(task.assignedTo || lead?.assignedTo || "") !== assignedFilter) return false;
      if (statusFilter && getTaskLane(task) !== statusFilter) return false;
      if (kindFilter && task.kindLabel !== kindFilter) return false;
      if (sourceFilter && task.sourceLabel !== sourceFilter) return false;
      return true;
    });
  }, [boardTasks, leadMap, search, assignedFilter, statusFilter, kindFilter, sourceFilter]);

  const groupedByLane = useMemo(() => {
    const grouped: Record<TaskLaneKey, BoardTask[]> = { overdue: [], today: [], planned: [], done: [] };
    filteredTasks.forEach((task) => {
      grouped[getTaskLane(task)].push(task);
    });
    (Object.keys(grouped) as TaskLaneKey[]).forEach((lane) => {
      grouped[lane].sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        const aTime = new Date(a.dueAt || a.createdAt).getTime();
        const bTime = new Date(b.dueAt || b.createdAt).getTime();
        return aTime - bTime;
      });
    });
    return grouped;
  }, [filteredTasks]);

  const displayedByLane = useMemo(() => {
    return {
      overdue: groupedByLane.overdue,
      today: groupedByLane.today,
      planned: groupedByLane.planned,
      done: groupedByLane.done.slice(0, completedVisibleCount)
    } satisfies Record<TaskLaneKey, BoardTask[]>;
  }, [groupedByLane, completedVisibleCount]);

  const sortedVisibleTasks = useMemo(() => {
    return [...filteredTasks].sort((a, b) => {
      const laneOrder: Record<TaskLaneKey, number> = { overdue: 0, today: 1, planned: 2, done: 3 };
      const laneDiff = laneOrder[getTaskLane(a)] - laneOrder[getTaskLane(b)];
      if (laneDiff !== 0) return laneDiff;
      if (b.priority !== a.priority) return b.priority - a.priority;
      const aTime = new Date(a.dueAt || a.createdAt).getTime();
      const bTime = new Date(b.dueAt || b.createdAt).getTime();
      return aTime - bTime;
    });
  }, [filteredTasks]);

  const selectedTask =
    (selectedTaskId ? boardTasks.find((task) => task.id === selectedTaskId) : null) || sortedVisibleTasks[0] || null;

  useEffect(() => {
    if (!selectedTask && selectedTaskId) {
      setSelectedTaskId(null);
      setSelectedLeadDetail(null);
    }
  }, [selectedTask, selectedTaskId]);

  useEffect(() => {
    if (!selectedTask) {
      setSelectedLeadDetail(null);
      setDetailLoading(false);
      return;
    }
    if (selectedTaskId !== selectedTask.id) {
      setSelectedTaskId(selectedTask.id);
    }
    if (!detailActivated) {
      setSelectedLeadDetail(null);
      setDetailLoading(false);
      return;
    }
    setSelectedLeadDetail((current) => (selectedTask.leadId && current?.lead?.id === selectedTask.leadId ? current : null));
    const timeout = window.setTimeout(() => {
      loadLeadDetail(selectedTask.leadId).catch(() => null);
    }, 180);
    return () => window.clearTimeout(timeout);
  }, [selectedTask?.id, detailActivated]);

  function handleCardKeyDown(event: KeyboardEvent<HTMLElement>, taskId: string) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setDetailActivated(true);
      setSelectedTaskId(taskId);
    }
  }

  function handleDragStart(event: DragEvent<HTMLElement>, task: BoardTask) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", task.id);
    setDragTaskId(task.id);
  }

  function resolveDraggedTask(event: DragEvent<HTMLElement>) {
    const taskId = event.dataTransfer.getData("text/plain") || dragTaskId;
    return boardTasks.find((item) => item.id === taskId) || null;
  }

  function resetDragState() {
    setDragLane(null);
    setDragTaskId(null);
  }

  function handleLaneDrop(event: DragEvent<HTMLElement>, lane: TaskLaneKey) {
    event.preventDefault();
    const task = resolveDraggedTask(event);
    resetDragState();
    if (!task) return;
    void handleDropLane(task, lane);
  }

  return (
    <div className="lb-layout">
      {toast ? (
        <div className={`lb-toast lb-toast-${toast.type}`} role="status" aria-live="polite">
          {toast.text}
        </div>
      ) : null}

      {editTask && editDraft ? (
        <div
          className="lb-modal-overlay"
          onClick={() => {
            setEditTask(null);
            setEditDraft(null);
          }}
        >
          <div className="lb-modal" onClick={(event) => event.stopPropagation()}>
            <div className="lb-modal-head">
              <h3>Modifica Task</h3>
              <button
                type="button"
                className="lb-modal-close"
                onClick={() => {
                  setEditTask(null);
                  setEditDraft(null);
                }}
              >
                ×
              </button>
            </div>
            <form className="lb-modal-form" onSubmit={handleSaveEdit}>
              <label>
                <span>Titolo</span>
                <input
                  value={editDraft.title}
                  onChange={(event) => setEditDraft((prev) => (prev ? { ...prev, title: event.target.value } : prev))}
                />
              </label>
              <label>
                <span>Scadenza</span>
                <input
                  type="datetime-local"
                  value={editDraft.dueAt}
                  onChange={(event) => setEditDraft((prev) => (prev ? { ...prev, dueAt: event.target.value } : prev))}
                />
              </label>
              <label>
                <span>Assegnato a</span>
                <select
                  value={editDraft.assignedTo}
                  onChange={(event) => setEditDraft((prev) => (prev ? { ...prev, assignedTo: event.target.value } : prev))}
                >
                  <option value="">Non assegnato</option>
                  {users.map((user) => {
                    const optionValue = user.name?.trim() || user.username;
                    return (
                      <option key={user.id} value={optionValue}>
                        {user.name || user.username} · {user.role}
                      </option>
                    );
                  })}
                </select>
              </label>
              <label>
                <span>Priorità</span>
                <select
                  value={String(editDraft.priority)}
                  onChange={(event) =>
                    setEditDraft((prev) => (prev ? { ...prev, priority: Number(event.target.value) } : prev))
                  }
                >
                  {PRIORITY_OPTIONS.map((item) => (
                    <option key={item.key} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Tipo</span>
                <select
                  value={editDraft.kind}
                  onChange={(event) => setEditDraft((prev) => (prev ? { ...prev, kind: event.target.value } : prev))}
                >
                  {Array.from(new Set(boardTasks.map((task) => task.kind))).sort((a, b) => a.localeCompare(b, "it")).map((kind) => (
                    <option key={kind} value={kind}>
                      {getKindLabel(kind)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Origine</span>
                <input value={getSourceLabel(editDraft.source)} readOnly />
              </label>
              <label className="wide">
                <span>Descrizione</span>
                <textarea
                  rows={4}
                  value={editDraft.description}
                  onChange={(event) =>
                    setEditDraft((prev) => (prev ? { ...prev, description: event.target.value } : prev))
                  }
                />
              </label>
              <div className="lb-modal-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setEditTask(null);
                    setEditDraft(null);
                  }}
                >
                  Annulla
                </button>
                <button type="submit" disabled={savingTaskId === editTask.id}>
                  Salva task
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

<section className="lb-main">
        <div className="panel">
          <div className="lb-toolbar">
            <input
              ref={searchInputRef}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Cerca task, cliente, telefono..."
              title='Shortcut: "/"'
            />
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
              <option value="">Tutti gli stati task</option>
              {TASK_LANES.map((lane) => (
                <option key={lane.key} value={lane.key}>
                  {lane.label}
                </option>
              ))}
            </select>
            <select value={assignedFilter} onChange={(event) => setAssignedFilter(event.target.value)}>
              <option value="">Tutti gli assegnati</option>
              {assignees.map((assignee) => (
                <option key={assignee} value={assignee}>
                  {assignee}
                </option>
              ))}
            </select>
            <select value={kindFilter} onChange={(event) => setKindFilter(event.target.value)}>
              <option value="">Tutti i tipi task</option>
              {kindOptions.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
            <select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)}>
              <option value="">Tutte le origini</option>
              {sourceOptions.map((source) => (
                <option key={source} value={source}>
                  {source}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => setFormOpen((prev) => !prev)} title='Shortcut: "N"'>
              + Aggiungi Task
            </button>
          </div>
          <p className="lb-shortcuts-hint muted">Shortcut: "/" ricerca, "N" nuovo task</p>
          {loading ? <p className="muted">Caricamento task...</p> : null}
        </div>

        {formOpen ? (
          <form className="panel lb-form" onSubmit={handleCreateTask}>
            <input required name="title" placeholder="Titolo task" />
            <select name="leadId" defaultValue="">
              <option value="">Seleziona pratica collegata</option>
              {leads.map((lead) => (
                <option key={lead.id} value={lead.id}>
                  {lead.fullName} · {lead.phone}
                </option>
              ))}
            </select>
            <select name="assignedTo" defaultValue="">
              <option value="">Non assegnato</option>
              {users.map((user) => {
                const optionValue = user.name?.trim() || user.username;
                return (
                  <option key={user.id} value={optionValue}>
                    {user.name || user.username} · {user.role}
                  </option>
                );
              })}
            </select>
            <input type="datetime-local" name="dueAt" />
            <textarea name="description" rows={3} placeholder="Descrizione task" />
            <button type="submit">Crea Task</button>
          </form>
        ) : null}

        <div className="lb-board">
          {TASK_LANES.map((lane) => (
            <section
              key={lane.key}
              className={`lb-lane ${lane.className} ${selectedTask && getTaskLane(selectedTask) === lane.key ? "active" : ""} ${
                dragLane === lane.key ? "drag-target" : ""
              }`}
              onDragOver={(event) => {
                event.preventDefault();
                setDragLane(lane.key);
              }}
              onDragLeave={() => setDragLane((current) => (current === lane.key ? null : current))}
              onDrop={(event) => handleLaneDrop(event, lane.key)}
            >
              <header className="lb-lane-head">
                <h4>{lane.label}</h4>
                <span>{groupedByLane[lane.key].length}</span>
              </header>
              <div className="lb-lane-body">
                {displayedByLane[lane.key].length ? (
                  displayedByLane[lane.key].map((task) => {
                    const lead = task.leadId ? leadMap.get(task.leadId) : undefined;
                    const badge = getTaskBadge(task);
                    const linkedStatus = lead?.status ? lead.status : "Nessuna pratica collegata";
                    const priorityMeta = getPriorityMeta(task.priority);
                    const missingDocumentsCount = getMissingDocumentsCount(lead);
                    return (
                      <article
                        key={task.id}
                        className={`lb-card ${selectedTask?.id === task.id ? "selected" : ""}`}
                        onClick={() => {
                          setDetailActivated(true);
                          setSelectedTaskId(task.id);
                        }}
                        onMouseEnter={() => prefetchLeadDetail(task.leadId)}
                        onDoubleClick={() => {
                          setDetailActivated(true);
                          handleOpenEdit(task);
                        }}
                        role="button"
                        tabIndex={0}
                        draggable
                        onDragStart={(event) => handleDragStart(event, task)}
                        onDragEnd={resetDragState}
                        onKeyDown={(event) => handleCardKeyDown(event, task.id)}
                        aria-label={`Apri task ${task.title}`}
                      >
                        <div className="lb-card-row row-1">
                          <div className="lb-card-title-wrap">
                            <strong className="lb-task-title">{task.title}</strong>
                            <span className={`lb-chip lb-chip-${badge.tone}`}>{badge.label}</span>
                          </div>
                        </div>

                        <div className="lb-card-row row-2 lb-stack">
                          <span className="lb-link-lead">{lead ? lead.fullName : "Task non collegato"}</span>
                          <span>{lead?.phone || "Senza telefono"}</span>
                        </div>

                        <div className="lb-card-row row-3 lb-stack">
                          <small>Scadenza: {formatShortDate(task.dueAt)}</small>
                          <small>Assegnato: {task.assignedTo || lead?.assignedTo || "Non assegnato"}</small>
                          <small>Stato: {getTaskStatusLabel(task)} · Pratica: {linkedStatus}</small>
                        </div>

                        <div className="lb-card-tags">
                          <span className={`lb-tag priority-${priorityMeta.key}`}>{priorityMeta.label}</span>
                          <span className="lb-tag">{task.kindLabel}</span>
                          <span className="lb-tag subtle">{task.sourceLabel}</span>
                          {missingDocumentsCount > 0 ? <span className="lb-tag warning">⚠ Documenti ({missingDocumentsCount})</span> : null}
                        </div>

                        <div className="lb-card-row row-4">
                          {task.status === "done" ? (
                            <button
                              type="button"
                              className="lb-action-btn"
                              disabled={savingTaskId === task.id}
                              onClick={(event) => {
                                event.stopPropagation();
                                void handleReopenTask(task);
                              }}
                            >
                              ↺ Riapri
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="lb-action-btn"
                              disabled={savingTaskId === task.id}
                              onClick={(event) => {
                                event.stopPropagation();
                                void handleCompleteTask(task);
                              }}
                            >
                              ✓ Completa
                            </button>
                          )}
                          {task.status !== "done" ? (
                            <>
                              <button
                                type="button"
                                className="lb-action-btn secondary quick-inline"
                                disabled={savingTaskId === task.id}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void handleQuickPostpone(task, "plus1hour");
                                }}
                              >
                                +1h
                              </button>
                              <button
                                type="button"
                                className="lb-action-btn secondary quick-inline"
                                disabled={savingTaskId === task.id}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void handleQuickPostpone(task, "plus1day");
                                }}
                              >
                                +1 giorno
                              </button>
                              <button
                                type="button"
                                className="lb-action-btn secondary quick-inline"
                                disabled={savingTaskId === task.id}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void handleQuickPostpone(task, "tomorrowMorning");
                                }}
                              >
                                Domani mattina
                              </button>
                            </>
                          ) : null}
                          <button
                            type="button"
                            className="lb-action-btn secondary"
                            onClick={(event) => {
                              event.stopPropagation();
                              handleOpenPractice(task);
                            }}
                          >
                            Apri pratica
                          </button>
                          <button
                            type="button"
                            className="lb-action-btn secondary"
                            disabled={!lead?.phone}
                            onClick={(event) => {
                              event.stopPropagation();
                              handleCallTask(task, lead);
                            }}
                          >
                            Chiama
                          </button>
                          <button
                            type="button"
                            className="lb-action-btn secondary"
                            onClick={(event) => {
                              event.stopPropagation();
                              handleOpenEdit(task);
                            }}
                          >
                            Modifica
                          </button>
                        </div>
                      </article>
                    );
                  })
                ) : (
                  <div className="lb-empty-lane">
                    <p>{lane.emptyLabel}</p>
                    <small>Riusa i task generati da follow-up, chiamate e pratiche operative.</small>
                  </div>
                )}
                {lane.key === "done" && groupedByLane.done.length > COMPLETED_LANE_LIMIT ? (
                  <div className="lb-lane-footer muted">
                    Mostrati {displayedByLane.done.length} di {groupedByLane.done.length} completati.
                    {displayedByLane.done.length < groupedByLane.done.length ? (
                      <button type="button" className="lb-inline-more" onClick={() => setCompletedVisibleCount((prev) => prev + COMPLETED_LANE_LIMIT)}>
                        Mostra altri
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </section>
          ))}
        </div>
      </section>

      <aside className="panel lb-detail">
        <h3>Dettaglio Task</h3>
        {!selectedTask ? (
          <p className="muted">Seleziona un task dalla board.</p>
        ) : (
          <div className="lb-detail-card">
            <header className="lb-detail-header">
              <div>
                <h4>{selectedTask.title}</h4>
                <p>
                  {selectedTask.leadId
                    ? `Lead collegato: ${leadMap.get(selectedTask.leadId)?.fullName || selectedTask.leadId}`
                    : "Nessuna pratica collegata"}
                </p>
              </div>
              <span className={`lb-chip lb-chip-${getTaskBadge(selectedTask).tone}`}>{getTaskBadge(selectedTask).label}</span>
            </header>

            <section className="lb-detail-box">
              <h5>Dettagli task</h5>
              <div className="lb-meta-grid">
                <div>
                  <span>Scadenza</span>
                  <strong>{formatDate(selectedTask.dueAt)}</strong>
                </div>
                <div>
                  <span>Assegnato a</span>
                  <strong>{selectedTask.assignedTo || leadMap.get(selectedTask.leadId || "")?.assignedTo || "-"}</strong>
                </div>
                <div>
                  <span>Stato task</span>
                  <strong>{getTaskStatusLabel(selectedTask)}</strong>
                </div>
                <div>
                  <span>Urgenza</span>
                  <strong>{getTaskBadge(selectedTask).label}</strong>
                </div>
                <div>
                  <span>Origine</span>
                  <strong>{selectedTask.sourceLabel}</strong>
                </div>
                <div>
                  <span>Tipo</span>
                  <strong>{selectedTask.kindLabel}</strong>
                </div>
                <div>
                  <span>Priorità</span>
                  <strong>{getPriorityMeta(selectedTask.priority).label}</strong>
                </div>
              </div>
            </section>

            <section className="lb-detail-box">
              <h5>Organizzazione task</h5>
              <div className="lb-drop-grid">
                {PRIORITY_OPTIONS.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    className={`lb-drop-target priority-${item.key}`}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      const task = resolveDraggedTask(event);
                      resetDragState();
                      if (!task) return;
                      void handlePriorityDrop(task.id, item.value, item.label.toLowerCase());
                    }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <div className="lb-drop-grid assignees">
                {(assignees.length ? assignees : ["me"]).map((assignee) => (
                  <button
                    key={assignee}
                    type="button"
                    className="lb-drop-target assignee"
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      const task = resolveDraggedTask(event);
                      resetDragState();
                      if (!task) return;
                      void handleAssignDrop(task.id, assignee);
                    }}
                  >
                    Assegna a {assignee}
                  </button>
                ))}
              </div>
            </section>

            <section className="lb-detail-box">
              <h5>Pratica collegata</h5>
              {!detailActivated ? (
                <p className="muted">Clicca un task per caricare il dettaglio della pratica collegata.</p>
              ) : detailLoading && !selectedLeadDetail ? (
                <div className="lb-detail-skeleton" aria-hidden="true">
                  <span className="lb-skeleton-line lg"></span>
                  <span className="lb-skeleton-line"></span>
                  <span className="lb-skeleton-line"></span>
                  <span className="lb-skeleton-line"></span>
                </div>
              ) : selectedLeadDetail ? (
                <div className="lb-meta-grid">
                  <div>
                    <span>Cliente</span>
                    <strong>{selectedLeadDetail.lead.fullName}</strong>
                  </div>
                  <div>
                    <span>Telefono</span>
                    <strong>{selectedLeadDetail.lead.phone || "-"}</strong>
                  </div>
                  <div>
                    <span>Fonte</span>
                    <strong>{selectedLeadDetail.lead.source || "-"}</strong>
                  </div>
                  <div>
                    <span>Stato pratica</span>
                    <strong>{selectedLeadDetail.lead.status || "-"}</strong>
                  </div>
                  <div>
                    <span>Documenti</span>
                    <strong>
                      {getMissingDocumentsCount(selectedLeadDetail.lead) > 0
                        ? `⚠ Mancanti (${getMissingDocumentsCount(selectedLeadDetail.lead)})`
                        : "✅ Completi"}
                    </strong>
                  </div>
                </div>
              ) : (
                <p className="muted">Questo task non ha una pratica collegata.</p>
              )}
            </section>

            <section className="lb-detail-box">
              <h5>Descrizione</h5>
              <p>{selectedTask.description || "Nessuna descrizione disponibile."}</p>
            </section>

            <section className="lb-detail-box">
              <h5>Ultime attività lead</h5>
              <div className="lb-timeline">
                {!detailActivated ? (
                  <p className="muted">Seleziona un task per caricare attività e timeline del lead.</p>
                ) : detailLoading && !selectedLeadDetail ? (
                  <div className="lb-detail-skeleton" aria-hidden="true">
                    <span className="lb-skeleton-line lg"></span>
                    <span className="lb-skeleton-line"></span>
                    <span className="lb-skeleton-line md"></span>
                  </div>
                ) : selectedLeadDetail?.timeline?.length ? (
                  getCleanTimelineItems(selectedLeadDetail.timeline).map((item, idx) => (
                      <article key={`${item.createdAt}-${idx}`} className="lb-timeline-item">
                        <div className="lb-timeline-icon">{getTimelineMeta(item.type).icon}</div>
                        <div className="lb-timeline-copy">
                          <div className="lb-timeline-top">
                            <strong>{getTimelineMeta(item.type).label}</strong>
                            <span className="lb-timeline-meta">{getTimelineSecondaryMeta(item)}</span>
                          </div>
                          <p>{item.text}</p>
                        </div>
                      </article>
                    ))
                ) : (
                  <p className="muted">Nessuna attività disponibile.</p>
                )}
              </div>
            </section>

            <section className="lb-detail-box">
              <h5>Azioni</h5>
              <div className="lb-detail-actions">
                {selectedTask.status === "done" ? (
                  <button type="button" onClick={() => void handleReopenTask(selectedTask)}>
                    Riapri
                  </button>
                ) : (
                  <button type="button" onClick={() => void handleCompleteTask(selectedTask)}>
                    Completa
                  </button>
                )}
                <button type="button" className="secondary" onClick={() => handleOpenPractice(selectedTask)}>
                  Apri pratica
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={!selectedLeadDetail?.lead.phone}
                  onClick={() => handleCallTask(selectedTask, selectedLeadDetail?.lead)}
                >
                  Chiama
                </button>
                <button type="button" className="secondary" onClick={() => handleOpenEdit(selectedTask)}>
                  Modifica
                </button>
              </div>
              {selectedTask.status !== "done" ? (
                <div className="lb-detail-actions lb-detail-actions-quick">
                  <button type="button" className="secondary quick" onClick={() => void handleQuickPostpone(selectedTask, "plus1hour")}>
                    +1 ora
                  </button>
                  <button type="button" className="secondary quick" onClick={() => void handleQuickPostpone(selectedTask, "plus1day")}>
                    +1 giorno
                  </button>
                  <button
                    type="button"
                    className="secondary quick"
                    onClick={() => void handleQuickPostpone(selectedTask, "tomorrowMorning")}
                  >
                    Domani mattina
                  </button>
                </div>
              ) : null}
            </section>
          </div>
        )}
      </aside>
    </div>
  );
}

export function LegacyLeadBoardRedirect() {
  return <Navigate to="/tasks" replace />;
}




