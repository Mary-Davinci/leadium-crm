import { identityKeys } from "./whatsapp-access";

// The admin dashboard: what the team is doing today, one row per operator. Pure, so every number
// can be checked without the services behind it.

// Same kinds as the operators' reminders. A callback leaves two tasks on a practice, so each
// practice counts once.
const CALL_KINDS = new Set(["callback_reminder", "callback_overdue", "appointment_reminder", "call", "follow_up", "next_action"]);
const FINAL_OUTCOMES = new Set(["won", "lost", "disqualified"]);
const FINAL_STATUSES = new Set(["contattato non interessato", "fuori budget", "persa", "venduta", "chiusa 100%"]);
export const ACTIVE_WINDOW_MS = 3 * 60_000;
const WAITING_WINDOW_MS = 7 * 24 * 3600_000;

type Operator = { username: string; name?: string; surname?: string; email?: string; threeCxDn?: string };
type DashboardLead = { id: string; assignedTo?: string; status?: string; closingOutcome?: string; closedAt?: string | null; nextActionAt?: string | null };
type DashboardTask = { leadId?: string; kind: string; status: string; dueAt?: string | null; assignedTo?: string };
type DashboardCall = { leadId?: string; actor?: string; startedAt: string };
type DashboardChat = { assignedTo?: string; status?: string; lastInboundAt?: string | null; lastOutboundAt?: string | null };

export type TeamDashboardInput = {
  operators: Operator[];
  leads: DashboardLead[];
  tasks: DashboardTask[];
  calls: DashboardCall[];
  quotedLeadIds: string[];
  /** assignedTo here is the chat's real owner, as the gateway resolves it. */
  conversations: DashboardChat[];
  lastSeen: Map<string, number>;
  onCallDns: Set<string>;
  now: number;
};

type Row = {
  name: string; username: string; presence: "call" | "active" | "inactive";
  assigned: number; toContact: number; open: number; closed: number;
  done: number; todo: number; follow: number; followLate: number;
  chats: number; waiting: number; quotes: number; quotesOpen: number;
};

const COUNTERS = ["assigned", "toContact", "open", "closed", "done", "todo", "follow", "followLate", "chats", "waiting", "quotes", "quotesOpen"] as const;
const normalize = (value: unknown) => String(value ?? "").trim().toLowerCase();
const romeDayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit" });
const romeDay = (value: string | number) => romeDayFormat.format(new Date(value));
const time = (value?: string | null) => { const at = Date.parse(String(value || "")); return Number.isFinite(at) ? at : 0; };

export function isClosedPractice(lead: DashboardLead) {
  return Boolean(lead.closedAt) || FINAL_OUTCOMES.has(String(lead.closingOutcome || "")) || FINAL_STATUSES.has(normalize(lead.status));
}

export function computeTeamDashboard(input: TeamDashboardInput) {
  const { now } = input;
  const today = romeDay(now);
  const rows: Row[] = [];
  const rowByIdentity = new Map<string, Row>();
  for (const operator of input.operators) {
    const seen = input.lastSeen.get(normalize(operator.username)) || 0;
    const onCall = Boolean(operator.threeCxDn) && input.onCallDns.has(String(operator.threeCxDn));
    const row: Row = {
      name: `${operator.name || ""} ${operator.surname || ""}`.trim() || operator.username, username: operator.username,
      presence: onCall ? "call" : now - seen < ACTIVE_WINDOW_MS ? "active" : "inactive",
      assigned: 0, toContact: 0, open: 0, closed: 0, done: 0, todo: 0, follow: 0, followLate: 0, chats: 0, waiting: 0, quotes: 0, quotesOpen: 0
    };
    rows.push(row);
    identityKeys(operator as any).forEach((identity) => rowByIdentity.set(identity, row));
  }
  const rowOf = (owner: unknown) => rowByIdentity.get(normalize(owner)) || null;

  let unassigned = 0;
  const rowByLead = new Map<string, Row | null>();
  const openLeads = new Map<string, DashboardLead>();
  for (const lead of input.leads) {
    const row = rowOf(lead.assignedTo);
    rowByLead.set(lead.id, row);
    const closed = isClosedPractice(lead);
    if (!closed) openLeads.set(lead.id, lead);
    if (!row) {
      if (!closed && !normalize(lead.assignedTo)) unassigned += 1;
      continue;
    }
    row.assigned += 1;
    if (closed) row.closed += 1;
    else {
      row.open += 1;
      if (normalize(lead.status) === "da contattare") row.toContact += 1;
    }
  }

  const counted = { todo: new Set<string>(), follow: new Set<string>(), late: new Set<string>() };
  const leadsWithOpenTask = new Set<string>();
  for (const task of input.tasks) {
    if (task.status !== "open" || !task.leadId) continue;
    leadsWithOpenTask.add(task.leadId);
    if (!CALL_KINDS.has(task.kind) || !openLeads.has(task.leadId)) continue;
    const row = rowByLead.get(task.leadId);
    if (!row) continue;
    const due = time(task.dueAt);
    if (!counted.follow.has(task.leadId)) { counted.follow.add(task.leadId); row.follow += 1; }
    if (due && due < now && !counted.late.has(task.leadId)) { counted.late.add(task.leadId); row.followLate += 1; }
    if (due && romeDay(due) === today && !counted.todo.has(task.leadId)) { counted.todo.add(task.leadId); row.todo += 1; }
  }

  for (const call of input.calls) {
    if (!time(call.startedAt) || romeDay(call.startedAt) !== today) continue;
    const row = rowOf(call.actor) || rowByLead.get(String(call.leadId || "")) || null;
    if (row) row.done += 1;
  }

  for (const leadId of new Set(input.quotedLeadIds)) {
    const lead = openLeads.get(leadId);
    const row = rowByLead.get(leadId);
    if (!lead || !row) continue;
    row.quotes += 1;
    if (!lead.nextActionAt && !leadsWithOpenTask.has(leadId)) row.quotesOpen += 1;
  }

  let waitingWithoutOperator = 0;
  for (const chat of input.conversations) {
    const row = rowOf(chat.assignedTo);
    const inbound = time(chat.lastInboundAt);
    const outbound = time(chat.lastOutboundAt);
    if (row && outbound && romeDay(outbound) === today) row.chats += 1;
    const waiting = chat.status !== "resolved" && inbound > outbound && now - inbound < WAITING_WINDOW_MS;
    if (!waiting) continue;
    if (row) row.waiting += 1;
    else waitingWithoutOperator += 1;
  }

  const totals = Object.fromEntries(COUNTERS.map((key) => [key, rows.reduce((sum, row) => sum + row[key], 0)])) as Record<(typeof COUNTERS)[number], number>;
  totals.waiting += waitingWithoutOperator;
  return { generatedAt: new Date(now).toISOString(), totals: { ...totals, unassigned }, operators: rows.sort((a, b) => b.open - a.open) };
}
