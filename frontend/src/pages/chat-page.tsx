import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getAuthUser } from "../lib/auth";
import { api } from "../lib/api";
import { buildPracticeUrl } from "../features/practices/practice-links";
import {
  CrmTask,
  getLeadDetailCacheEntry,
  getTaskBoardCache,
  isLeadDetailCacheFresh,
  isTaskBoardCacheFresh,
  setLeadDetailCacheEntry,
  setTaskBoardCache
} from "../store/crm-store";
import "../styles/chat-page.css";

type ConversationStatus = "open" | "waiting_customer" | "resolved";
type InboxFilter = "all" | "unread" | "mine" | "unassigned" | "resolved";
type MessageMode = "text" | "template";

type Conversation = {
  id: string;
  leadId?: string | null;
  customerName?: string;
  phone?: string;
  unreadCount?: number;
  lastMessagePreview?: string;
  lastMessageAt?: string;
  assignedTo?: string;
  status?: ConversationStatus | string;
  channel?: string;
  lastInboundAt?: string | null;
  lastOutboundAt?: string | null;
  replyWindowExpiresAt?: string | null;
  hasOpenSession?: boolean;
};

type Message = {
  id: string;
  direction: "inbound" | "outbound";
  text: string;
  createdAt: string;
  status?: string;
  messageType?: string;
  templateKey?: string;
  templateName?: string;
};

type Lead = {
  id: string;
  fullName: string;
  phone?: string;
  email?: string;
  status?: string;
  assignedTo?: string;
  documents?: {
    items?: Array<{ required?: boolean; received?: boolean; verified?: boolean }>;
  };
  payments?: {
    items?: Array<{ required?: boolean; status?: string; amount?: number }>;
  };
};

type LeadDetail = {
  lead: Lead;
};

type TaskBoardPayload = {
  tasks: CrmTask[];
  leads: Lead[];
};

type TemplateOption = {
  key: string;
  name: string;
  label: string;
  body: string;
  category: "utility" | "followup";
  suggestionTag?: string;
};

const FALLBACK_TEMPLATE_OPTIONS: TemplateOption[] = [
  {
    key: "reopen_contact",
    name: "reopen_contact",
    label: "Ricontatto pratica",
    body: "Ciao, ti ricontattiamo per aggiornarti sulla tua pratica.",
    category: "followup"
  },
  {
    key: "request_documents",
    name: "request_documents",
    label: "Richiesta documenti",
    body: "Ciao, ci servono i documenti mancanti per proseguire con la pratica.",
    category: "utility"
  },
  {
    key: "payment_followup",
    name: "payment_followup",
    label: "Promemoria pagamento",
    body: "Ciao, ti contattiamo per il pagamento in sospeso della tua pratica.",
    category: "utility"
  },
  {
    key: "booking_update",
    name: "booking_update",
    label: "Aggiornamento prenotazione",
    body: "Ciao, abbiamo un aggiornamento sulla tua prenotazione.",
    category: "utility"
  }
];

function getConversationStatusLabel(status?: string) {
  if (status === "resolved") return "Chiusa";
  if (status === "waiting_customer") return "In gestione";
  return "Aperta";
}

function getConversationStatusClass(status?: string) {
  if (status === "resolved") return "chat-react-status-resolved";
  if (status === "waiting_customer") return "chat-react-status-waiting";
  return "chat-react-status-open";
}

function getMessageStatusLabel(status?: string) {
  if (status === "read") return "Letto";
  if (status === "delivered") return "Consegnato";
  if (status === "sent") return "Inviato";
  if (status === "failed") return "Errore";
  if (status === "simulated") return "Simulato";
  return status || "";
}

function getMessageStatusClass(status?: string) {
  if (status === "read") return "chat-react-message-status-read";
  if (status === "delivered") return "chat-react-message-status-delivered";
  if (status === "failed") return "chat-react-message-status-failed";
  if (status === "simulated") return "chat-react-message-status-simulated";
  return "chat-react-message-status-sent";
}

