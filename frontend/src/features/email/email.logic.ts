/** Fired after emails are read, so the menu badge does not wait for its next round. */
export const MAIL_READ_EVENT = "leadium:mail-read";

export type MailMessage = {
  id: string;
  direction: "inbound" | "outbound";
  from: string;
  fromName: string;
  to: string;
  subject: string;
  text: string;
  receivedAt: string;
  leadId: string | null;
  leadName?: string;
  attachments: Array<{ filename: string; mimeType: string; size: number }>;
  readAt: string | null;
  sentBy: string;
};

export type MailThread = {
  key: string;
  title: string;
  leadId: string | null;
  from: string;
  subject: string;
  lastAt: string;
  unread: number;
  messages: MailMessage[];
};

/** One conversation per practice; a sender without a practice stands alone until an admin links it. */
export function groupThreads(messages: MailMessage[]) {
  const threads = new Map<string, MailThread>();
  for (const message of [...messages].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))) {
    const key = message.leadId ? `lead:${message.leadId}` : `from:${message.from}`;
    const thread = threads.get(key) || { key, title: "", leadId: message.leadId, from: message.from, subject: "", lastAt: "", unread: 0, messages: [] };
    thread.messages.push(message);
    thread.from = message.direction === "inbound" ? message.from : thread.from === message.from ? message.to : thread.from;
    thread.title = message.leadName || (message.direction === "inbound" ? message.fromName || message.from : "") || thread.title || message.to;
    thread.subject = message.subject || thread.subject;
    thread.lastAt = message.receivedAt;
    if (message.direction === "inbound" && !message.readAt) thread.unread += 1;
    threads.set(key, thread);
  }
  return [...threads.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

/** The screen follows the click at once; the next reload shows what the server really kept. */
export function markRead(messages: MailMessage[], ids: string[], at: string) {
  return messages.map((message) => (ids.includes(message.id) ? { ...message, readAt: at } : message));
}

export function replySubject(subject: string) {
  const value = String(subject || "").trim();
  return /^(re|r|i):/i.test(value) ? value : `Re: ${value || "la tua richiesta"}`;
}

/** The customer's last message is what the reply answers and what the mail client threads on. */
export function lastInbound(thread: MailThread) {
  return [...thread.messages].reverse().find((message) => message.direction === "inbound") || null;
}

export function formatMailTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

export function formatAttachmentSize(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
