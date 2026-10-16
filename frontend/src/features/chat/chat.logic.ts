// Pure chat helpers (no React, no network) so the inbox rules can be unit tested.
import type { AttachmentKind, ChatAttachment, ChatLayoutMode, Conversation, InboxFilter, Message, TemplateOption } from "./chat.types";

const DAY_MS = 24 * 60 * 60 * 1000;

function toDate(value?: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function formatShortTime(value?: string | null) {
  const date = toDate(value);
  return date ? date.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }) : "";
}

export function formatDayLabel(value?: string | null, now = new Date()) {
  const date = toDate(value);
  if (!date) return "";
  const diffDays = Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS);
  if (diffDays === 0) return "Oggi";
  if (diffDays === 1) return "Ieri";
  return date.toLocaleDateString("it-IT", { day: "2-digit", month: "long", year: "numeric" });
}

// WhatsApp-style list timestamp: time today, "Ieri", weekday within a week, otherwise a date.
export function formatListTimestamp(value?: string | null, now = new Date()) {
  const date = toDate(value);
  if (!date) return "";
  const diffDays = Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS);
  if (diffDays <= 0) return formatShortTime(value);
  if (diffDays === 1) return "Ieri";
  if (diffDays < 7) return date.toLocaleDateString("it-IT", { weekday: "short" });
  return date.toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

export function formatFileSize(bytes?: number) {
  const value = Number(bytes || 0);
  if (!value) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}