function formatDateTime(value?: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "-";
  return date.toLocaleString("it-IT", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function formatShortTime(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
}

function formatDayLabel(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = today - 24 * 60 * 60 * 1000;
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  if (target === today) return "Oggi";
  if (target === yesterday) return "Ieri";
  return date.toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function compareConversations(a: Conversation, b: Conversation) {
  const unreadDelta = Number(b.unreadCount || 0) - Number(a.unreadCount || 0);
  if (unreadDelta) return unreadDelta;
  const inboundDelta = new Date(b.lastInboundAt || b.lastMessageAt || 0).getTime() - new Date(a.lastInboundAt || a.lastMessageAt || 0).getTime();
  if (inboundDelta) return inboundDelta;
  return new Date(b.lastMessageAt || 0).getTime() - new Date(a.lastMessageAt || 0).getTime();
}

function getConversationPriorityScore(conversation: Conversation, authUsername: string) {
  let score = 0;
  if (conversation.status === "resolved") score -= 200;
  else if (conversation.status === "waiting_customer") score += 70;
  else score += 90;
  if (Number(conversation.unreadCount || 0) > 0) score += 120;
  if (authUsername && String(conversation.assignedTo || "") === authUsername) score += 35;
  if (!String(conversation.assignedTo || "").trim()) score += 20;
  if (conversation.hasOpenSession) score += 10;
  return score;
}

function getAvatarLabel(name?: string, phone?: string) {
  const raw = String(name || phone || "?").trim();
  if (!raw) return "?";
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0] || ""}${parts[1][0] || ""}`.toUpperCase();
  return raw.slice(0, 2).toUpperCase();
}

export function ChatPage() {
  const navigate = useNavigate();
  const authUser = getAuthUser();
  const authUsername = String(authUser?.username || authUser?.name || "").trim();

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [leadDetail, setLeadDetail] = useState<LeadDetail | null>(null);
  const [leadLoading, setLeadLoading] = useState(false);
  const [leadError, setLeadError] = useState("");
  const [tasks, setTasks] = useState<CrmTask[]>(() => getTaskBoardCache()?.data.tasks || []);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [to, setTo] = useState("");
  const [search, setSearch] = useState("");
  const [sending, setSending] = useState(false);
  const [chatError, setChatError] = useState("");
  const [inboxFilter, setInboxFilter] = useState<InboxFilter>("all");
  const [messageMode, setMessageMode] = useState<MessageMode>("template");
  const [templateKey, setTemplateKey] = useState<string>(FALLBACK_TEMPLATE_OPTIONS[0].key);
  const [patchingConversation, setPatchingConversation] = useState(false);
  const [templates, setTemplates] = useState<TemplateOption[]>(FALLBACK_TEMPLATE_OPTIONS);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);

  async function loadConversations() {
    setChatError("");
    const data = await api<Conversation[]>("/api/whatsapp/conversations");
    const normalized = (Array.isArray(data) ? data : []).sort(compareConversations);
    setConversations(normalized);
    setSelectedId((prev) => (prev && normalized.some((item) => item.id === prev) ? prev : normalized[0]?.id || null));
  }

  async function loadTaskBoard() {
    if (isTaskBoardCacheFresh() && getTaskBoardCache()?.data) {
      setTasks(getTaskBoardCache()?.data.tasks || []);
      return;
    }
    const payload = await api<TaskBoardPayload>("/api/tasks/board");
    setTasks(Array.isArray(payload?.tasks) ? payload.tasks : []);
    setTaskBoardCache(Array.isArray(payload?.tasks) ? payload.tasks : [], Array.isArray(payload?.leads) ? payload.leads : []);
  }

  async function loadTemplates() {
    const payload = await api<TemplateOption[]>("/api/whatsapp/templates");
    const normalized = Array.isArray(payload) && payload.length ? payload : FALLBACK_TEMPLATE_OPTIONS;
    setTemplates(normalized);
    setTemplateKey((prev) => (normalized.some((item) => item.key === prev) ? prev : normalized[0].key));
  }

  async function loadMessages(conversationId: string) {
    setChatError("");
    const payload = await api<{ conversation: Conversation; messages: Message[] }>(`/api/whatsapp/conversations/${conversationId}/messages`);
    setMessages(payload.messages || []);
    setTo(payload.conversation?.phone || "");
    if (payload.conversation?.id) {
      setConversations((prev) =>
        prev.map((item) => (item.id === payload.conversation.id ? { ...item, ...payload.conversation, unreadCount: 0 } : item)).sort(compareConversations)
      );
    }
  }

  async function patchConversation(patch: Partial<Conversation>) {
    if (!selectedId || patchingConversation) return;
    setPatchingConversation(true);
    setChatError("");
    const previousConversations = conversations;
    try {
      setConversations((prev) => prev.map((item) => (item.id === selectedId ? { ...item, ...patch } : item)));
      const updated = await api<Conversation>(`/api/whatsapp/conversations/${selectedId}`, {
        method: "PATCH",
        body: JSON.stringify(patch)
      });
      setConversations((prev) => prev.map((item) => (item.id === updated.id ? updated : item)).sort(compareConversations));
    } catch (error) {
      setConversations(previousConversations);
      setChatError(error instanceof Error ? error.message : "Errore aggiornamento conversazione.");
    } finally {
      setPatchingConversation(false);
    }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const selectedTemplate = templates.find((item) => item.key === templateKey) || templates[0] || FALLBACK_TEMPLATE_OPTIONS[0];
    if (messageMode === "text" && !text.trim()) return;
    if (messageMode === "template" && !selectedTemplate) return;
    if (!to.trim() || sending) return;

    setSending(true);
    setChatError("");
    try {
      await api("/api/whatsapp/messages/send", {
        method: "POST",
        body: JSON.stringify({
          conversationId: selectedId,
          to,
          text: messageMode === "text" ? text : selectedTemplate.body,
          mode: messageMode,
          templateKey: messageMode === "template" ? selectedTemplate.key : undefined,
          templateName: messageMode === "template" ? selectedTemplate.name : undefined,
          agentName: authUsername || "operatore react"
        })
      });
      setText("");
      await loadConversations();
      if (selectedId) await loadMessages(selectedId);
    } catch (error) {
      setChatError(error instanceof Error ? error.message : "Errore durante l'invio del messaggio.");
    } finally {
      setSending(false);
    }
  }

  useEffect(() => {
    loadConversations().catch((error: Error) => setChatError(error.message));
    loadTaskBoard().catch((error: Error) => setLeadError(error.message));
    loadTemplates().catch(() => setTemplates(FALLBACK_TEMPLATE_OPTIONS));
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      loadConversations().catch(() => null);
      if (selectedId) loadMessages(selectedId).catch(() => null);
    }, 15000);
    return () => window.clearInterval(timer);
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    loadMessages(selectedId).catch((error: Error) => setChatError(error.message));
  }, [selectedId]);

  const selectedConversation = conversations.find((conv) => conv.id === selectedId) || null;

  useEffect(() => {
    if (!selectedConversation) {
      setMessageMode("template");
      return;
    }
    setMessageMode(selectedConversation.hasOpenSession ? "text" : "template");
  }, [selectedConversation?.id, selectedConversation?.hasOpenSession]);

  useEffect(() => {
    if (messageMode !== "text") return;
    textAreaRef.current?.focus();
  }, [messageMode, selectedId]);

  useEffect(() => {
    const leadId = selectedConversation?.leadId || "";
    setLeadError("");
    if (!leadId) {
      setLeadDetail(null);
      setLeadLoading(false);
      return;
    }

    const cached = getLeadDetailCacheEntry(leadId);
    if (cached && isLeadDetailCacheFresh(leadId)) {
      setLeadDetail(cached.data as LeadDetail);
      setLeadLoading(false);
      return;
    }

    setLeadLoading(true);
    api<LeadDetail>(`/api/leads/${leadId}`)
      .then((payload) => {
        setLeadDetail(payload);
        setLeadDetailCacheEntry(leadId, payload as never);
      })
      .catch((error: Error) => {
        setLeadError(error.message);
        setLeadDetail(null);
      })
      .finally(() => setLeadLoading(false));
  }, [selectedConversation?.leadId]);

  const currentLead = leadDetail?.lead || null;
  const openTasks = useMemo(
    () => tasks.filter((task) => task.status === "open" && task.leadId && task.leadId === selectedConversation?.leadId).slice(0, 4),
    [tasks, selectedConversation?.leadId]
  );

  const missingDocumentsCount = useMemo(() => {
    const items = currentLead?.documents?.items || [];
    return items.filter((item) => item.required && (!item.received || !item.verified)).length;
  }, [currentLead]);

  const pendingPayments = useMemo(() => {
    const items = currentLead?.payments?.items || [];
    return items.filter((item) => item.required && item.status !== "verified");
  }, [currentLead]);

  const pendingPaymentAmount = pendingPayments.reduce((sum, item) => sum + Number(item.amount || 0), 0);

  const suggestedTemplates = useMemo(() => {
    if (pendingPayments.length) {
      const matches = templates.filter((item) => item.suggestionTag === "payments");
      if (matches.length) return matches;
    }
    if (missingDocumentsCount) {
      const matches = templates.filter((item) => item.suggestionTag === "documents");
      if (matches.length) return matches;
    }
    if (openTasks.length) {
      const matches = templates.filter((item) => item.suggestionTag === "task");
      if (matches.length) return matches;
    }
    const generic = templates.filter((item) => item.suggestionTag === "generic");
    return generic.length ? generic : templates;
  }, [missingDocumentsCount, openTasks.length, pendingPayments.length, templates]);

  useEffect(() => {
    if (!suggestedTemplates.some((item) => item.key === templateKey)) {
      setTemplateKey(suggestedTemplates[0]?.key || templates[0]?.key || FALLBACK_TEMPLATE_OPTIONS[0].key);
    }
  }, [suggestedTemplates, templateKey, templates]);

  const sortedConversations = useMemo(
    () =>
      [...conversations].sort((a, b) => {
        const priorityDelta = getConversationPriorityScore(b, authUsername) - getConversationPriorityScore(a, authUsername);
        if (priorityDelta) return priorityDelta;
        return compareConversations(a, b);
      }),
    [authUsername, conversations]
  );

  const filterCounts = useMemo(
    () => ({
      unread: sortedConversations.filter((item) => Number(item.unreadCount || 0) > 0).length,
      mine: sortedConversations.filter((item) => authUsername && String(item.assignedTo || "") === authUsername).length,
      unassigned: sortedConversations.filter((item) => !String(item.assignedTo || "").trim()).length,
      resolved: sortedConversations.filter((item) => item.status === "resolved").length
    }),
    [authUsername, sortedConversations]
  );

  const visibleConversations = useMemo(() => {
    const q = search.trim().toLowerCase();
    return sortedConversations.filter((conv) => {
      const hay = `${conv.customerName || ""} ${conv.phone || ""} ${conv.lastMessagePreview || ""}`.toLowerCase();
      if (q && !hay.includes(q)) return false;
      if (inboxFilter === "unread") return Number(conv.unreadCount || 0) > 0;
      if (inboxFilter === "mine") return Boolean(authUsername) && String(conv.assignedTo || "") === authUsername;
      if (inboxFilter === "unassigned") return !String(conv.assignedTo || "").trim();
      if (inboxFilter === "resolved") return conv.status === "resolved";
      return true;
    });
  }, [authUsername, inboxFilter, search, sortedConversations]);

  const selectedTemplate =
    suggestedTemplates.find((item) => item.key === templateKey) || suggestedTemplates[0] || templates[0] || FALLBACK_TEMPLATE_OPTIONS[0];
  const canSendFreeText = Boolean(selectedConversation?.hasOpenSession);
  const sessionNotice = selectedConversation?.hasOpenSession
    ? `Finestra aperta fino a ${formatDateTime(selectedConversation.replyWindowExpiresAt)}`
    : "Finestra chiusa: puoi inviare solo template WhatsApp approvati.";
  const threadItems = useMemo(() => {
    const items: Array<{ type: "day"; label: string } | { type: "message"; message: Message }> = [];
    let lastDay = "";
    for (const message of messages) {
      const currentDay = formatDayLabel(message.createdAt);
      if (currentDay && currentDay !== lastDay) {
        items.push({ type: "day", label: currentDay });
        lastDay = currentDay;
      }
      items.push({ type: "message", message });
    }
    return items;
  }, [messages]);

  useEffect(() => {
    if (!threadRef.current) return;
    threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [threadItems.length]);

  return (
    <div className="chat-react-layout">
      <aside className="panel">
        <div className="chat-react-list-head">
          <h3>Conversazioni</h3>
          <span>{visibleConversations.length}</span>
        </div>
        <div className="chat-react-filters">
          <button type="button" className={inboxFilter === "all" ? "active" : ""} onClick={() => setInboxFilter("all")}>
            Tutte
          </button>
          <button type="button" className={inboxFilter === "unread" ? "active" : ""} onClick={() => setInboxFilter("unread")}>
            Non lette {filterCounts.unread}
          </button>
          <button type="button" className={inboxFilter === "mine" ? "active" : ""} onClick={() => setInboxFilter("mine")}>
            Mie {filterCounts.mine}
          </button>
          <button type="button" className={inboxFilter === "unassigned" ? "active" : ""} onClick={() => setInboxFilter("unassigned")}>
            Libere {filterCounts.unassigned}
          </button>
          <button type="button" className={inboxFilter === "resolved" ? "active" : ""} onClick={() => setInboxFilter("resolved")}>
            Risolte {filterCounts.resolved}
          </button>
        </div>
        <input className="chat-react-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Cerca chat..." />
        <div className="chat-react-list">
          {visibleConversations.map((conv) => (
            <button
              key={conv.id}
              type="button"
              className={`chat-react-conv ${selectedId === conv.id ? "active" : ""}`}
              onClick={() => setSelectedId(conv.id)}
            >
              <div className="chat-react-conv-top">
                <strong>{conv.customerName || conv.phone}</strong>
                <div className="chat-react-conv-meta">
                  <small>{formatShortTime(conv.lastMessageAt)}</small>
                  {conv.unreadCount ? <em>{conv.unreadCount}</em> : null}
                </div>
              </div>
              <div className="chat-react-conv-badges">
                <span className={`chat-react-status-pill ${getConversationStatusClass(conv.status)}`}>{getConversationStatusLabel(conv.status)}</span>
                {Number(conv.unreadCount || 0) > 0 ? <span className="chat-react-list-flag unread">Non letta</span> : null}
                {authUsername && String(conv.assignedTo || "") === authUsername ? <span className="chat-react-list-flag mine">Assegnata a me</span> : null}
                {conv.status === "waiting_customer" ? <span className="chat-react-list-flag waiting">In attesa cliente</span> : null}
                <span className={`chat-react-session-pill ${conv.hasOpenSession ? "open" : "closed"}`}>{conv.hasOpenSession ? "24h aperta" : "Template"}</span>
              </div>
              <span>{conv.lastMessagePreview || "Nessun messaggio"}</span>
              <small>
                {conv.assignedTo ? `Assegnata a ${conv.assignedTo}` : "Non assegnata"} • {formatDateTime(conv.lastMessageAt)}
              </small>
            </button>
          ))}
          {!visibleConversations.length ? <p className="muted">Nessuna conversazione trovata.</p> : null}
        </div>
      </aside>

      <section className="panel chat-react-main">
        <div className="chat-react-thread-head">
          <div>
            <h3>{selectedConversation?.customerName || selectedConversation?.phone || "Thread"}</h3>
            <span className="muted">{selectedConversation?.phone || "-"}</span>
          </div>
          {selectedConversation ? (
            <div className="chat-react-thread-meta">
              <span className={`chat-react-status-pill ${getConversationStatusClass(selectedConversation.status)}`}>
                {getConversationStatusLabel(selectedConversation.status)}
              </span>
              <span className={`chat-react-session-pill ${selectedConversation.hasOpenSession ? "open" : "closed"}`}>
                {selectedConversation.hasOpenSession ? "Sessione 24h aperta" : "Solo template"}
              </span>
            </div>
          ) : null}
        </div>

        {selectedConversation ? <div className={`chat-react-session-banner ${selectedConversation.hasOpenSession ? "open" : "closed"}`}>{sessionNotice}</div> : null}
        {chatError ? <div className="chat-react-error">{chatError}</div> : null}

        <div className="chat-react-thread" ref={threadRef}>
          {threadItems.map((item, index) =>
            item.type === "day" ? (
              <div key={`${item.label}-${index}`} className="chat-react-day-separator">
                <span>{item.label}</span>
              </div>
            ) : (
              <div key={item.message.id} className={`chat-react-bubble-row ${item.message.direction === "outbound" ? "out" : "in"}`}>
                <span className={`chat-react-avatar ${item.message.direction === "outbound" ? "agent" : "customer"}`}>
                  {item.message.direction === "outbound"
                    ? getAvatarLabel(authUser?.name || authUser?.username || "OP")
                    : getAvatarLabel(selectedConversation?.customerName, selectedConversation?.phone)}
                </span>
                <article className={`chat-react-bubble ${item.message.direction === "outbound" ? "out" : "in"}`}>
                  <p>{item.message.text}</p>
                  <span>
                    {item.message.messageType === "template" ? "Template • " : ""}
                    {new Date(item.message.createdAt).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}
                    {item.message.direction === "outbound" && item.message.status ? (
                      <>
                        {" • "}
                        <em className={`chat-react-message-status ${getMessageStatusClass(item.message.status)}`}>
                          {getMessageStatusLabel(item.message.status)}
                        </em>
                      </>
                    ) : null}
                  </span>
                </article>
              </div>
            )
          )}
          {!messages.length ? <p className="muted">Nessun messaggio nella conversazione.</p> : null}
        </div>

        <form className="chat-react-send" onSubmit={sendMessage}>
          <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="Numero" disabled={Boolean(selectedConversation?.phone)} />
          <div className="chat-react-composer">
            <div className="chat-react-mode-switch">
              <button
                type="button"
                className={messageMode === "text" ? "active" : ""}
                disabled={!canSendFreeText}
                onClick={() => setMessageMode("text")}
              >
                Testo libero
              </button>
              <button type="button" className={messageMode === "template" ? "active" : ""} onClick={() => setMessageMode("template")}>
                Template
              </button>
            </div>

            {messageMode === "template" ? (
              <>
                <select value={templateKey} onChange={(e) => setTemplateKey(e.target.value)}>
                  {suggestedTemplates.map((item) => (
                    <option key={item.key} value={item.key}>
                      {item.label}
                    </option>
                  ))}
                </select>
                <div className="chat-react-template-preview">
                  <strong>{selectedTemplate.label}</strong>
                  <span>{selectedTemplate.body}</span>
                </div>
              </>
            ) : (
              <textarea
                ref={textAreaRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Scrivi un messaggio..."
                rows={2}
                disabled={!canSendFreeText}
                autoFocus={messageMode === "text"}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
              />
            )}
          </div>
          <button
            type="submit"
            disabled={sending || !to.trim() || (messageMode === "text" ? !text.trim() || !canSendFreeText : !selectedTemplate)}
          >
            {sending ? "Invio..." : messageMode === "template" ? "Invia template" : "Invia"}
          </button>
        </form>
      </section>

      <aside className="panel chat-react-detail">
        <h3>Contesto pratica</h3>

        <section className="chat-react-detail-section">
          <div className="chat-react-detail-grid">
            <div>
              <span>Nome</span>
              <strong>{currentLead?.fullName || selectedConversation?.customerName || "-"}</strong>
            </div>
            <div>
              <span>Telefono</span>
              <strong>{currentLead?.phone || selectedConversation?.phone || "-"}</strong>
            </div>
            <div>
              <span>Stato pratica</span>
              <strong>{currentLead?.status || (selectedConversation?.leadId ? "Caricamento..." : "Non collegata")}</strong>
            </div>
            <div>
              <span>Assegnato</span>
              <strong>{selectedConversation?.assignedTo || currentLead?.assignedTo || "-"}</strong>
            </div>
          </div>
        </section>

        {selectedConversation ? (
          <section className="chat-react-detail-section">
            <div className="chat-react-section-head">
              <span>Azioni chat</span>
            </div>
            <div className="chat-react-ops">
              <div className="chat-react-ops-row">
                <button type="button" disabled={patchingConversation || !authUsername} onClick={() => patchConversation({ assignedTo: authUsername })}>
                  Assegna a me
                </button>
                <button type="button" className="secondary" disabled={patchingConversation} onClick={() => patchConversation({ assignedTo: "" })}>
                  Libera
                </button>
              </div>
              <div className="chat-react-ops-row">
                <button type="button" className="secondary" disabled={patchingConversation} onClick={() => patchConversation({ status: "open" })}>
                  Apri
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={patchingConversation}
                  onClick={() => patchConversation({ status: "waiting_customer" })}
                >
                  In gestione
                </button>
                <button type="button" disabled={patchingConversation} onClick={() => patchConversation({ status: "resolved" })}>
                  Chiudi
                </button>
              </div>
            </div>
          </section>
        ) : null}

        {leadLoading ? <p className="muted">Caricamento contesto pratica...</p> : null}
        {leadError ? <p className="chat-react-error">{leadError}</p> : null}

        {currentLead ? (
          <>
            <section className="chat-react-detail-section">
              <div className="chat-react-section-head">
                <span>Segnali CRM</span>
              </div>
              <div className="chat-react-context-kpis">
                <button type="button" onClick={() => navigate(buildPracticeUrl(currentLead.id, "task"))}>
                  <strong>{openTasks.length}</strong>
                  <span>Task aperti</span>
                </button>
                <button type="button" onClick={() => navigate(buildPracticeUrl(currentLead.id, "documents"))}>
                  <strong>{missingDocumentsCount}</strong>
                  <span>Documenti mancanti</span>
                </button>
                <button type="button" onClick={() => navigate(buildPracticeUrl(currentLead.id, "payments"))}>
                  <strong>{pendingPayments.length}</strong>
                  <span>Pagamenti sospesi</span>
                </button>
              </div>
              {pendingPaymentAmount > 0 ? <p className="chat-react-warning">Residuo pagamenti: EUR {pendingPaymentAmount}</p> : null}
            </section>

            <section className="chat-react-detail-section">
              <div className="chat-react-section-head">
                <span>Task collegati</span>
              </div>
              <div className="chat-react-task-list">
                {openTasks.map((task) => (
                  <button key={task.id} type="button" onClick={() => navigate(buildPracticeUrl(currentLead.id, "task"))}>
                    <strong>{task.title}</strong>
                    <span>{task.dueAt ? new Date(task.dueAt).toLocaleDateString("it-IT") : "Da pianificare"}</span>
                  </button>
                ))}
                {!openTasks.length ? <p className="muted">Nessun task aperto collegato.</p> : null}
              </div>
            </section>

            <section className="chat-react-detail-section">
              <div className="chat-react-actions">
                <button type="button" onClick={() => navigate(buildPracticeUrl(currentLead.id, "overview"))}>
                  Apri pratica
                </button>
                <button type="button" className="secondary" onClick={() => navigate(buildPracticeUrl(currentLead.id, "notes"))}>
                  Apri note
                </button>
              </div>
            </section>
          </>
        ) : (
          <div className="chat-react-unlinked">
            <strong>Nessuna pratica collegata</strong>
            <span>La prossima ricezione o invio tentera il collegamento automatico tramite numero.</span>
          </div>
        )}
      </aside>
    </div>
  );
}
