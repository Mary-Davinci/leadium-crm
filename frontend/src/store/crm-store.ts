import { Lead, LeadDetail, Workflow } from "../features/practices/pratiche.types";

export type CrmUser = {
  id: string;
  username: string;
  name: string;
  role: "super_admin" | "admin" | "operatore";
  email?: string;
};

export type CrmTask = {
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

type TimedValue<T> = {
  data: T;
  loadedAt: number;
};

export type DashboardKpi = {
  open: number;
  today: number;
  overdue: number;
  done: number;
};

export type DashboardInboxItem = {
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

export type DashboardInboxPayload = {
  items: DashboardInboxItem[];
  kpis: {
    unreadChats: number;
  };
};

export type CrmConversation = {
  id: string;
  leadId?: string | null;
  customerName?: string;
  phone?: string;
  unreadCount?: number;
  lastMessagePreview?: string;
  lastMessageAt?: string;
  assignedTo?: string;
  status?: string;
  channel?: string;
  lastInboundAt?: string | null;
  lastOutboundAt?: string | null;
  replyWindowExpiresAt?: string | null;
  hasOpenSession?: boolean;
};

export type CrmChatMessage = {
  id: string;
  direction: "inbound" | "outbound";
  text: string;
  createdAt: string;
  status?: string;
  messageType?: string;
  templateKey?: string;
  templateName?: string;
};

type CrmStoreState = {
  taskBoard: TimedValue<{ tasks: CrmTask[]; leads: Lead[] }> | null;
  users: TimedValue<CrmUser[]> | null;
  workflow: TimedValue<Workflow> | null;
  dashboard: TimedValue<{ kpi: DashboardKpi; inbox: DashboardInboxPayload }> | null;
  chatConversations: TimedValue<CrmConversation[]> | null;
  chatMessages: Record<string, TimedValue<{ conversation: CrmConversation; messages: CrmChatMessage[] }>>;
  practiceLists: Record<string, TimedValue<Lead[]>>;
  leadDetails: Record<string, TimedValue<LeadDetail>>;
};

const DASHBOARD_CACHE_KEY = "leadium_dashboard_cache_v1";
const CHAT_CONVERSATIONS_CACHE_KEY = "leadium_chat_conversations_cache_v1";
const CHAT_MESSAGES_CACHE_PREFIX = "leadium_chat_messages_cache_v1_";

const state: CrmStoreState = {
  taskBoard: null,
  users: null,
  workflow: null,
  dashboard: null,
  chatConversations: null,
  chatMessages: {},
  practiceLists: {},
  leadDetails: {}
};

export const CRM_STORE_TTLS = {
  taskBoard: 2 * 60 * 1000,
  users: 10 * 60 * 1000,
  workflow: 10 * 60 * 1000,
  dashboard: 2 * 60 * 1000,
  chatConversations: 20 * 1000,
  chatMessages: 45 * 1000,
  practiceList: 2 * 60 * 1000,
  leadDetail: 5 * 60 * 1000
} as const;

function isFresh<T>(entry: TimedValue<T> | null | undefined, ttlMs: number) {
  return Boolean(entry && Date.now() - entry.loadedAt < ttlMs);
}

function normalizeContactPhone(value?: string) {
  return String(value || "").replace(/\D+/g, "");
}

function getLeadContactKey(lead: Lead) {
  const phone = normalizeContactPhone(lead.phone);
  if (phone) return `phone::${phone}`;
  const email = String(lead.email || "").trim().toLowerCase();
  if (email) return `email::${email}`;
  return `id::${String(lead.id || "")}`;
}

function compactLeadsByContact(leads: Lead[]) {
  const byContact = new Map<string, Lead>();
  leads.forEach((lead) => {
    if (!lead?.id) return;
    const key = getLeadContactKey(lead);
    const current = byContact.get(key);
    if (!current) {
      byContact.set(key, lead);
      return;
    }
    const currentTime = new Date(current.updatedAt || current.createdAt || 0).getTime();
    const nextTime = new Date(lead.updatedAt || lead.createdAt || 0).getTime();
    if (nextTime >= currentTime) byContact.set(key, lead);
  });
  return Array.from(byContact.values());
}

function readDashboardCacheStorage() {
  try {
    const raw = window.sessionStorage.getItem(DASHBOARD_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TimedValue<{ kpi: DashboardKpi; inbox: DashboardInboxPayload }>;
    if (!parsed?.loadedAt || !parsed?.data) {
      window.sessionStorage.removeItem(DASHBOARD_CACHE_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeDashboardCacheStorage(value: TimedValue<{ kpi: DashboardKpi; inbox: DashboardInboxPayload }>) {
  try {
    window.sessionStorage.setItem(DASHBOARD_CACHE_KEY, JSON.stringify(value));
  } catch {}
}

function readChatConversationsStorage() {
  try {
    const raw = window.sessionStorage.getItem(CHAT_CONVERSATIONS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TimedValue<CrmConversation[]>;
    if (!parsed?.loadedAt || !Array.isArray(parsed.data)) {
      window.sessionStorage.removeItem(CHAT_CONVERSATIONS_CACHE_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeChatConversationsStorage(value: TimedValue<CrmConversation[]>) {
  try {
    window.sessionStorage.setItem(CHAT_CONVERSATIONS_CACHE_KEY, JSON.stringify(value));
  } catch {}
}

function getChatMessagesCacheKey(conversationId: string) {
  return `${CHAT_MESSAGES_CACHE_PREFIX}${conversationId}`;
}

function readChatMessagesStorage(conversationId: string) {
  try {
    const raw = window.sessionStorage.getItem(getChatMessagesCacheKey(conversationId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TimedValue<{ conversation: CrmConversation; messages: CrmChatMessage[] }>;
    if (!parsed?.loadedAt || !parsed.data?.conversation || !Array.isArray(parsed.data.messages)) {
      window.sessionStorage.removeItem(getChatMessagesCacheKey(conversationId));
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeChatMessagesStorage(conversationId: string, value: TimedValue<{ conversation: CrmConversation; messages: CrmChatMessage[] }>) {
  try {
    window.sessionStorage.setItem(getChatMessagesCacheKey(conversationId), JSON.stringify(value));
  } catch {}
}

export function getCrmStoreSnapshot() {
  return state;
}

export function getTaskBoardCache() {
  return state.taskBoard;
}

export function setTaskBoardCache(tasks: CrmTask[], leads: Lead[]) {
  const tasksById = new Map<string, CrmTask>();
  tasks.forEach((task) => {
    if (!task?.id) return;
    tasksById.set(String(task.id), task);
  });
  state.taskBoard = {
    data: { tasks: Array.from(tasksById.values()), leads: compactLeadsByContact(leads) },
    loadedAt: Date.now()
  };
}

export function isTaskBoardCacheFresh() {
  return isFresh(state.taskBoard, CRM_STORE_TTLS.taskBoard);
}

export function getUsersCache() {
  return state.users;
}

export function setUsersCache(users: CrmUser[]) {
  state.users = {
    data: users,
    loadedAt: Date.now()
  };
}

export function isUsersCacheFresh() {
  return isFresh(state.users, CRM_STORE_TTLS.users);
}

export function getWorkflowCache() {
  return state.workflow;
}

export function setWorkflowCache(workflow: Workflow) {
  state.workflow = {
    data: workflow,
    loadedAt: Date.now()
  };
}

export function isWorkflowCacheFresh() {
  return isFresh(state.workflow, CRM_STORE_TTLS.workflow);
}

export function getDashboardCache() {
  if (!state.dashboard) {
    state.dashboard = readDashboardCacheStorage();
  }
  return state.dashboard;
}

export function setDashboardCache(kpi: DashboardKpi, inbox: DashboardInboxPayload) {
  state.dashboard = {
    data: { kpi, inbox },
    loadedAt: Date.now()
  };
  writeDashboardCacheStorage(state.dashboard);
}

export function isDashboardCacheFresh() {
  return isFresh(state.dashboard, CRM_STORE_TTLS.dashboard);
}

export function getChatConversationsCache() {
  if (!state.chatConversations) {
    state.chatConversations = readChatConversationsStorage();
  }
  return state.chatConversations;
}

export function setChatConversationsCache(conversations: CrmConversation[]) {
  const byId = new Map<string, CrmConversation>();
  conversations.forEach((conversation) => {
    if (!conversation?.id) return;
    byId.set(String(conversation.id), conversation);
  });
  state.chatConversations = {
    data: Array.from(byId.values()),
    loadedAt: Date.now()
  };
  writeChatConversationsStorage(state.chatConversations);
}

export function isChatConversationsCacheFresh() {
  return isFresh(getChatConversationsCache(), CRM_STORE_TTLS.chatConversations);
}

export function getChatMessagesCache(conversationId: string) {
  if (!conversationId) return null;
  if (!state.chatMessages[conversationId]) {
    const storage = readChatMessagesStorage(conversationId);
    if (storage) state.chatMessages[conversationId] = storage;
  }
  return state.chatMessages[conversationId] || null;
}

export function setChatMessagesCache(conversationId: string, conversation: CrmConversation, messages: CrmChatMessage[]) {
  if (!conversationId) return;
  state.chatMessages[conversationId] = {
    data: { conversation, messages },
    loadedAt: Date.now()
  };
  writeChatMessagesStorage(conversationId, state.chatMessages[conversationId]);
}

export function isChatMessagesCacheFresh(conversationId: string) {
  return isFresh(getChatMessagesCache(conversationId), CRM_STORE_TTLS.chatMessages);
}

export function patchConversationInChatCache(conversationId: string, patch: Partial<CrmConversation>) {
  const current = getChatConversationsCache();
  if (current) {
    setChatConversationsCache(current.data.map((conversation) => (conversation.id === conversationId ? { ...conversation, ...patch } : conversation)));
  }
  const messagesEntry = getChatMessagesCache(conversationId);
  if (messagesEntry) {
    setChatMessagesCache(conversationId, { ...messagesEntry.data.conversation, ...patch }, messagesEntry.data.messages);
  }
}

export function getPracticeListCache(key: string) {
  return state.practiceLists[key] || null;
}

export function setPracticeListCache(key: string, leads: Lead[]) {
  state.practiceLists[key] = {
    data: compactLeadsByContact(leads),
    loadedAt: Date.now()
  };
}

export function isPracticeListCacheFresh(key: string) {
  return isFresh(state.practiceLists[key], CRM_STORE_TTLS.practiceList);
}

export function getLeadDetailCacheEntry(leadId: string) {
  return state.leadDetails[leadId] || null;
}

export function setLeadDetailCacheEntry(leadId: string, detail: LeadDetail) {
  state.leadDetails[leadId] = {
    data: detail,
    loadedAt: Date.now()
  };
}

export function isLeadDetailCacheFresh(leadId: string) {
  return isFresh(state.leadDetails[leadId], CRM_STORE_TTLS.leadDetail);
}

export function patchLeadAcrossStore(leadId: string, updates: Partial<Lead>) {
  if (state.taskBoard) {
    state.taskBoard = {
      ...state.taskBoard,
      data: {
        ...state.taskBoard.data,
        leads: state.taskBoard.data.leads.map((lead) => (lead.id === leadId ? { ...lead, ...updates } : lead))
      }
    };
  }

  Object.keys(state.practiceLists).forEach((key) => {
    const entry = state.practiceLists[key];
    state.practiceLists[key] = {
      ...entry,
      data: entry.data.map((lead) => (lead.id === leadId ? { ...lead, ...updates } : lead))
    };
  });

  const detailEntry = state.leadDetails[leadId];
  if (detailEntry) {
    state.leadDetails[leadId] = {
      ...detailEntry,
      data: {
        ...detailEntry.data,
        lead: {
          ...detailEntry.data.lead,
          ...updates
        }
      }
    };
  }
}

export function upsertTaskInBoard(task: CrmTask) {
  if (!state.taskBoard) return;
  state.taskBoard = {
    ...state.taskBoard,
    data: {
      ...state.taskBoard.data,
      tasks: [task, ...state.taskBoard.data.tasks.filter((item) => item.id !== task.id)]
    }
  };
}

export function invalidateTaskBoardCache() {
  state.taskBoard = null;
}

export function invalidateWorkflowCache() {
  state.workflow = null;
}

export function invalidateDashboardCache() {
  state.dashboard = null;
  try {
    window.sessionStorage.removeItem(DASHBOARD_CACHE_KEY);
  } catch {}
}

export function invalidatePracticeListCaches() {
  state.practiceLists = {};
}

export function invalidateLeadDetailCache(leadId?: string) {
  if (leadId) {
    delete state.leadDetails[leadId];
    return;
  }
  state.leadDetails = {};
}

export function patchTaskStatusInBoard(taskId: string, status: CrmTask["status"]) {
  if (!state.taskBoard) return;
  state.taskBoard = {
    ...state.taskBoard,
    data: {
      ...state.taskBoard.data,
      tasks: state.taskBoard.data.tasks.map((task) =>
        task.id === taskId
          ? {
              ...task,
              status,
              updatedAt: new Date().toISOString()
            }
          : task
      )
    }
  };
}

export function patchDashboardTaskItemStatus(taskId: string, status: "open" | "done" | "dismissed") {
  const current = getDashboardCache();
  if (!current) return;
  state.dashboard = {
    ...current,
    data: {
      ...current.data,
      inbox: {
        ...current.data.inbox,
        items: current.data.inbox.items.map((item) =>
          item.taskId === taskId || item.id === taskId
            ? {
                ...item,
                status
              }
            : item
        )
      }
    }
  };
  writeDashboardCacheStorage(state.dashboard);
}
