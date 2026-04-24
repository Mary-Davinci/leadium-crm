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

type CrmStoreState = {
  taskBoard: TimedValue<{ tasks: CrmTask[]; leads: Lead[] }> | null;
  users: TimedValue<CrmUser[]> | null;
  workflow: TimedValue<Workflow> | null;
  dashboard: TimedValue<{ kpi: DashboardKpi; inbox: DashboardInboxPayload }> | null;
  practiceLists: Record<string, TimedValue<Lead[]>>;
  leadDetails: Record<string, TimedValue<LeadDetail>>;
};

const DASHBOARD_CACHE_KEY = "leadium_dashboard_cache_v1";

const state: CrmStoreState = {
  taskBoard: null,
  users: null,
  workflow: null,
  dashboard: null,
  practiceLists: {},
  leadDetails: {}
};

export const CRM_STORE_TTLS = {
  taskBoard: 2 * 60 * 1000,
  users: 10 * 60 * 1000,
  workflow: 10 * 60 * 1000,
  dashboard: 2 * 60 * 1000,
  practiceList: 2 * 60 * 1000,
  leadDetail: 5 * 60 * 1000
} as const;

function isFresh<T>(entry: TimedValue<T> | null | undefined, ttlMs: number) {
  return Boolean(entry && Date.now() - entry.loadedAt < ttlMs);
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

export function getCrmStoreSnapshot() {
  return state;
}

export function getTaskBoardCache() {
  return state.taskBoard;
}

export function setTaskBoardCache(tasks: CrmTask[], leads: Lead[]) {
  state.taskBoard = {
    data: { tasks, leads },
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

export function getPracticeListCache(key: string) {
  return state.practiceLists[key] || null;
}

export function setPracticeListCache(key: string, leads: Lead[]) {
  state.practiceLists[key] = {
    data: leads,
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
  const exists = state.taskBoard.data.tasks.some((item) => item.id === task.id);
  state.taskBoard = {
    ...state.taskBoard,
    data: {
      ...state.taskBoard.data,
      tasks: exists
        ? state.taskBoard.data.tasks.map((item) => (item.id === task.id ? task : item))
        : [task, ...state.taskBoard.data.tasks]
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
