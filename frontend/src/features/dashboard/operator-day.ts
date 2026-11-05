import { romeDayStamp } from "../../lib/business-time";
import type { CrmTask } from "../../store/crm-store";
import { CALL_KINDS } from "../calls/scheduled-calls";

type DayLead = { id: string; fullName?: string; phone?: string; status?: string };
type DayChat = { id: string; customerName?: string; phone?: string; status?: string; lastInboundAt?: string | null; lastOutboundAt?: string | null; lastMessagePreview?: string };
type DayMail = { id: string; direction: string; readAt: string | null; subject?: string; from?: string; fromName?: string; leadName?: string; receivedAt: string };
type DayCall = { startedAt: string };

export type AgendaItem = { taskId: string; leadId: string; name: string; phone: string; what: string; at: number; time: string; late: boolean; state: string };
export type WaitingItem = { key: string; name: string; text: string; at: number; href: string };

const KIND_LABELS: Record<string, string> = {
  callback_reminder: "Richiamo concordato", callback_overdue: "Richiamo", appointment_reminder: "Appuntamento telefonico",
  call: "Richiamo", follow_up: "Follow-up", next_action: "Prossima azione"
};
const WAITING_WINDOW_MS = 7 * 24 * 3600_000;
const timeFormat = new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit" });
const stamp = (value?: string | null) => { const at = Date.parse(String(value || "")); return Number.isFinite(at) ? at : 0; };

function stateLabel(at: number, now: number) {
  if (at < now) return "In ritardo";
  const minutes = Math.ceil((at - now) / 60_000);
  return minutes <= 60 ? `Tra ${minutes} min` : "Oggi";
}

/** Today's calls and every late one, one per customer, earliest first. */
export function buildAgenda(tasks: CrmTask[], leads: DayLead[], now: number) {
  const leadById = new Map(leads.map((lead) => [lead.id, lead]));
  const today = romeDayStamp(now);
  const byLead = new Map<string, { task: CrmTask; at: number; rank: number }>();
  for (const task of tasks) {
    const rank = CALL_KINDS.indexOf(task.kind);
    const at = stamp(task.dueAt);
    if (task.status !== "open" || rank < 0 || !task.leadId || !at) continue;
    if (at >= now && romeDayStamp(at) !== today) continue;
    const current = byLead.get(task.leadId);
    if (!current || at < current.at || (at === current.at && rank < current.rank)) byLead.set(task.leadId, { task, at, rank });
  }
  return [...byLead.values()].sort((a, b) => a.at - b.at).map(({ task, at }): AgendaItem => {
    const lead = leadById.get(String(task.leadId));
    return {
      taskId: task.id, leadId: String(task.leadId), name: lead?.fullName || String(task.title || "").split(": ").slice(1).join(": ") || lead?.phone || "Cliente",
      phone: lead?.phone || String(task.meta?.phone || ""), what: KIND_LABELS[task.kind] || "Chiamata", at, time: timeFormat.format(at), late: at < now, state: stateLabel(at, now)
    };
  });
}

/** Customers whose last word has no answer yet: WhatsApp and email together, newest first. */
export function buildWaiting(conversations: DayChat[], mail: DayMail[], now: number) {
  const chats = conversations
    .filter((chat) => chat.status !== "resolved" && stamp(chat.lastInboundAt) > stamp(chat.lastOutboundAt) && now - stamp(chat.lastInboundAt) < WAITING_WINDOW_MS)
    .map((chat): WaitingItem => ({
      key: `chat-${chat.id}`, name: chat.customerName || chat.phone || "Cliente", text: `WhatsApp: ${chat.lastMessagePreview || "nuovo messaggio"}`,
      at: stamp(chat.lastInboundAt), href: `/chat?conversationId=${encodeURIComponent(chat.id)}`
    }));
  const emails = mail.filter((item) => item.direction === "inbound" && !item.readAt).map((item): WaitingItem => ({
    key: `mail-${item.id}`, name: item.leadName || item.fromName || item.from || "Cliente", text: `Email: ${item.subject || "(senza oggetto)"}`, at: stamp(item.receivedAt), href: "/email"
  }));
  return [...chats, ...emails].sort((a, b) => b.at - a.at);
}

export function buildOperatorDay(input: { tasks: CrmTask[]; leads: DayLead[]; conversations: DayChat[]; mail: DayMail[]; calls: DayCall[]; now: number }) {
  const { now } = input;
  const agenda = buildAgenda(input.tasks, input.leads, now);
  const today = romeDayStamp(now);
  const late = agenda.filter((item) => item.late).length;
  const planned = agenda.length - late;
  const done = input.calls.filter((call) => stamp(call.startedAt) && romeDayStamp(stamp(call.startedAt)) === today).length;
  const waiting = buildWaiting(input.conversations, input.mail, now);
  return {
    agenda, waiting, late, planned, done,
    next: agenda.find((item) => !item.late) || agenda[0] || null,
    newLeads: input.leads.filter((lead) => lead.status === "Da contattare").length,
    chats: waiting.filter((item) => item.key.startsWith("chat-")).length,
    emails: waiting.filter((item) => item.key.startsWith("mail-")).length
  };
}

export function dueLabel(item: AgendaItem) {
  return item.late ? `Era alle ${item.time}, in ritardo` : `Alle ${item.time}`;
}