export function getAvatarLabel(name?: string, phone?: string) {
  const raw = String(name || phone || "?").trim();
  if (!raw) return "?";
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0] || ""}${parts[1][0] || ""}`.toUpperCase();
  return raw.slice(0, 2).toUpperCase();
}

export function getConversationStatusLabel(status?: string) {
  if (status === "resolved") return "Risolta";
  if (status === "waiting_customer") return "In attesa cliente";
  return "Aperta";
}

export function compareByLastMessage(a: Conversation, b: Conversation) {
  return (toDate(b.lastMessageAt)?.getTime() || 0) - (toDate(a.lastMessageAt)?.getTime() || 0);
}

function matchesFilter(conversation: Conversation, filter: InboxFilter, username: string) {
  const assignee = String(conversation.assignedTo || "").trim();
  if (filter === "unread") return Number(conversation.unreadCount || 0) > 0;
  if (filter === "mine") return Boolean(username) && assignee === username;
  if (filter === "unassigned") return !assignee && conversation.status !== "resolved";
  if (filter === "waiting") return conversation.status === "waiting_customer";
  if (filter === "resolved") return conversation.status === "resolved";
  return true;
}

export function filterConversations(conversations: Conversation[], options: { filter: InboxFilter; search: string; username: string }) {
  const query = options.search.trim().toLowerCase();
  const queryDigits = query.replace(/\D+/g, "");
  return conversations
    .filter((conversation) => {
      if (query) {
        const haystack = `${conversation.customerName || ""} ${conversation.lastMessagePreview || ""}`.toLowerCase();
        const phoneDigits = String(conversation.phone || "").replace(/\D+/g, "");
        const phoneMatch = queryDigits.length >= 3 && phoneDigits.includes(queryDigits);
        if (!haystack.includes(query) && !phoneMatch) return false;
      }
      return matchesFilter(conversation, options.filter, options.username);
    })
    .sort(compareByLastMessage);
}

export function countConversationFilters(conversations: Conversation[], username: string): Record<InboxFilter, number> {
  const filters: InboxFilter[] = ["all", "unread", "mine", "unassigned", "waiting", "resolved"];
  return Object.fromEntries(
    filters.map((filter) => [filter, conversations.filter((conversation) => matchesFilter(conversation, filter, username)).length])
  ) as Record<InboxFilter, number>;
}

export type ReplyWindowState = { open: boolean; expiresAt: string | null; label: string; urgent: boolean };

export function getReplyWindowState(conversation: Conversation | null, now = new Date()): ReplyWindowState {
  const expires = toDate(conversation?.replyWindowExpiresAt);
  if (!conversation?.hasOpenSession || !expires || expires.getTime() <= now.getTime()) {
    return { open: false, expiresAt: expires ? expires.toISOString() : null, label: "Finestra 24h chiusa", urgent: false };
  }
  const remainingMs = expires.getTime() - now.getTime();
  const hours = Math.floor(remainingMs / (60 * 60 * 1000));
  const minutes = Math.max(1, Math.floor((remainingMs % (60 * 60 * 1000)) / 60000));
  const remaining = hours >= 1 ? `${hours} h` : `${minutes} min`;
  return { open: true, expiresAt: expires.toISOString(), label: `Finestra aperta · ${remaining}`, urgent: remainingMs < 2 * 60 * 60 * 1000 };
}

export type ThreadMarker = { icon: "call" | "document" | "payment"; label: string; createdAt: string };
export type ThreadItem =
  | { type: "day"; key: string; label: string }
  | { type: "message"; key: string; message: Message }
  | { type: "marker"; key: string; marker: ThreadMarker };

export function buildThreadItems(messages: Message[], markers: ThreadMarker[], now = new Date()): ThreadItem[] {
  const feed = [
    ...messages.map((message) => ({ kind: "message" as const, createdAt: message.createdAt, message })),
    ...markers.map((marker) => ({ kind: "marker" as const, createdAt: marker.createdAt, marker }))
  ].sort((a, b) => (toDate(a.createdAt)?.getTime() || 0) - (toDate(b.createdAt)?.getTime() || 0));
  const items: ThreadItem[] = [];
  let lastDay = "";
  feed.forEach((entry, index) => {
    const day = formatDayLabel(entry.createdAt, now);
    if (day && day !== lastDay) {
      items.push({ type: "day", key: `day-${day}-${index}`, label: day });
      lastDay = day;
    }
    if (entry.kind === "message") items.push({ type: "message", key: entry.message.id, message: entry.message });
    else items.push({ type: "marker", key: `marker-${entry.createdAt}-${index}`, marker: entry.marker });
  });
  return items;
}

export function getTimelineMarker(item: { type?: string; text?: string; createdAt: string }): ThreadMarker | null {
  const type = String(item.type || "").toLowerCase();
  const text = String(item.text || "").trim();
  if (type.includes("call")) return { icon: "call", label: text || "Chiamata registrata", createdAt: item.createdAt };
  if (type.includes("document")) return { icon: "document", label: text || "Documento aggiornato", createdAt: item.createdAt };
  if (type.includes("payment")) return { icon: "payment", label: text || "Pagamento aggiornato", createdAt: item.createdAt };
  return null;
}

export type TextToken = { type: "text"; value: string } | { type: "link"; value: string; href: string };

const LINK_PATTERN = /\b(https?:\/\/[^\s<>"]+|www\.[^\s<>"]+)/gi;

// Only http(s) links become anchors; anything else (javascript:, data:) stays plain text.
export function tokenizeMessageText(text: string): TextToken[] {
  const source = String(text || "");
  const tokens: TextToken[] = [];
  let lastIndex = 0;
  for (const match of source.matchAll(LINK_PATTERN)) {
    const start = match.index ?? 0;
    let value = match[0];
    const trailing = value.match(/[.,;:!?)\]]+$/);
    if (trailing) value = value.slice(0, -trailing[0].length);
    if (start > lastIndex) tokens.push({ type: "text", value: source.slice(lastIndex, start) });
    tokens.push({ type: "link", value, href: value.toLowerCase().startsWith("www.") ? `https://${value}` : value });
    lastIndex = start + value.length;
  }
  if (lastIndex < source.length) tokens.push({ type: "text", value: source.slice(lastIndex) });
  return tokens;
}

export type MessageStatusMeta = { label: string; tone: "pending" | "sent" | "delivered" | "read" | "failed" | "simulated" };

export function getMessageStatusMeta(message: Pick<Message, "status" | "localState">): MessageStatusMeta | null {
  if (message.localState === "sending") return { label: "Invio in corso", tone: "pending" };
  if (message.localState === "failed") return { label: "Non inviato", tone: "failed" };
  const status = String(message.status || "");
  if (status === "read") return { label: "Letto", tone: "read" };
  if (status === "delivered") return { label: "Consegnato", tone: "delivered" };
  if (status === "failed") return { label: "Non consegnato", tone: "failed" };
  if (status === "simulated") return { label: "Simulato (WhatsApp non collegato)", tone: "simulated" };
  if (status === "sent") return { label: "Inviato", tone: "sent" };
  return null;
}

