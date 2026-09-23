import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { getAuthUser } from "../lib/auth";
import { api } from "../lib/api";
import {
  ChatDecisionEngine,
  ChatDecisionLead,
  Payment,
  PracticeDocument,
  sortOperationalTasks
} from "../features/chat/ChatDecisionEngine";
import { getConversationPriorityScore } from "../features/chat/ChatDecisionEngine.logic";
import {
  CrmChatMessage,
  CrmConversation,
  CrmTask,
  getChatConversationsCache,
  getChatMessagesCache,
  getLeadDetailCacheEntry,
  getTaskBoardCache,
  isChatConversationsCacheFresh,
  isChatMessagesCacheFresh,
  isLeadDetailCacheFresh,
  isTaskBoardCacheFresh,
  patchConversationInChatCache,
  setChatConversationsCache,
  setChatMessagesCache,
  setLeadDetailCacheEntry,
  setTaskBoardCache,
  upsertTaskInBoard
} from "../store/crm-store";
import "../styles/chat-page.css";

type ConversationStatus = "open" | "waiting_customer" | "resolved";
type InboxFilter = "all" | "unread" | "mine" | "unassigned" | "resolved";
type MessageMode = "text" | "template";

type Conversation = CrmConversation & {
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

type Message = CrmChatMessage & {
  id: string;
  direction: "inbound" | "outbound";
  text: string;
  createdAt: string;
  status?: string;
  messageType?: string;
  templateKey?: string;
  templateName?: string;
};

type Lead = ChatDecisionLead;

type LeadDetail = {
  lead: Lead;
  timeline?: TimelineItem[];
};

type TimelineItem = {
  type: string;
  text: string;
  actor?: string;
  createdAt: string;
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

function getAvatarLabel(name?: string, phone?: string) {
  const raw = String(name || phone || "?").trim();
  if (!raw) return "?";
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0] || ""}${parts[1][0] || ""}`.toUpperCase();
  return raw.slice(0, 2).toUpperCase();
}

function getLeadOperationalSummary(lead?: Lead | null) {
  const payments = (lead?.payments?.items || []).filter((item) => item.required && item.status !== "verified");
  const documents = (lead?.documents?.items || []).filter((item) => item.required && (!item.received || !item.verified));
  return {
    pendingPaymentAmount: payments.reduce((sum, item) => sum + Number(item.amount || 0), 0),
    pendingPaymentCount: payments.length,
    missingDocumentCount: documents.length
  };
}

function getOperationalMarker(item: TimelineItem) {
  const type = String(item.type || "").toLowerCase();
  const text = String(item.text || "").trim();
  if (type.includes("call")) return { icon: "☎", label: text || "Chiamata registrata" };
  if (type.includes("document")) return { icon: "□", label: text || "Documento aggiornato" };
  if (type.includes("payment")) return { icon: "€", label: text || "Pagamento aggiornato" };
  return null;
}

export function ChatPage() {
  const [searchParams] = useSearchParams();
  const authUser = getAuthUser();
  const authUsername = String(authUser?.username || authUser?.name || "").trim();
  const initialConversations = getChatConversationsCache()?.data || [];
  const initialSelectedId = initialConversations[0]?.id || null;
  const initialMessages = initialSelectedId ? getChatMessagesCache(initialSelectedId)?.data : null;

  const [conversations, setConversations] = useState<Conversation[]>(() => initialConversations.sort(compareConversations));
  const [leadDetail, setLeadDetail] = useState<LeadDetail | null>(null);
  const [leadLoading, setLeadLoading] = useState(false);
  const [leadError, setLeadError] = useState("");
  const [tasks, setTasks] = useState<CrmTask[]>(() => getTaskBoardCache()?.data.tasks || []);
  const [boardLeads, setBoardLeads] = useState<Lead[]>(() => getTaskBoardCache()?.data.leads || []);
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId);
  const [messages, setMessages] = useState<Message[]>(() => initialMessages?.messages || []);
  const [text, setText] = useState("");
  const [to, setTo] = useState(initialMessages?.conversation.phone || initialConversations[0]?.phone || "");
  const [search, setSearch] = useState("");
  const [sending, setSending] = useState(false);
  const [chatError, setChatError] = useState("");
  const [inboxFilter, setInboxFilter] = useState<InboxFilter>("all");
  const [messageMode, setMessageMode] = useState<MessageMode>("template");
  const [templateKey, setTemplateKey] = useState<string>(FALLBACK_TEMPLATE_OPTIONS[0].key);
  const [patchingConversation, setPatchingConversation] = useState(false);
  const [actionBusyKey, setActionBusyKey] = useState("");
  const [completedActionKey, setCompletedActionKey] = useState("");
  const [actionNotice, setActionNotice] = useState("");
  const [paymentsOpen, setPaymentsOpen] = useState(true);
  const [documentsOpen, setDocumentsOpen] = useState(false);
  const [openPaymentMenuId, setOpenPaymentMenuId] = useState("");
  const [templates, setTemplates] = useState<TemplateOption[]>(FALLBACK_TEMPLATE_OPTIONS);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);

  async function loadConversations(options: { force?: boolean } = {}) {
    setChatError("");
    const cached = getChatConversationsCache();
    if (cached?.data?.length) {
      const sorted = [...cached.data].sort(compareConversations);
      setConversations(sorted);
      setSelectedId((prev) => (prev && sorted.some((item) => item.id === prev) ? prev : sorted[0]?.id || null));
      if (!options.force && isChatConversationsCacheFresh()) return;
    }
    const data = await api<Conversation[]>("/api/whatsapp/conversations");
    const normalized = (Array.isArray(data) ? data : []).sort(compareConversations);
    setChatConversationsCache(normalized);
    setConversations(normalized);
    setSelectedId((prev) => (prev && normalized.some((item) => item.id === prev) ? prev : normalized[0]?.id || null));
  }

  async function loadTaskBoard() {
    if (isTaskBoardCacheFresh() && getTaskBoardCache()?.data) {
      setTasks(getTaskBoardCache()?.data.tasks || []);
      setBoardLeads(getTaskBoardCache()?.data.leads || []);
      return;
    }
    const payload = await api<TaskBoardPayload>("/api/tasks/board");
    setTasks(Array.isArray(payload?.tasks) ? payload.tasks : []);
    setBoardLeads(Array.isArray(payload?.leads) ? payload.leads : []);
    setTaskBoardCache(Array.isArray(payload?.tasks) ? payload.tasks : [], Array.isArray(payload?.leads) ? payload.leads : []);
  }

  async function loadLeadContext(leadId?: string | null, options: { force?: boolean } = {}) {
    const targetLeadId = String(leadId || "");
    setLeadError("");
    if (!targetLeadId) {
      setLeadDetail(null);
      setLeadLoading(false);
      return;
    }

    const cached = !options.force ? getLeadDetailCacheEntry(targetLeadId) : null;
    if (cached && isLeadDetailCacheFresh(targetLeadId)) {
      setLeadDetail(cached.data as LeadDetail);
      setLeadLoading(false);
      return;
    }

    setLeadLoading(true);
    try {
      const payload = await api<LeadDetail>(`/api/leads/${targetLeadId}`);
      setLeadDetail(payload);
      setLeadDetailCacheEntry(targetLeadId, payload as never);
    } catch (error) {
      setLeadError(error instanceof Error ? error.message : "Errore caricamento contesto pratica.");
      setLeadDetail(null);
    } finally {
      setLeadLoading(false);
    }
  }

  async function refreshCurrentContext() {
    await Promise.all([loadTaskBoard(), loadLeadContext(selectedConversation?.leadId, { force: true })]);
  }

  async function loadTemplates() {
    const payload = await api<TemplateOption[]>("/api/whatsapp/templates");
    const normalized = Array.isArray(payload) && payload.length ? payload : FALLBACK_TEMPLATE_OPTIONS;
    setTemplates(normalized);
    setTemplateKey((prev) => (normalized.some((item) => item.key === prev) ? prev : normalized[0].key));
  }

  async function loadMessages(conversationId: string) {
    setChatError("");
    const cached = getChatMessagesCache(conversationId);
    if (cached?.data) {
      setMessages(cached.data.messages || []);
      setTo(cached.data.conversation?.phone || "");
      if (isChatMessagesCacheFresh(conversationId)) return;
    }
    const payload = await api<{ conversation: Conversation; messages: Message[] }>(`/api/whatsapp/conversations/${conversationId}/messages`);
    setMessages(payload.messages || []);
    setTo(payload.conversation?.phone || "");
    if (payload.conversation?.id) {
      setChatMessagesCache(payload.conversation.id, payload.conversation, payload.messages || []);
      setConversations((prev) =>
        prev.map((item) => (item.id === payload.conversation.id ? { ...item, ...payload.conversation, unreadCount: 0 } : item)).sort(compareConversations)
      );
      const nextConversations = (getChatConversationsCache()?.data || conversations).map((item) =>
        item.id === payload.conversation.id ? { ...item, ...payload.conversation, unreadCount: 0 } : item
      );
      setChatConversationsCache(nextConversations);
    }
  }

  async function patchConversation(patch: Partial<Conversation>) {
    if (!selectedId || patchingConversation) return;
    setPatchingConversation(true);
    setChatError("");
    const previousConversations = conversations;
    try {
      setConversations((prev) => prev.map((item) => (item.id === selectedId ? { ...item, ...patch } : item)));
      patchConversationInChatCache(selectedId, patch);
      const updated = await api<Conversation>(`/api/whatsapp/conversations/${selectedId}`, {
        method: "PATCH",
        body: JSON.stringify(patch)
      });
      setConversations((prev) => prev.map((item) => (item.id === updated.id ? updated : item)).sort(compareConversations));
      patchConversationInChatCache(updated.id, updated);
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
    const sentMode = messageMode;

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
      if (sentMode === "template") {
        const taskCreated = await createTemplateFollowUp(selectedTemplate);
        showActionNotice(taskCreated ? "Template inviato. Follow-up automatico creato" : "Template inviato");
      }
      await loadConversations({ force: true });
      if (selectedId) await loadMessages(selectedId);
    } catch (error) {
      setChatError(error instanceof Error ? error.message : "Errore durante l'invio del messaggio.");
    } finally {
      setSending(false);
    }
  }

  // Deep-link support for "open WhatsApp" from the Pratica page: ?customerId=/leadId= selects the
  // existing conversation for that Customer if one is already loaded/known server-side, or (with
  // ?phone=) creates an empty one so the operator lands ready to compose. Runs after the initial
  // load so it can override the "select the first conversation" default, not race it.
  async function applyConversationDeepLink() {
    const targetCustomerId = String(searchParams.get("customerId") || "").trim();
    const targetLeadId = String(searchParams.get("leadId") || "").trim();
    const targetPhone = String(searchParams.get("phone") || "").trim();
    const targetCustomerName = String(searchParams.get("customerName") || "").trim();
    if (!targetCustomerId && !targetLeadId) return;

    // Queried server-side rather than checked against local state: this runs right after
    // loadConversations() kicks off its own async setConversations(), so the component's
    // `conversations` closure here could still be the pre-fetch snapshot (stale-closure risk).
    const query = targetCustomerId ? `customerId=${encodeURIComponent(targetCustomerId)}` : `leadId=${encodeURIComponent(targetLeadId)}`;
    const matches = await api<Conversation[]>(`/api/whatsapp/conversations?${query}`);
    let target = Array.isArray(matches) && matches.length ? matches[0] : null;
    if (!target && targetPhone) {
      target = await api<Conversation>("/api/whatsapp/conversations/ensure", {
        method: "POST",
        body: JSON.stringify({
          phone: targetPhone,
          leadId: targetLeadId || undefined,
          customerId: targetCustomerId || undefined,
          customerName: targetCustomerName || undefined
        })
      });
    }
    if (!target) return;
    const resolvedTarget = target;
    setConversations((prev) => (prev.some((item) => item.id === resolvedTarget.id) ? prev : [resolvedTarget, ...prev].sort(compareConversations)));
    setSelectedId(resolvedTarget.id);
  }

  useEffect(() => {
    loadConversations({ force: true })
      .then(() => applyConversationDeepLink())
      .catch((error: Error) => setChatError(error.message));
    loadTaskBoard().catch((error: Error) => setLeadError(error.message));
    loadTemplates().catch(() => setTemplates(FALLBACK_TEMPLATE_OPTIONS));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      loadConversations({ force: true }).catch(() => null);
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
    loadLeadContext(selectedConversation?.leadId).catch((error: Error) => setLeadError(error.message));
  }, [selectedConversation?.leadId]);

  const currentLead = leadDetail?.lead || null;
  const boardLeadById = useMemo(() => new Map(boardLeads.map((lead) => [lead.id, lead])), [boardLeads]);
  const openTasks = useMemo(
    () => tasks.filter((task) => task.status === "open" && task.leadId && task.leadId === selectedConversation?.leadId).sort(sortOperationalTasks),
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

  function showActionNotice(message: string) {
    setActionNotice(message);
    window.setTimeout(() => setActionNotice((current) => (current === message ? "" : current)), 2400);
  }

  function patchLeadPayment(paymentId: string, patch: Partial<Payment>) {
    setLeadDetail((current) => {
      if (!current?.lead?.payments?.items) return current;
      return {
        ...current,
        lead: {
          ...current.lead,
          payments: {
            ...current.lead.payments,
            items: current.lead.payments.items.map((item) => (item.id === paymentId ? { ...item, ...patch } : item))
          }
        }
      };
    });
  }

  function patchLeadDocument(documentId: string, patch: Partial<PracticeDocument>) {
    setLeadDetail((current) => {
      if (!current?.lead?.documents?.items) return current;
      return {
        ...current,
        lead: {
          ...current.lead,
          documents: {
            ...current.lead.documents,
            items: current.lead.documents.items.map((item) => (item.key === documentId ? { ...item, ...patch } : item))
          }
        }
      };
    });
  }

  function patchLocalTask(taskId: string, patch: Partial<CrmTask>) {
    setTasks((current) => current.map((item) => (item.id === taskId ? { ...item, ...patch } : item)));
  }

  function makeDueAt(amount: "1h" | "tomorrow") {
    const due = new Date();
    if (amount === "1h") {
      due.setHours(due.getHours() + 1, 0, 0, 0);
      return due.toISOString();
    }
    due.setDate(due.getDate() + 1);
    due.setHours(9, 0, 0, 0);
    return due.toISOString();
  }

  async function createSmartTask(input: {
    kind: string;
    title: string;
    description: string;
    priority: number;
    dueAt: string;
    meta?: Record<string, unknown>;
  }) {
    if (!currentLead) return null;
    try {
      const task = await api<CrmTask>("/api/tasks", {
        method: "POST",
        body: JSON.stringify({
          leadId: currentLead.id,
          assignedTo: selectedConversation?.assignedTo || authUsername || currentLead.assignedTo || "",
          source: "chat_automation",
          status: "open",
          ...input
        })
      });
      setTasks((current) => [task, ...current.filter((item) => item.id !== task.id)]);
      upsertTaskInBoard(task);
      return task;
    } catch (error) {
      setLeadError(error instanceof Error ? error.message : "Automazione task non completata.");
      return null;
    }
  }

  async function createTemplateFollowUp(template: TemplateOption) {
    const tag = template.suggestionTag || template.key;
    if (tag === "payments" || template.key === "payment_followup") {
      const payment = pendingPayments[0];
      return createSmartTask({
        kind: "payment_follow_up",
        title: `Follow-up pagamento ${currentLead?.fullName || ""}`.trim(),
        description: `Template pagamento inviato dalla chat. Verificare risposta cliente${payment?.label ? ` per ${payment.label}` : ""}.`,
        priority: 82,
        dueAt: makeDueAt("tomorrow"),
        meta: { paymentId: payment?.id || null, automation: "template_payment_follow_up" }
      });
    }
    if (tag === "documents" || template.key === "request_documents") {
      const missingKeys = (currentLead?.documents?.items || []).filter((item) => item.required && (!item.received || !item.verified)).map((item) => item.key);
      return createSmartTask({
        kind: "document_follow_up",
        title: `Follow-up documenti ${currentLead?.fullName || ""}`.trim(),
        description: "Template richiesta documenti inviato dalla chat. Verificare ricezione documenti mancanti.",
        priority: 72,
        dueAt: makeDueAt("tomorrow"),
        meta: { missingKeys, automation: "template_documents_follow_up" }
      });
    }
    if (tag === "task") {
      return createSmartTask({
        kind: "chat_follow_up",
        title: `Follow-up chat ${currentLead?.fullName || ""}`.trim(),
        description: "Template operativo inviato dalla chat. Ricontrollare la conversazione.",
        priority: 65,
        dueAt: makeDueAt("tomorrow"),
        meta: { automation: "template_task_follow_up" }
      });
    }
    if (tag === "callback") {
      return createSmartTask({
        kind: "callback_reminder",
        title: `Confermare richiamo ${currentLead?.fullName || ""}`.trim(),
        description: 'Template "Ricontattami" inviato dalla chat. Attendere la risposta del cliente e programmare il richiamo con data/ora.',
        priority: 75,
        dueAt: makeDueAt("tomorrow"),
        meta: { automation: "template_callback_follow_up" }
      });
    }
    if (tag === "not_interested") {
      return createSmartTask({
        kind: "chat_follow_up",
        title: `Confermare esito ${currentLead?.fullName || ""}`.trim(),
        description: 'Template "Non interessato" inviato dalla chat. Registrare l\'esito definitivo sulla pratica (motivo obbligatorio).',
        priority: 60,
        dueAt: makeDueAt("tomorrow"),
        meta: { automation: "template_not_interested_follow_up" }
      });
    }
    return null;
  }

  async function createPaymentVerificationTask(paymentId: string) {
    const payment = (currentLead?.payments?.items || []).find((item) => item.id === paymentId);
    return createSmartTask({
      kind: "payment_verification",
      title: `Verifica pagamento ${currentLead?.fullName || ""}`.trim(),
      description: `Pagamento segnato come ricevuto dalla chat${payment?.label ? `: ${payment.label}` : ""}. Verificare incasso e chiudere il blocco.`,
      priority: 88,
      dueAt: makeDueAt("1h"),
      meta: { paymentId, automation: "payment_received_verify" }
    });
  }

  async function runContextAction(
    key: string,
    action: () => Promise<void>,
    options: { optimistic?: () => void; notice?: string; afterSuccess?: () => Promise<void> } = {}
  ) {
    if (!currentLead || actionBusyKey) return;
    setActionBusyKey(key);
    setLeadError("");
    try {
      await action();
      options.optimistic?.();
      await options.afterSuccess?.();
      if (options.notice) showActionNotice(options.notice);
      await refreshCurrentContext();
      setCompletedActionKey(key);
      window.setTimeout(() => setCompletedActionKey((current) => (current === key ? "" : current)), 2200);
    } catch (error) {
      setLeadError(error instanceof Error ? error.message : "Errore aggiornamento contesto pratica.");
    } finally {
      setActionBusyKey("");
    }
  }

  function markDocumentReceived(documentId: string) {
    return runContextAction(
      `document:${documentId}`,
      () =>
        api(`/api/leads/${currentLead?.id}/documents/${documentId}`, {
          method: "PATCH",
          body: JSON.stringify({ received: true, actor: authUsername || "chat" })
        }),
      {
        optimistic: () => patchLeadDocument(documentId, { received: true }),
        notice: "Documento segnato come ricevuto"
      }
    );
  }

  function markPaymentReceived(paymentId: string) {
    return runContextAction(
      `payment-received:${paymentId}`,
      () =>
        api(`/api/leads/${currentLead?.id}/payments/${paymentId}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "received", actor: authUsername || "chat" })
        }),
      {
        optimistic: () => patchLeadPayment(paymentId, { status: "received" }),
        afterSuccess: () => createPaymentVerificationTask(paymentId).then(() => undefined),
        notice: "Pagamento segnato come ricevuto. Task verifica creata"
      }
    );
  }

  function verifyPayment(paymentId: string) {
    return runContextAction(
      `payment-verified:${paymentId}`,
      () =>
        api(`/api/leads/${currentLead?.id}/payments/${paymentId}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "verified", actor: authUsername || "chat" })
        }),
      {
        optimistic: () => patchLeadPayment(paymentId, { status: "verified" }),
        notice: "Pagamento verificato"
      }
    );
  }

  function completeTask(taskId: string) {
    return runContextAction(
      `task:${taskId}`,
      () =>
        api(`/api/tasks/${taskId}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "done" })
        }),
      {
        optimistic: () => patchLocalTask(taskId, { status: "done" }),
        notice: "Task completata"
      }
    );
  }

  function postponeTaskOneDay(taskId: string) {
    const due = new Date();
    due.setDate(due.getDate() + 1);
    due.setHours(9, 0, 0, 0);
    return runContextAction(`task-snooze:${taskId}`, () =>
      api(`/api/tasks/${taskId}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "open", dueAt: due.toISOString() })
      })
    );
  }

  function callCustomer() {
    const phone = String(currentLead?.phone || selectedConversation?.phone || "").trim();
    if (!phone) return;
    window.location.href = `tel:${phone}`;
  }

  function scheduleCallback(payload: { followUpAt: string; callbackReason: string }) {
    return runContextAction(
      "schedule-callback",
      () =>
        api(`/api/leads/${currentLead?.id}/calls`, {
          method: "POST",
          body: JSON.stringify({
            disposition: "call_back",
            actor: authUsername || "chat",
            followUpAt: payload.followUpAt,
            callbackReason: payload.callbackReason,
            assignedTo: currentLead?.assignedTo || authUsername || undefined,
            idempotencyKey: `chat_callback_${currentLead?.id}_${Date.now()}`
          })
        }),
      { notice: "Richiamo programmato" }
    );
  }

  function requestDocuments() {
    const template = templates.find((item) => item.suggestionTag === "documents") || templates.find((item) => item.key === "request_documents");
    if (template) {
      setTemplateKey(template.key);
      setMessageMode("template");
      setText(template.body);
    }
    textAreaRef.current?.focus();
  }

  function requestPaymentReminder() {
    const template = templates.find((item) => item.suggestionTag === "payments") || templates.find((item) => item.key === "payment_followup");
    if (template) {
      setTemplateKey(template.key);
      setMessageMode("template");
      setText(template.body);
    }
    textAreaRef.current?.focus();
  }

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

  const visibleConversationRows = useMemo(
    () =>
      visibleConversations.map((conversation) => ({
        ...conversation,
        operational: getLeadOperationalSummary(conversation.leadId ? boardLeadById.get(String(conversation.leadId)) : null)
      })),
    [boardLeadById, visibleConversations]
  );

  const selectedTemplate =
    suggestedTemplates.find((item) => item.key === templateKey) || suggestedTemplates[0] || templates[0] || FALLBACK_TEMPLATE_OPTIONS[0];
  const selectedHeaderName = currentLead?.fullName || selectedConversation?.customerName || selectedConversation?.phone || "Thread";
  const selectedHeaderPhone = currentLead?.phone || selectedConversation?.phone || "-";
  const canSendFreeText = Boolean(selectedConversation?.hasOpenSession);
  const sessionNotice = selectedConversation?.hasOpenSession
    ? `Finestra aperta fino a ${formatDateTime(selectedConversation.replyWindowExpiresAt)}`
    : "Finestra WhatsApp chiusa. Invia un template per riaprire la conversazione.";
  const threadItems = useMemo(() => {
    const operationalMarkers = (leadDetail?.timeline || [])
      .map((item) => {
        const marker = getOperationalMarker(item);
        return marker ? { type: "marker" as const, marker: { ...marker, createdAt: item.createdAt } } : null;
      })
      .filter(Boolean)
      .slice(-8) as Array<{ type: "marker"; marker: { icon: string; label: string; createdAt: string } }>;
    const feed = [
      ...messages.map((message) => ({ type: "message" as const, message, createdAt: message.createdAt })),
      ...operationalMarkers.map((item) => ({ ...item, createdAt: item.marker.createdAt }))
    ].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const items: Array<
      | { type: "day"; label: string }
      | { type: "message"; message: Message }
      | { type: "marker"; marker: { icon: string; label: string; createdAt: string } }
    > = [];
    let lastDay = "";
    for (const item of feed) {
      const currentDay = formatDayLabel(item.createdAt);
      if (currentDay && currentDay !== lastDay) {
        items.push({ type: "day", label: currentDay });
        lastDay = currentDay;
      }
      if (item.type === "message") items.push({ type: "message", message: item.message });
      else items.push({ type: "marker", marker: item.marker });
    }
    return items;
  }, [leadDetail?.timeline, messages]);

  useEffect(() => {
    if (!threadRef.current) return;
    threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [threadItems.length]);

  return (
    <div className="chat-react-layout">
      <aside className="panel">
        <div className="chat-react-list-head">
          <div>
            <h3>Chat</h3>
            <span className="chat-react-channel-badge">WhatsApp</span>
          </div>
          <span>{visibleConversationRows.length}</span>
        </div>
        <input
          className="chat-react-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Cerca per nome o numero..."
        />
        <div className="chat-react-filters">
          <button type="button" className={inboxFilter === "all" ? "active" : ""} onClick={() => setInboxFilter("all")}>
            Tutte <span>{sortedConversations.length}</span>
          </button>
          <button type="button" className={inboxFilter === "unread" ? "active" : ""} onClick={() => setInboxFilter("unread")}>
            Non lette <span>{filterCounts.unread}</span>
          </button>
          <button type="button" className={inboxFilter === "mine" ? "active" : ""} onClick={() => setInboxFilter("mine")}>
            In carico <span>{filterCounts.mine}</span>
          </button>
          <button type="button" className={inboxFilter === "unassigned" ? "active" : ""} onClick={() => setInboxFilter("unassigned")}>
            In attesa <span>{filterCounts.unassigned}</span>
          </button>
          <button type="button" className={inboxFilter === "resolved" ? "active" : ""} onClick={() => setInboxFilter("resolved")}>
            Chiuse <span>{filterCounts.resolved}</span>
          </button>
        </div>
        <div className="chat-react-list">
          {visibleConversationRows.map((conv) => (
            <button
              key={conv.id}
              type="button"
              className={`chat-react-conv ${selectedId === conv.id ? "active" : ""}`}
              onClick={() => setSelectedId(conv.id)}
            >
              <div className="chat-react-conv-top">
                <span className="chat-react-conv-avatar">{getAvatarLabel(conv.customerName, conv.phone)}</span>
                <div>
                  <strong>{conv.customerName || conv.phone}</strong>
                  <span className="chat-react-conv-subtitle">{conv.lastMessagePreview || "Nessun messaggio"}</span>
                </div>
                <div className="chat-react-conv-meta">
                  <small>{formatShortTime(conv.lastMessageAt)}</small>
                  {conv.unreadCount ? <em>{conv.unreadCount}</em> : null}
                </div>
              </div>
              <div className="chat-react-conv-status-line">
                <span className={`chat-react-status-pill ${getConversationStatusClass(conv.status)}`}>
                  {getConversationStatusLabel(conv.status)}
                </span>
                {conv.operational.pendingPaymentCount ? <span className="chat-react-list-flag payment">EUR {conv.operational.pendingPaymentAmount}</span> : null}
                {conv.operational.pendingPaymentCount ? <span className="chat-react-list-flag blockers">{conv.operational.pendingPaymentCount} bloccanti</span> : null}
                {conv.operational.missingDocumentCount ? <span className="chat-react-list-flag docs">{conv.operational.missingDocumentCount} doc</span> : null}
              </div>
            </button>
          ))}
          {!visibleConversationRows.length ? <p className="muted">Nessuna conversazione trovata.</p> : null}
        </div>
        <button type="button" className="chat-react-settings">Impostazioni Chat</button>
      </aside>

      <section className="panel chat-react-main">
        <div className="chat-react-thread-head">
          <div>
            <span className="chat-thread-avatar">{getAvatarLabel(selectedHeaderName, selectedHeaderPhone)}</span>
            <div>
              <h3>{selectedHeaderName}</h3>
              <span className="muted">{selectedHeaderPhone}</span>
            </div>
          </div>
          {selectedConversation ? (
            <div className="chat-react-thread-meta">
              <button type="button" aria-label="Etichetta conversazione">Tag</button>
              <label className="ui-bookmark" aria-label="Aggiungi ai preferiti">
                <input type="checkbox" />
                <svg className="bookmark" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M6 3.5A2.5 2.5 0 0 1 8.5 1h7A2.5 2.5 0 0 1 18 3.5v18a.75.75 0 0 1-1.17.62L12 18.85l-4.83 3.27A.75.75 0 0 1 6 21.5v-18Z" />
                </svg>
              </label>
              <button type="button" aria-label="Altre azioni">...</button>
            </div>
          ) : null}
        </div>

        {selectedConversation ? <div className={`chat-react-session-banner ${selectedConversation.hasOpenSession ? "open" : "closed"}`}>{sessionNotice}</div> : null}
        {actionNotice ? <div className="chat-react-success">{actionNotice}</div> : null}
        {chatError ? <div className="chat-react-error">{chatError}</div> : null}

        <div className="chat-react-thread" ref={threadRef}>
          {threadItems.map((item, index) =>
            item.type === "day" ? (
              <div key={`${item.label}-${index}`} className="chat-react-day-separator">
                <span>{item.label}</span>
              </div>
            ) : item.type === "marker" ? (
              <div key={`${item.marker.createdAt}-${index}`} className="chat-react-op-marker">
                <span>{item.marker.icon}</span>
                <strong>{item.marker.label}</strong>
                <small>{formatShortTime(item.marker.createdAt)}</small>
              </div>
            ) : (
              <div key={item.message.id} className={`chat-react-bubble-row ${item.message.direction === "outbound" ? "out" : "in"}`}>
                <span className={`chat-react-avatar ${item.message.direction === "outbound" ? "agent" : "customer"}`}>
                  {item.message.direction === "outbound"
                    ? getAvatarLabel(authUser?.name || authUser?.username || "OP")
                    : getAvatarLabel(selectedConversation?.customerName, selectedConversation?.phone)}
                </span>
                <article className={`chat-react-bubble ${item.message.direction === "outbound" ? "out" : "in"}`}>
                  {item.message.attachment ? (
                    <div className="chat-react-attachment">
                      <svg className="chat-react-attachment-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                        <path d="M4 12.5 11.5 5a3.5 3.5 0 0 1 5 5L9 17.5a2 2 0 0 1-3-3L13 7.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      <span className="chat-react-attachment-name">{item.message.attachment.filename || "Allegato"}</span>
                    </div>
                  ) : null}
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
                <textarea
                  className="chat-react-message-box"
                  value={selectedTemplate.body}
                  readOnly
                  rows={1}
                  aria-label="Testo template"
                />
              </>
            ) : (
              <textarea
                className="chat-react-message-box"
                ref={textAreaRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Scrivi un messaggio..."
                rows={1}
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
            type="button"
            className="chat-react-cancel"
            onClick={() => setText("")}
            disabled={sending}
          >
            Annulla
          </button>
          <button
            type="submit"
            disabled={sending || !to.trim() || (messageMode === "text" ? !text.trim() || !canSendFreeText : !selectedTemplate)}
            aria-label={messageMode === "template" ? "Invia template" : "Invia messaggio"}
          >
            {sending ? "..." : ">"}
          </button>
        </form>
      </section>

      <ChatDecisionEngine
        lead={currentLead}
        selectedConversation={selectedConversation}
        openTasks={openTasks}
        leadLoading={leadLoading}
        leadError={leadError}
        authUsername={authUsername}
        patchingConversation={patchingConversation}
        actionBusyKey={actionBusyKey}
        completedActionKey={completedActionKey}
        paymentsOpen={paymentsOpen}
        documentsOpen={documentsOpen}
        openPaymentMenuId={openPaymentMenuId}
        onTogglePayments={() => setPaymentsOpen((current) => !current)}
        onToggleDocuments={() => setDocumentsOpen((current) => !current)}
        onTogglePaymentMenu={(paymentId) => setOpenPaymentMenuId((current) => (current === paymentId ? "" : paymentId))}
        onClosePaymentMenu={() => setOpenPaymentMenuId("")}
        onPatchConversation={patchConversation}
        onCallCustomer={callCustomer}
        onRequestDocuments={requestDocuments}
        onRequestPaymentReminder={requestPaymentReminder}
        onScheduleCallback={(payload) => void scheduleCallback(payload)}
        callbackScheduling={actionBusyKey === "schedule-callback"}
        onMarkDocumentReceived={(documentId) => void markDocumentReceived(documentId)}
        onMarkPaymentReceived={(paymentId) => void markPaymentReceived(paymentId)}
        onVerifyPayment={(paymentId) => void verifyPayment(paymentId)}
        onCompleteTask={(taskId) => void completeTask(taskId)}
        onPostponeTaskOneDay={(taskId) => void postponeTaskOneDay(taskId)}
      />
    </div>
  );
}
