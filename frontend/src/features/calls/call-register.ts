// The admin's call register: what the page counts, kept apart so each number can be checked.
import { romeDayStamp } from "../../lib/business-time";

export type RegisterCall = {
  startedAt: string; endedAt?: string; outcome: string; actor?: string; source?: string;
  durationSeconds?: number; direction?: "inbound" | "outbound"; answeredAt?: string | null;
  lead?: { assignedTo?: string } | null;
};
export type CallPeriod = "today" | "7d" | "all";
export type Operator = { username: string; name?: string; threeCxDn?: string };

const DAY_MS = 24 * 3600 * 1000;
const UNANSWERED = new Set(["no_answer", "busy"]);
const normalize = (value?: string) => String(value || "").trim().toLowerCase();

export function isAnswered(call: RegisterCall) {
  return Boolean(call.answeredAt) || !UNANSWERED.has(call.outcome);
}

/** Talking time: from the PBX when it reports it. End minus start would count the ringing too. */
export function talkSeconds(call: RegisterCall) {
  if (Number(call.durationSeconds) > 0) return Number(call.durationSeconds);
  if (!isAnswered(call) || !call.endedAt) return 0;
  // A 3CX call with no reported time and no answer time has nothing reliable to show.
  const from = call.answeredAt || (call.source === "3cx" ? "" : call.startedAt);
  if (!from) return 0;
  return Math.max(0, Math.round((Date.parse(call.endedAt) - Date.parse(from)) / 1000)) || 0;
}

export function formatTalk(seconds: number) {
  if (!seconds) return "—";
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

export function formatTotalTalk(seconds: number) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export const directionLabel = (call: RegisterCall) => (call.direction === "inbound" ? "In arrivo" : call.direction === "outbound" ? "In uscita" : "—");

export function isInPeriod(call: RegisterCall, period: CallPeriod, now: number) {
  if (period === "all") return true;
  if (period === "today") return romeDayStamp(new Date(call.startedAt)) === romeDayStamp(new Date(now));
  return now - Date.parse(call.startedAt) <= 7 * DAY_MS;
}

const dayFormat = new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", day: "numeric", month: "long" });
const yearFormat = new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", day: "numeric", month: "long", year: "numeric" });

export function dayHeading(value: string, now: number) {
  const date = new Date(value);
  const stamp = romeDayStamp(date);
  if (stamp === romeDayStamp(new Date(now))) return `Oggi · ${dayFormat.format(date)}`;
  if (stamp === romeDayStamp(new Date(now - DAY_MS))) return `Ieri · ${dayFormat.format(date)}`;
  return yearFormat.format(date);
}

/** Every way the log may name an operator: 3CX writes the extension, the CRM the username. */
export function operatorNames(operators: Operator[]) {
  const names = new Map<string, string>();
  for (const operator of operators) {
    const label = operator.name?.trim() || operator.username;
    for (const key of [operator.username, operator.name, operator.threeCxDn]) if (normalize(key)) names.set(normalize(key), label);
  }
  return names;
}

export function operatorOf(call: RegisterCall, names: Map<string, string>) {
  const actor = normalize(call.actor);
  if (names.has(actor)) return names.get(actor)!;
  // "3cx", "operator" and a bare extension name nobody: the practice's owner is the best answer.
  if (actor && !["3cx", "operator"].includes(actor) && !/^\d+$/.test(actor)) return String(call.actor);
  const owner = call.lead?.assignedTo;
  return names.get(normalize(owner)) || owner || "Da assegnare";
}

export function daySummary(calls: RegisterCall[], now: number) {
  const today = calls.filter((call) => isInPeriod(call, "today", now));
  const answered = today.filter(isAnswered).length;
  return {
    total: today.length,
    inbound: today.filter((call) => call.direction === "inbound").length,
    outbound: today.filter((call) => call.direction === "outbound").length,
    answered,
    unanswered: today.length - answered,
    callBack: today.filter((call) => call.outcome === "call_back").length,
    talk: today.reduce((sum, call) => sum + talkSeconds(call), 0)
  };
}

export function operatorSummary(calls: RegisterCall[], names: Map<string, string>, now: number) {
  const rows = new Map<string, { name: string; total: number; answered: number; talk: number }>();
  for (const call of calls) {
    if (!isInPeriod(call, "today", now)) continue;
    const name = operatorOf(call, names);
    if (name === "Da assegnare") continue;
    const row = rows.get(name) || { name, total: 0, answered: 0, talk: 0 };
    row.total += 1;
    if (isAnswered(call)) row.answered += 1;
    row.talk += talkSeconds(call);
    rows.set(name, row);
  }
  return [...rows.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, "it"));
}