// --- Attachments -----------------------------------------------------------------------------

// Mirrors backend/services/api-gateway/chat-upload-rules.ts (the server re-validates everything,
// including the file signature; this only gives the operator an immediate, clear answer).
export const CHAT_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;

const EXTENSION_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv"
};

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "heic", "heif"]);
const QUOTE_EXTENSIONS = new Set(["pdf", "doc", "docx", "xls", "xlsx", "csv"]);

export const ATTACHMENT_ACCEPT = {
  image: ".jpg,.jpeg,.png,.webp,.heic,.heif",
  document: ".pdf,.doc,.docx,.xls,.xlsx,.csv",
  quote: ".pdf,.doc,.docx,.xls,.xlsx,.csv"
};

export function getFileExtension(name: string) {
  const match = String(name || "").toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  return match ? match[1] : "";
}

export type ChatFileValidation = { ok: true; mimeType: string } | { ok: false; error: string };

export function validateChatFile(file: { name: string; type?: string; size: number }, purpose: "image" | "document" | "quote"): ChatFileValidation {
  const extension = getFileExtension(file.name);
  const mimeType = EXTENSION_MIME[extension];
  if (!mimeType) return { ok: false, error: `"${file.name}": formato non supportato. Puoi inviare immagini, PDF, Word, Excel o CSV.` };
  if (purpose === "image" && !IMAGE_EXTENSIONS.has(extension)) return { ok: false, error: `"${file.name}" non e un'immagine.` };
  if (purpose === "quote" && !QUOTE_EXTENSIONS.has(extension)) return { ok: false, error: `"${file.name}": il preventivo deve essere PDF, Word o Excel.` };
  if (!file.size) return { ok: false, error: `"${file.name}" e vuoto.` };
  if (file.size > CHAT_UPLOAD_MAX_BYTES) return { ok: false, error: `"${file.name}" supera il limite di 8 MB.` };
  // The extension decides the MIME we declare: browsers report CSV/XLS inconsistently
  // (empty, text/plain or application/vnd.ms-excel depending on the OS).
  return { ok: true, mimeType };
}

type AttachmentDescriptor = Partial<Pick<ChatAttachment, "mimeType" | "filename" | "mediaType">>;

export type AttachmentFamily = "image" | "pdf" | "spreadsheet" | "word" | "audio" | "video" | "file";

export function getAttachmentFamily(attachment: AttachmentDescriptor): AttachmentFamily {
  const mime = String(attachment.mimeType || "").toLowerCase();
  const extension = getFileExtension(attachment.filename || "");
  if (attachment.mediaType === "image" || attachment.mediaType === "sticker" || mime.startsWith("image/")) return "image";
  if (attachment.mediaType === "audio" || mime.startsWith("audio/")) return "audio";
  if (attachment.mediaType === "video" || mime.startsWith("video/")) return "video";
  if (mime === "application/pdf" || extension === "pdf") return "pdf";
  if (mime.includes("spreadsheet") || mime.includes("ms-excel") || mime === "text/csv" || ["xls", "xlsx", "csv"].includes(extension)) return "spreadsheet";
  if (mime.includes("word") || ["doc", "docx"].includes(extension)) return "word";
  return "file";
}

export function getAttachmentTypeLabel(attachment: AttachmentDescriptor) {
  const extension = getFileExtension(attachment.filename || "");
  if (extension) return extension.toUpperCase();
  const family = getAttachmentFamily(attachment);
  if (family === "image") return "Immagine";
  if (family === "audio") return "Audio";
  if (family === "video") return "Video";
  if (family === "pdf") return "PDF";
  return "File";
}

export function getAttachmentKindLabel(kind?: AttachmentKind) {
  if (kind === "quote") return "Preventivo";
  if (kind === "practice_document") return "Documento pratica";
  return "";
}

// --- Errors ----------------------------------------------------------------------------------

