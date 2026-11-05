import { romeDayStamp } from "../../lib/business-time";
import type { CrmTask } from "../../store/crm-store";

export const REMIND_BEFORE_MS = 10 * 60_000;
export const SNOOZE_MS = 10 * 60_000;
const SNOOZE_STORAGE_KEY = "leadium.scheduledCalls.snoozed";

// A callback leaves two tasks on the practice (next_action and callback_reminder) with the same
// time: the first kind listed here is the one kept. Paperwork and quote tasks are not calls.
export const CALL_KINDS = ["callback_reminder", "callback_overdue", "appointment_reminder", "call", "follow_up", "next_action"];

export type ScheduledCallLead = { id: string; fullName?: string; phone?: string };
export type ScheduledCall = { taskId: string; dueAt: string; leadId: string; customerName: string; phone: string };
export type Snoozes = Record<string, number>;
type ActorIdentity = { username?: string; name?: string; surname?: string; email?: string };

const normalize = (value?: string | null) => String(value || "").trim().toLocaleLowerCase("it");

/** One reminder per appointment: moving the call to a new time reminds again. */
export const snoozeKey = (call: Pick<ScheduledCall, "taskId" | "dueAt">) => `${call.taskId}:${call.dueAt}`;

export function actorKeys(user: ActorIdentity | null | undefined) {
  if (!user) return new Set<string>();
  return new Set([user.username, user.name, user.email, `${user.name || ""} ${user.surname || ""}`].map(normalize).filter(Boolean));
}

/**
 * The actor's calls due within REMIND_BEFORE_MS or late since this morning, earliest first. Older
 * late calls stay on the bell: a popup for each of them would bury today's work.
 */
export function selectScheduledCalls(tasks: CrmTask[], leads: ScheduledCallLead[], keys: Set<string>, snoozes: Snoozes, now: number) {
  const leadById = new Map(leads.map((lead) => [lead.id, lead]));
  const today = romeDayStamp(now);
  const byLead = new Map<string, { call: ScheduledCall; rank: number; at: number }>();
  for (const task of tasks) {
    const rank = CALL_KINDS.indexOf(task.kind);
    const at = Date.parse(String(task.dueAt || ""));
    if (task.status !== "open" || rank < 0 || !task.leadId || !Number.isFinite(at)) continue;
    if (!keys.has(normalize(task.assignedTo)) || at > now + REMIND_BEFORE_MS || romeDayStamp(at) !== today) continue;
    // The board merges practices of the same contact: a task can outlive its lead row.
    const lead = leadById.get(task.leadId);
    const taskName = String(task.title || "").split(": ").slice(1).join(": ");
    const phone = lead?.phone || String(task.meta?.phone || "");
    const call = { taskId: task.id, dueAt: String(task.dueAt), leadId: task.leadId, customerName: lead?.fullName || taskName || phone || "Cliente", phone };
    const current = byLead.get(task.leadId);
    if (!current || at < current.at || (at === current.at && rank < current.rank)) byLead.set(task.leadId, { call, rank, at });
  }
  return [...byLead.values()]
    .filter(({ call, at }) => !(snoozes[snoozeKey(call)] > now) && at <= now + REMIND_BEFORE_MS)
    .sort((a, b) => a.at - b.at)
    .map(({ call }) => call);
}

export function describeDue(dueAt: string, now: number) {
  const at = Date.parse(dueAt);
  const time = new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit" }).format(at);
  const minutes = Math.round(Math.abs(at - now) / 60_000);
  const hours = Math.floor(minutes / 60);
  const span = hours ? `${hours} h ${minutes % 60} min` : `${minutes} min`;
  if (minutes < 1) return { late: false, label: `Alle ${time} · adesso` };
  return at > now ? { late: false, label: `Alle ${time} · tra ${span}` } : { late: true, label: `Era alle ${time} · in ritardo di ${span}` };
}

export function readSnoozes(now: number): Snoozes {
  try {
    const saved = JSON.parse(localStorage.getItem(SNOOZE_STORAGE_KEY) || "{}") as Snoozes;
    return Object.fromEntries(Object.entries(saved).filter(([, until]) => Number(until) > now));
  } catch { return {}; }
}

export function writeSnoozes(snoozes: Snoozes) {
  try { localStorage.setItem(SNOOZE_STORAGE_KEY, JSON.stringify(snoozes)); } catch { /* the reminder simply comes back on reload */ }
}