const TECHNICAL_ERROR_PATTERN = /[{}<>]|https?:|\bat\s+\S+\s*\(|econn|etimedout|enotfound|internal server|stack|undefined|null|typeerror|syntaxerror|graph\.facebook|meta send failed/i;

/**
 * Turns any thrown error into something an operator can act on. Backend errors are already
 * written in Italian for operators and pass through; network failures and anything that looks
 * technical (JSON, URLs, stack traces, provider payloads) are replaced by a clear fallback.
 */
export function mapChatError(error: unknown, fallback = "Operazione non riuscita. Riprova tra qualche secondo.") {
  const message = String(error instanceof Error ? error.message : error || "").trim();
  if (!message) return fallback;
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(message)) {
    return "Connessione assente o instabile. Controlla la rete e riprova.";
  }
  if (/non autorizzato/i.test(message)) return "Sessione scaduta: accedi di nuovo.";
  if (/finestra .*chiusa/i.test(message)) return "La finestra di 24 ore e chiusa: invia un template approvato per riaprire la conversazione.";
  if (/storage documenti non configurato/i.test(message)) return "Invio allegati non disponibile: lo storage documenti non e configurato.";
  if (/corpo della richiesta troppo grande/i.test(message)) return "Il file supera la dimensione massima consentita (8 MB).";
  if (message.length > 220 || TECHNICAL_ERROR_PATTERN.test(message)) return fallback;
  return message;
}

// --- Templates with Meta variables -----------------------------------------------------------

/**
 * Preview of a template body with its {{n}} variables filled in. Empty values stay visible as
 * the field label in brackets, so the operator sees what is still missing before sending.
 */
export function renderTemplatePreview(template: Pick<TemplateOption, "body" | "parameters"> | null, values: Record<string, string>) {
  let text = String(template?.body || "");
  for (const param of template?.parameters || []) {
    if (param.component !== "body") continue;
    const value = String(values[param.name] || "").trim();
    text = text.split(`{{${param.index}}}`).join(value || `[${param.label}]`);
  }
  return text;
}

// --- New chat --------------------------------------------------------------------------------

/**
 * Normalizes a number typed by the operator into the international digits-only format Meta
 * expects. An Italian mobile typed without prefix (3xx, 10 digits) gets 39 prepended, so the
 * same customer never ends up in two conversations with and without country code.
 */
export function normalizeNewChatPhone(input: string): { phone: string; error: string } {
  let digits = String(input || "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (!digits) return { phone: "", error: "Inserisci il numero di telefono." };
  if (digits.length === 10 && digits.startsWith("3")) digits = `39${digits}`;
  if (digits.length < 8 || digits.length > 15) {
    return { phone: "", error: "Numero non valido: usa il formato internazionale, es. +39 333 1234567." };
  }
  return { phone: digits, error: "" };
}

// --- Layout ----------------------------------------------------------------------------------

export function getChatLayoutMode(width: number): ChatLayoutMode {
  if (width >= 1280) return "wide";
  if (width >= 1024) return "medium";
  if (width >= 768) return "narrow";
  return "mobile";
}

// Below 1024px the conversation list is an overlay/screen of its own, so choosing a chat must
// close it; at wider sizes it is a permanent column and stays put.
export function shouldCloseListOnSelect(mode: ChatLayoutMode) {
  return mode === "narrow" || mode === "mobile";
}

export function isInfoPanelInitiallyOpen(mode: ChatLayoutMode) {
  return mode === "wide";
}

/** Block incomplete Meta variables before creating an outgoing job. Server validates again. */
export function getTemplateParameterError(template: TemplateOption | null, values: Record<string, string>): string {
  for (const parameter of template?.parameters || []) {
    const value = String(values[parameter.name] || "").trim();
    if (!value && parameter.required !== false) return "Compila " + parameter.label + ".";
    if (value && parameter.kind === "url") {
      try {
        const url = new URL(value);
        if (!["http:", "https:"].includes(url.protocol)) return "Inserisci un link preventivo http:// o https:// valido.";
      } catch {
        return "Inserisci un link preventivo http:// o https:// valido.";
      }
    }
  }
  return "";
}
