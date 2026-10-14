import { DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { WifiOff, X } from "lucide-react";
import { getAuthUser } from "../lib/auth";
import { api } from "../lib/api";
import { ChatDecisionEngine, ChatDecisionLead, Payment, PracticeDocument, sortOperationalTasks } from "../features/chat/ChatDecisionEngine";
import { buildPracticeUrl } from "../features/practices/practice-links";
import { uploadChatFile } from "../features/chat/chat-api";
import {
  buildThreadItems,
  countConversationFilters,
  filterConversations,
  getChatLayoutMode,
  getReplyWindowState,
  getTimelineMarker,
  isInfoPanelInitiallyOpen,
  mapChatError,
  shouldCloseListOnSelect,
  validateChatFile,
  type ThreadMarker
} from "../features/chat/chat.logic";
import type {
  ChatLayoutMode,
  Conversation,
  DraftAttachment,
  InboxFilter,
  Message,
  MessageMode,
  PracticeDocumentAttachment,
  PracticeDocumentOption,
  TemplateOption,
  TimelineItem
} from "../features/chat/chat.types";
import { ChatEmptyState } from "../features/chat/components/ChatEmptyState";
import { ChatHeader } from "../features/chat/components/ChatHeader";
import { Composer } from "../features/chat/components/Composer";
import { ConversationList, type ConversationRow } from "../features/chat/components/ConversationList";
import { MessageThread } from "../features/chat/components/MessageThread";
import {
  CrmTask,
  getChatConversationsCache,
  getChatMessagesCache,
  getLeadDetailCacheEntry,
  getTaskBoardCache,
  isChatConversationsCacheFresh,
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

type Lead = Omit<ChatDecisionLead, "documents"> & {
  documents?: { items?: Array<PracticeDocument & { attachments?: PracticeDocumentAttachment[] }> };
};

type LeadDetail = {
  lead: Lead;
  timeline?: TimelineItem[];
};

type TaskBoardPayload = {
  tasks: CrmTask[];
  leads: Lead[];
};

// A send the operator started; kept so a failed message can be retried exactly as it was.
type OutgoingJob =
  | { kind: "text"; conversationId: string; to: string; text: string }
  | { kind: "template"; conversationId: string; to: string; template: TemplateOption }
  | { kind: "attachment"; conversationId: string; to: string; leadId: string; draft: DraftAttachment; caption: string };

const FALLBACK_TEMPLATE_OPTIONS: TemplateOption[] = [
  { key: "reopen_contact", name: "reopen_contact", label: "Ricontatto pratica", body: "Ciao, ti ricontattiamo per aggiornarti sulla tua pratica.", category: "followup" },
  { key: "request_documents", name: "request_documents", label: "Richiesta documenti", body: "Ciao, ci servono i documenti mancanti per proseguire con la pratica.", category: "utility" },
  { key: "payment_followup", name: "payment_followup", label: "Promemoria pagamento", body: "Ciao, ti contattiamo per il pagamento in sospeso della tua pratica.", category: "utility" },
  { key: "booking_update", name: "booking_update", label: "Aggiornamento prenotazione", body: "Ciao, abbiamo un aggiornamento sulla tua prenotazione.", category: "utility" }
];

const POLL_INTERVAL_MS = 15000;
const MAX_DRAFT_ATTACHMENTS = 10;
const WHATSAPP_CAPTION_MAX = 1024;
const PREVIEWABLE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function newLocalId(prefix: string) {
  return `local_${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function getLeadOperationalSummary(lead?: Lead | null) {
  return {
    pendingPaymentCount: (lead?.payments?.items || []).filter((item) => item.required && item.status !== "verified").length,
    missingDocumentCount: (lead?.documents?.items || []).filter((item) => item.required && (!item.received || !item.verified)).length
  };
}

function useChatLayoutMode() {
  const [mode, setMode] = useState<ChatLayoutMode>(() => getChatLayoutMode(typeof window === "undefined" ? 1440 : window.innerWidth));
  useEffect(() => {
    let frame = 0;
    const onResize = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => setMode(getChatLayoutMode(window.innerWidth)));
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
    };
  }, []);
  return mode;
}

function useOnlineStatus() {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}

export function ChatPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const authUser = getAuthUser();
  const authUsername = String(authUser?.username || authUser?.name || "").trim();
  const layoutMode = useChatLayoutMode();
  const online = useOnlineStatus();

  const [conversations, setConversations] = useState<Conversation[]>(() => getChatConversationsCache()?.data || []);
  const [conversationsLoading, setConversationsLoading] = useState(() => !getChatConversationsCache()?.data?.length);
  const [listError, setListError] = useState("");
  // No conversation is opened automatically: opening one marks it read server-side, so the
  // operator must choose it (previously the first unread chat was silently marked as read).
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [pendingByConversation, setPendingByConversation] = useState<Record<string, Message[]>>({});
  const [localPreviews, setLocalPreviews] = useState<Record<string, string>>({});
  const retryJobs = useRef(new Map<string, OutgoingJob>());

  const [search, setSearch] = useState("");
  const [inboxFilter, setInboxFilter] = useState<InboxFilter>("all");
  const [textDrafts, setTextDrafts] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<DraftAttachment[]>([]);
  const [fileError, setFileError] = useState("");
  const [messageMode, setMessageMode] = useState<MessageMode>("text");
  const [templates, setTemplates] = useState<TemplateOption[]>(FALLBACK_TEMPLATE_OPTIONS);
  const [templateKey, setTemplateKey] = useState(FALLBACK_TEMPLATE_OPTIONS[0].key);
  const [sending, setSending] = useState(false);
  const [chatError, setChatError] = useState("");
  const [notice, setNotice] = useState("");
  const [patchingConversation, setPatchingConversation] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [listOpen, setListOpen] = useState(true);
  const [infoOpen, setInfoOpen] = useState(() => isInfoPanelInitiallyOpen(layoutMode));

  const [leadDetail, setLeadDetail] = useState<LeadDetail | null>(null);
  const [leadLoading, setLeadLoading] = useState(false);
  const [leadError, setLeadError] = useState("");
  const [tasks, setTasks] = useState<CrmTask[]>(() => getTaskBoardCache()?.data.tasks || []);
  const [boardLeads, setBoardLeads] = useState<Lead[]>(() => (getTaskBoardCache()?.data.leads || []) as Lead[]);
  const [actionBusyKey, setActionBusyKey] = useState("");
  const [completedActionKey, setCompletedActionKey] = useState("");
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);

  selectedIdRef.current = selectedId;
  const selectedConversation = conversations.find((conversation) => conversation.id === selectedId) || null;
  const replyWindow = getReplyWindowState(selectedConversation);
  const text = selectedId ? textDrafts[selectedId] || "" : "";

  useEffect(() => {
    setInfoOpen(isInfoPanelInitiallyOpen(layoutMode));
  }, [layoutMode]);

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice((current) => (current === message ? "" : current)), 2600);
  }, []);

  const loadConversations = useCallback(async (options: { force?: boolean } = {}) => {
    if (!options.force && isChatConversationsCacheFresh() && getChatConversationsCache()?.data?.length) {
      setConversations(getChatConversationsCache()?.data || []);
      setConversationsLoading(false);
      return;
    }
    try {
      const data = await api<Conversation[]>("/api/whatsapp/conversations");
      const normalized = Array.isArray(data) ? data : [];
      setChatConversationsCache(normalized);
      setConversations(normalized);
      setListError("");
    } catch (error) {
      setListError(mapChatError(error, "Impossibile aggiornare le conversazioni."));
    } finally {
      setConversationsLoading(false);
    }
  }, []);

  const loadMessages = useCallback(async (conversationId: string) => {
    const cached = getChatMessagesCache(conversationId);
    if (cached?.data && selectedIdRef.current === conversationId) setMessages(cached.data.messages as Message[]);
    try {
      const payload = await api<{ conversation: Conversation; messages: Message[] }>(`/api/whatsapp/conversations/${conversationId}/messages`);
      // The operator may have opened another chat while this request was in flight.
      if (selectedIdRef.current !== conversationId) return;
      setMessages(payload.messages || []);
      if (payload.conversation?.id) {
        setChatMessagesCache(payload.conversation.id, payload.conversation, payload.messages || []);
        const opened = { ...payload.conversation, unreadCount: 0 };
        setConversations((prev) => prev.map((item) => (item.id === opened.id ? { ...item, ...opened } : item)));
        patchConversationInChatCache(opened.id, opened);
      }
      setChatError("");
    } catch (error) {
      if (selectedIdRef.current === conversationId) setChatError(mapChatError(error, "Impossibile caricare i messaggi."));
    } finally {
      if (selectedIdRef.current === conversationId) setMessagesLoading(false);
    }
  }, []);

  async function loadTaskBoard() {
    if (isTaskBoardCacheFresh() && getTaskBoardCache()?.data) {
      setTasks(getTaskBoardCache()?.data.tasks || []);
      setBoardLeads((getTaskBoardCache()?.data.leads || []) as Lead[]);
      return;
    }
    const payload = await api<TaskBoardPayload>("/api/tasks/board");
    const nextTasks = Array.isArray(payload?.tasks) ? payload.tasks : [];
    const nextLeads = Array.isArray(payload?.leads) ? payload.leads : [];
    setTasks(nextTasks);
    setBoardLeads(nextLeads);
    setTaskBoardCache(nextTasks, nextLeads as never);
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
      setLeadDetail(cached.data as unknown as LeadDetail);
      setLeadLoading(false);
      return;
    }
    setLeadLoading(true);
    try {
      const payload = await api<LeadDetail>(`/api/leads/${targetLeadId}`);
      setLeadDetail(payload);
      setLeadDetailCacheEntry(targetLeadId, payload as never);
    } catch (error) {
      setLeadError(mapChatError(error, "Impossibile caricare la pratica collegata."));
      setLeadDetail(null);
    } finally {
      setLeadLoading(false);
    }
  }

  async function loadTemplates() {
    const payload = await api<TemplateOption[]>("/api/whatsapp/templates");
    const normalized = Array.isArray(payload) && payload.length ? payload : FALLBACK_TEMPLATE_OPTIONS;
    setTemplates(normalized);
    setTemplateKey((prev) => (normalized.some((item) => item.key === prev) ? prev : normalized[0].key));
  }

  // Deep link from the Pratica page (?customerId=/leadId=, optional ?phone= to create an empty
  // conversation): asks the server rather than local state, which may still be the pre-fetch list.
  async function applyConversationDeepLink() {
    const targetCustomerId = String(searchParams.get("customerId") || "").trim();
    const targetLeadId = String(searchParams.get("leadId") || "").trim();
    const targetPhone = String(searchParams.get("phone") || "").trim();
    const targetCustomerName = String(searchParams.get("customerName") || "").trim();
    if (!targetCustomerId && !targetLeadId) return;
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
    const resolved = target;
    setConversations((prev) => (prev.some((item) => item.id === resolved.id) ? prev : [resolved, ...prev]));
    selectConversation(resolved.id);
  }

  useEffect(() => {
    loadConversations({ force: true })
      .then(() => applyConversationDeepLink())
      .catch((error: unknown) => setListError(mapChatError(error)));
    loadTaskBoard().catch((error: unknown) => setLeadError(mapChatError(error)));
    loadTemplates().catch(() => setTemplates(FALLBACK_TEMPLATE_OPTIONS));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Polling pauses while the tab is hidden (no point refreshing nobody is looking at it, and
  // GET messages marks the open chat as read) and catches up as soon as it is visible again.
  useEffect(() => {
    function refresh() {
      if (document.visibilityState === "hidden") return;
      void loadConversations({ force: true });
      if (selectedIdRef.current) void loadMessages(selectedIdRef.current);
    }
    const timer = window.setInterval(refresh, POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [loadConversations, loadMessages]);

  useEffect(() => {
    if (!selectedId) {
      setMessages([]);
      return;
    }
    setMessages((getChatMessagesCache(selectedId)?.data.messages as Message[]) || []);
    setMessagesLoading(!getChatMessagesCache(selectedId)?.data);
    void loadMessages(selectedId);
  }, [selectedId, loadMessages]);

  // Attachments are tied to the conversation they were picked for.
  useEffect(() => {
    setDrafts((current) => {
      current.forEach((draft) => draft.source === "upload" && draft.previewUrl && URL.revokeObjectURL(draft.previewUrl));
      return [];
    });
    setFileError("");
    setChatError("");
  }, [selectedId]);

  useEffect(() => {
    setMessageMode(replyWindow.open ? "text" : "template");
  }, [selectedConversation?.id, replyWindow.open]);

  useEffect(() => {
    void loadLeadContext(selectedConversation?.leadId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedConversation?.leadId]);

  const currentLead = leadDetail?.lead || null;
  const boardLeadById = useMemo(() => new Map(boardLeads.map((lead) => [lead.id, lead])), [boardLeads]);
  const openTasks = useMemo(
    () => tasks.filter((task) => task.status === "open" && task.leadId && task.leadId === selectedConversation?.leadId).sort(sortOperationalTasks),
    [tasks, selectedConversation?.leadId]
  );
  const missingDocumentsCount = useMemo(
    () => (currentLead?.documents?.items || []).filter((item) => item.required && (!item.received || !item.verified)).length,
    [currentLead]
  );
  const pendingPayments = useMemo(() => (currentLead?.payments?.items || []).filter((item) => item.required && item.status !== "verified"), [currentLead]);

  const suggestedTemplates = useMemo(() => {
    const byTag = (tag: string) => templates.filter((item) => item.suggestionTag === tag);
    if (pendingPayments.length && byTag("payments").length) return byTag("payments");
    if (missingDocumentsCount && byTag("documents").length) return byTag("documents");
    if (openTasks.length && byTag("task").length) return byTag("task");
    // Always offer every approved template, suggested ones first.
    return templates;
  }, [missingDocumentsCount, openTasks.length, pendingPayments.length, templates]);
  const templateChoices = useMemo(
    () => [...suggestedTemplates, ...templates.filter((item) => !suggestedTemplates.includes(item))],
    [suggestedTemplates, templates]
  );
  const selectedTemplate = templateChoices.find((item) => item.key === templateKey) || templateChoices[0] || null;

  const practiceDocuments = useMemo<PracticeDocumentOption[]>(
    () =>
      (currentLead?.documents?.items || []).flatMap((item) =>
        (item.attachments || [])
          .filter((attachment): attachment is PracticeDocumentAttachment & { storageKey: string } => Boolean(attachment.storageKey))
          .map((attachment) => ({ documentLabel: item.label || item.key, attachment }))
      ),
    [currentLead]
  );

  const counts = useMemo(() => countConversationFilters(conversations, authUsername), [authUsername, conversations]);
  const rows = useMemo<ConversationRow[]>(
    () =>
      filterConversations(conversations, { filter: inboxFilter, search, username: authUsername }).map((conversation) => ({
        ...conversation,
        operational: getLeadOperationalSummary(conversation.leadId ? boardLeadById.get(String(conversation.leadId)) : null)
      })),
    [authUsername, boardLeadById, conversations, inboxFilter, search]
  );

  const threadItems = useMemo(() => {
    const markers = (leadDetail?.timeline || [])
      .map((item) => getTimelineMarker(item))
      .filter((marker): marker is ThreadMarker => Boolean(marker))
      .slice(-8);
    const pending = selectedId ? pendingByConversation[selectedId] || [] : [];
    return buildThreadItems([...messages, ...pending], markers);
  }, [leadDetail?.timeline, messages, pendingByConversation, selectedId]);

  function selectConversation(conversationId: string) {
    setSelectedId(conversationId);
    if (shouldCloseListOnSelect(getChatLayoutMode(window.innerWidth))) setListOpen(false);
  }

  function setText(value: string) {
    if (!selectedId) return;
    setTextDrafts((current) => ({ ...current, [selectedId]: value }));
  }

  // --- Conversation actions -----------------------------------------------------------------

  async function patchConversation(patch: Record<string, unknown>, successNotice?: string) {
    if (!selectedId || patchingConversation) return false;
    const conversationId = selectedId;
    const previous = conversations;
    setPatchingConversation(true);
    setChatError("");
    const optimistic = { ...patch } as Partial<Conversation> & { markUnread?: boolean };
    if (optimistic.markUnread) {
      delete optimistic.markUnread;
      optimistic.unreadCount = Math.max(1, Number(selectedConversation?.unreadCount || 0));
    }
    setConversations((prev) => prev.map((item) => (item.id === conversationId ? { ...item, ...optimistic } : item)));
    try {
      const updated = await api<Conversation>(`/api/whatsapp/conversations/${conversationId}`, { method: "PATCH", body: JSON.stringify(patch) });
      setConversations((prev) => prev.map((item) => (item.id === updated.id ? { ...item, ...updated } : item)));
      patchConversationInChatCache(updated.id, updated);
      if (successNotice) showNotice(successNotice);
      return true;
    } catch (error) {
      setConversations(previous);
      setChatError(mapChatError(error, "Impossibile aggiornare la conversazione."));
      return false;
    } finally {
      setPatchingConversation(false);
    }
  }

  async function markUnread() {
    const ok = await patchConversation({ markUnread: true }, "Conversazione segnata come non letta");
    // Keeping it open would immediately mark it read again on the next refresh.
    if (ok) {
      setSelectedId(null);
      setListOpen(true);
    }
  }

  async function copyPhone(phone: string) {
    try {
      await navigator.clipboard.writeText(phone);
      showNotice("Numero copiato");
    } catch {
      setChatError("Impossibile copiare il numero: copialo manualmente.");
    }
  }

  function openPractice() {
    if (selectedConversation?.leadId) navigate(buildPracticeUrl(String(selectedConversation.leadId), "overview"));
  }

  // --- Composer: attachments ----------------------------------------------------------------

  const attachmentsDisabledReason = !selectedConversation?.leadId
    ? "Per inviare allegati la conversazione deve essere collegata a una pratica."
    : !online
      ? "Sei offline: gli allegati si possono inviare quando torna la connessione."
      : "";

  function addFiles(files: File[], purpose: "image" | "document" | "quote") {
    if (attachmentsDisabledReason) {
      setFileError(attachmentsDisabledReason);
      return;
    }
    const errors: string[] = [];
    const accepted: DraftAttachment[] = [];
    for (const file of files) {
      if (drafts.length + accepted.length >= MAX_DRAFT_ATTACHMENTS) {
        errors.push(`Puoi allegare al massimo ${MAX_DRAFT_ATTACHMENTS} file per invio.`);
        break;
      }
      const validation = validateChatFile(file, purpose);
      if (validation.ok === false) {
        errors.push(validation.error);
        continue;
      }
      accepted.push({
        id: newLocalId("draft"),
        source: "upload",
        kind: purpose === "quote" ? "quote" : "file",
        file,
        name: file.name,
        mimeType: validation.mimeType,
        size: file.size,
        previewUrl: PREVIEWABLE_IMAGE_TYPES.has(validation.mimeType) ? URL.createObjectURL(file) : undefined
      });
    }
    if (accepted.length) setDrafts((current) => [...current, ...accepted]);
    setFileError(errors.join(" "));
    textAreaRef.current?.focus();
  }

  function pickPracticeDocument(option: PracticeDocumentOption) {
    if (drafts.some((draft) => draft.source === "practice" && draft.storageKey === option.attachment.storageKey)) return;
    setDrafts((current) => [
      ...current,
      {
        id: newLocalId("draft"),
        source: "practice",
        kind: "practice_document",
        name: option.attachment.name,
        mimeType: option.attachment.mimeType || "application/octet-stream",
        size: Number(option.attachment.size || 0),
        storageKey: option.attachment.storageKey
      }
    ]);
    setFileError("");
  }

  function removeDraft(draftId: string) {
    setDrafts((current) =>
      current.filter((draft) => {
        if (draft.id !== draftId) return true;
        if (draft.source === "upload" && draft.previewUrl) URL.revokeObjectURL(draft.previewUrl);
        return false;
      })
    );
  }

  function onDragOver(event: DragEvent<HTMLElement>) {
    if (!selectedConversation || messageMode !== "text" || !Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = attachmentsDisabledReason ? "none" : "copy";
    setDragActive(true);
  }

  function onDragLeave(event: DragEvent<HTMLElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false);
  }

  function onDrop(event: DragEvent<HTMLElement>) {
    if (!dragActive) return;
    event.preventDefault();
    setDragActive(false);
    const files = Array.from(event.dataTransfer.files || []);
    if (files.length) addFiles(files, "document");
  }

  // --- Sending ------------------------------------------------------------------------------

  function addPending(conversationId: string, message: Message) {
    setPendingByConversation((current) => ({ ...current, [conversationId]: [...(current[conversationId] || []), message] }));
  }

  function updatePending(conversationId: string, messageId: string, patch: Partial<Message> | null) {
    setPendingByConversation((current) => {
      const list = current[conversationId] || [];
      const next = patch === null ? list.filter((item) => item.id !== messageId) : list.map((item) => (item.id === messageId ? { ...item, ...patch } : item));
      return { ...current, [conversationId]: next };
    });
  }

  function releasePreview(messageId: string) {
    setLocalPreviews((current) => {
      if (!current[messageId]) return current;
      URL.revokeObjectURL(current[messageId]);
      const next = { ...current };
      delete next[messageId];
      return next;
    });
  }

  async function runJob(job: OutgoingJob) {
    if (job.kind === "text") {
      await api("/api/whatsapp/messages/send", {
        method: "POST",
        body: JSON.stringify({ conversationId: job.conversationId, to: job.to, mode: "text", text: job.text })
      });
      return;
    }
    if (job.kind === "template") {
      await api("/api/whatsapp/messages/send", {
        method: "POST",
        body: JSON.stringify({
          conversationId: job.conversationId,
          to: job.to,
          mode: "template",
          text: job.template.body,
          templateKey: job.template.key,
          templateName: job.template.name
        })
      });
      return;
    }
    const { draft } = job;
    const stored =
      draft.source === "upload"
        ? await uploadChatFile(job.leadId, draft.file, draft.mimeType, draft.kind)
        : { storageKey: draft.storageKey, name: draft.name, mimeType: draft.mimeType, size: draft.size };
    await api("/api/whatsapp/messages/send", {
      method: "POST",
      body: JSON.stringify({
        conversationId: job.conversationId,
        to: job.to,
        mode: "attachment",
        attachment: {
          storageKey: stored.storageKey,
          filename: stored.name,
          mimeType: stored.mimeType,
          size: stored.size,
          kind: draft.kind,
          caption: job.caption
        }
      })
    });
  }

  function buildPendingMessage(job: OutgoingJob, id: string): Message {
    const base = { id, direction: "outbound" as const, createdAt: new Date().toISOString(), localState: "sending" as const, agentName: authUsername };
    if (job.kind === "text") return { ...base, text: job.text, messageType: "text" };
    if (job.kind === "template") return { ...base, text: job.template.body, messageType: "template", templateName: job.template.label };
    return {
      ...base,
      text: job.caption,
      messageType: "attachment",
      attachment: {
        direction: "outbound",
        mediaType: job.draft.mimeType.startsWith("image/") ? "image" : "document",
        filename: job.draft.name,
        mimeType: job.draft.mimeType,
        size: job.draft.size,
        caption: job.caption,
        kind: job.draft.kind
      }
    };
  }

  // Runs one send and reflects it in its pending bubble; returns whether it reached WhatsApp.
  async function executeJob(job: OutgoingJob, messageId: string) {
    try {
      if (!navigator.onLine) throw new Error("Failed to fetch");
      await runJob(job);
      retryJobs.current.delete(messageId);
      // Stays visible as "sent" until the thread reload brings the server copy (see finishSend);
      // removing it here would make the message blink out for a moment.
      updatePending(job.conversationId, messageId, { localState: undefined, status: "sent" });
      if (job.kind === "template") {
        const taskCreated = await createTemplateFollowUp(job.template);
        showNotice(taskCreated ? "Template inviato. Follow-up creato." : "Template inviato");
      }
      return true;
    } catch (error) {
      retryJobs.current.set(messageId, job);
      updatePending(job.conversationId, messageId, {
        localState: "failed",
        localError: mapChatError(error, "Messaggio non inviato. Riprova.")
      });
      return false;
    }
  }

  async function finishSend(conversationId: string, messageIds: string[]) {
    await loadConversations({ force: true });
    if (selectedIdRef.current === conversationId) await loadMessages(conversationId);
    const confirmed = messageIds.filter((id) => !retryJobs.current.has(id));
    setPendingByConversation((current) => ({
      ...current,
      [conversationId]: (current[conversationId] || []).filter((item) => !confirmed.includes(item.id))
    }));
    confirmed.forEach(releasePreview);
  }

  async function sendJobs(jobs: OutgoingJob[]) {
    if (!jobs.length) return;
    const conversationId = jobs[0].conversationId;
    const queued = jobs.map((job) => {
      const id = newLocalId("msg");
      addPending(conversationId, buildPendingMessage(job, id));
      if (job.kind === "attachment" && job.draft.source === "upload" && job.draft.previewUrl) {
        setLocalPreviews((current) => ({ ...current, [id]: job.draft.source === "upload" ? job.draft.previewUrl || "" : "" }));
      }
      return { job, id };
    });
    setSending(true);
    try {
      // Sequential on purpose: WhatsApp shows messages in the order they arrive.
      for (const { job, id } of queued) {
        const ok = await executeJob(job, id);
        if (!ok) {
          // Later items would arrive out of order; keep them as failed so they can be retried.
          queued
            .slice(queued.findIndex((item) => item.id === id) + 1)
            .forEach((rest) => {
              retryJobs.current.set(rest.id, rest.job);
              updatePending(conversationId, rest.id, { localState: "failed", localError: "Non inviato: il messaggio precedente non e partito." });
            });
          break;
        }
      }
    } finally {
      setSending(false);
      await finishSend(
        conversationId,
        queued.map((item) => item.id)
      );
    }
  }

  function submitComposer() {
    if (!selectedConversation || sending) return;
    const conversationId = selectedConversation.id;
    const to = String(selectedConversation.phone || "").trim();
    if (!to) {
      setChatError("Numero del cliente mancante: impossibile inviare.");
      return;
    }
    if (messageMode === "template") {
      if (!selectedTemplate) return;
      void sendJobs([{ kind: "template", conversationId, to, template: selectedTemplate }]);
      return;
    }
    if (!replyWindow.open) {
      setChatError("La finestra di 24 ore e chiusa: invia un template approvato per riaprire la conversazione.");
      setMessageMode("template");
      return;
    }
    const body = text.trim();
    if (!body && !drafts.length) return;
    const jobs: OutgoingJob[] = [];
    const captionFits = body.length <= WHATSAPP_CAPTION_MAX;
    drafts.forEach((draft, index) => {
      jobs.push({
        kind: "attachment",
        conversationId,
        to,
        leadId: String(selectedConversation.leadId || ""),
        draft,
        caption: index === 0 && captionFits ? body : ""
      });
    });
    if (body && (!drafts.length || !captionFits)) jobs.push({ kind: "text", conversationId, to, text: body });
    // The composer clears immediately (like WhatsApp); the pending bubbles carry the progress,
    // and an emptied composer is also what stops a double Enter from sending twice.
    setDrafts([]);
    setText("");
    if (textAreaRef.current) textAreaRef.current.style.height = "";
    setFileError("");
    void sendJobs(jobs);
  }

  function retryMessage(messageId: string) {
    const job = retryJobs.current.get(messageId);
    if (!job || sending) return;
    updatePending(job.conversationId, messageId, { localState: "sending", localError: undefined });
    setSending(true);
    void executeJob(job, messageId).finally(async () => {
      setSending(false);
      await finishSend(job.conversationId, [messageId]);
    });
  }

  function discardMessage(messageId: string) {
    const job = retryJobs.current.get(messageId);
    retryJobs.current.delete(messageId);
    releasePreview(messageId);
    if (job) updatePending(job.conversationId, messageId, null);
  }

  // --- Practice context actions (unchanged behavior) ------------------------------------------

  function patchLeadPayment(paymentId: string, patch: Partial<Payment>) {
    setLeadDetail((current) => {
      if (!current?.lead?.payments?.items) return current;
      return {
        ...current,
        lead: { ...current.lead, payments: { ...current.lead.payments, items: current.lead.payments.items.map((item) => (item.id === paymentId ? { ...item, ...patch } : item)) } }
      };
    });
  }

  function patchLeadDocument(documentId: string, patch: Partial<PracticeDocument>) {
    setLeadDetail((current) => {
      if (!current?.lead?.documents?.items) return current;
      return {
        ...current,
        lead: { ...current.lead, documents: { ...current.lead.documents, items: current.lead.documents.items.map((item) => (item.key === documentId ? { ...item, ...patch } : item)) } }
      };
    });
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

  async function createSmartTask(input: { kind: string; title: string; description: string; priority: number; dueAt: string; meta?: Record<string, unknown> }) {
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
      setLeadError(mapChatError(error, "Task automatico non creato."));
      return null;
    }
  }

  async function createTemplateFollowUp(template: TemplateOption) {
    const tag = template.suggestionTag || template.key;
    const name = currentLead?.fullName || "";
    if (tag === "payments" || template.key === "payment_followup") {
      const payment = pendingPayments[0];
      return createSmartTask({
        kind: "payment_follow_up",
        title: `Follow-up pagamento ${name}`.trim(),
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
        title: `Follow-up documenti ${name}`.trim(),
        description: "Template richiesta documenti inviato dalla chat. Verificare ricezione documenti mancanti.",
        priority: 72,
        dueAt: makeDueAt("tomorrow"),
        meta: { missingKeys, automation: "template_documents_follow_up" }
      });
    }
    if (tag === "task") {
      return createSmartTask({
        kind: "chat_follow_up",
        title: `Follow-up chat ${name}`.trim(),
        description: "Template operativo inviato dalla chat. Ricontrollare la conversazione.",
        priority: 65,
        dueAt: makeDueAt("tomorrow"),
        meta: { automation: "template_task_follow_up" }
      });
    }
    if (tag === "callback") {
      return createSmartTask({
        kind: "callback_reminder",
        title: `Confermare richiamo ${name}`.trim(),
        description: 'Template "Ricontattami" inviato dalla chat. Attendere la risposta del cliente e programmare il richiamo con data/ora.',
        priority: 75,
        dueAt: makeDueAt("tomorrow"),
        meta: { automation: "template_callback_follow_up" }
      });
    }
    if (tag === "not_interested") {
      return createSmartTask({
        kind: "chat_follow_up",
        title: `Confermare esito ${name}`.trim(),
        description: 'Template "Non interessato" inviato dalla chat. Registrare l\'esito definitivo sulla pratica (motivo obbligatorio).',
        priority: 60,
        dueAt: makeDueAt("tomorrow"),
        meta: { automation: "template_not_interested_follow_up" }
      });
    }
    return null;
  }

  async function runContextAction(key: string, action: () => Promise<unknown>, options: { optimistic?: () => void; notice?: string; afterSuccess?: () => Promise<void> } = {}) {
    if (!currentLead || actionBusyKey) return;
    setActionBusyKey(key);
    setLeadError("");
    try {
      await action();
      options.optimistic?.();
      await options.afterSuccess?.();
      if (options.notice) showNotice(options.notice);
      await Promise.all([loadTaskBoard(), loadLeadContext(selectedConversation?.leadId, { force: true })]);
      setCompletedActionKey(key);
      window.setTimeout(() => setCompletedActionKey((current) => (current === key ? "" : current)), 2200);
    } catch (error) {
      setLeadError(mapChatError(error, "Aggiornamento della pratica non riuscito."));
    } finally {
      setActionBusyKey("");
    }
  }

  function markDocumentReceived(documentId: string) {
    return runContextAction(
      `document:${documentId}`,
      () => api(`/api/leads/${currentLead?.id}/documents/${documentId}`, { method: "PATCH", body: JSON.stringify({ received: true, actor: authUsername || "chat" }) }),
      { optimistic: () => patchLeadDocument(documentId, { received: true }), notice: "Documento segnato come ricevuto" }
    );
  }

  function markPaymentReceived(paymentId: string) {
    const payment = (currentLead?.payments?.items || []).find((item) => item.id === paymentId);
    return runContextAction(
      `payment-received:${paymentId}`,
      () => api(`/api/leads/${currentLead?.id}/payments/${paymentId}`, { method: "PATCH", body: JSON.stringify({ status: "received", actor: authUsername || "chat" }) }),
      {
        optimistic: () => patchLeadPayment(paymentId, { status: "received" }),
        afterSuccess: () =>
          createSmartTask({
            kind: "payment_verification",
            title: `Verifica pagamento ${currentLead?.fullName || ""}`.trim(),
            description: `Pagamento segnato come ricevuto dalla chat${payment?.label ? `: ${payment.label}` : ""}. Verificare incasso e chiudere il blocco.`,
            priority: 88,
            dueAt: makeDueAt("1h"),
            meta: { paymentId, automation: "payment_received_verify" }
          }).then(() => undefined),
        notice: "Pagamento segnato come ricevuto. Task di verifica creato"
      }
    );
  }

  function verifyPayment(paymentId: string) {
    return runContextAction(
      `payment-verified:${paymentId}`,
      () => api(`/api/leads/${currentLead?.id}/payments/${paymentId}`, { method: "PATCH", body: JSON.stringify({ status: "verified", actor: authUsername || "chat" }) }),
      { optimistic: () => patchLeadPayment(paymentId, { status: "verified" }), notice: "Pagamento verificato" }
    );
  }

  function completeTask(taskId: string) {
    return runContextAction(`task:${taskId}`, () => api(`/api/tasks/${taskId}`, { method: "PATCH", body: JSON.stringify({ status: "done" }) }), {
      optimistic: () => setTasks((current) => current.map((item) => (item.id === taskId ? { ...item, status: "done" } : item))),
      notice: "Task completato"
    });
  }

  function postponeTaskOneDay(taskId: string) {
    return runContextAction(
      `task-snooze:${taskId}`,
      () => api(`/api/tasks/${taskId}`, { method: "PATCH", body: JSON.stringify({ status: "open", dueAt: makeDueAt("tomorrow") }) }),
      { notice: "Task rimandato a domani" }
    );
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

  function callCustomer() {
    const phone = String(currentLead?.phone || selectedConversation?.phone || "").trim();
    if (phone) window.location.href = `tel:${phone}`;
  }

  // Quick actions from the practice panel prefill the composer with the matching template.
  function prepareTemplate(tag: "documents" | "payments", fallbackKey: string) {
    const template = templates.find((item) => item.suggestionTag === tag) || templates.find((item) => item.key === fallbackKey);
    if (template) setTemplateKey(template.key);
    setMessageMode("template");
  }

  // --- Render -------------------------------------------------------------------------------

  const displayName = currentLead?.fullName || selectedConversation?.customerName || selectedConversation?.phone || "Contatto";
  const displayPhone = currentLead?.phone || selectedConversation?.phone || "-";
  const listVisible = listOpen || !selectedConversation;
  const shellClass = [
    "chat-shell",
    `mode-${layoutMode}`,
    listVisible ? "list-open" : "",
    infoOpen && selectedConversation ? "info-open" : ""
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={shellClass}>
      <aside className="chat-pane chat-pane-list" aria-label="Elenco conversazioni">
        <ConversationList
          rows={rows}
          counts={counts}
          filter={inboxFilter}
          search={search}
          selectedId={selectedId}
          authUsername={authUsername}
          loading={conversationsLoading}
          error={listError}
          onFilterChange={setInboxFilter}
          onSearchChange={setSearch}
          onSelect={selectConversation}
          onRetry={() => void loadConversations({ force: true })}
        />
      </aside>
      {listVisible && selectedConversation ? <button type="button" className="chat-scrim list" aria-label="Chiudi elenco" onClick={() => setListOpen(false)} /> : null}

      <section
        className={`chat-pane chat-pane-thread ${dragActive ? "drag-active" : ""}`}
        aria-label="Conversazione"
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {selectedConversation ? (
          <>
            <ChatHeader
              conversation={selectedConversation}
              displayName={displayName}
              displayPhone={displayPhone}
              replyWindow={replyWindow}
              authUsername={authUsername}
              busy={patchingConversation}
              infoOpen={infoOpen}
              hasLinkedPractice={Boolean(selectedConversation.leadId)}
              onBack={() => setListOpen(true)}
              onToggleInfo={() => setInfoOpen((open) => !open)}
              onAssignToMe={() => void patchConversation({ assignedTo: authUsername }, "Conversazione presa in carico")}
              onRelease={() => void patchConversation({ assignedTo: "" }, "Conversazione rilasciata")}
              onMarkUnread={() => void markUnread()}
              onSetStatus={(status) =>
                void patchConversation(
                  { status },
                  status === "resolved" ? "Conversazione risolta" : status === "waiting_customer" ? "In attesa del cliente" : "Conversazione riaperta"
                )
              }
              onOpenPractice={openPractice}
              onCopyPhone={() => void copyPhone(displayPhone)}
            />
            {!online ? (
              <div className="chat-banner offline" role="status">
                <WifiOff size={15} aria-hidden="true" /> Sei offline: i messaggi non possono essere inviati finche la connessione non torna.
              </div>
            ) : null}
            {chatError ? (
              <div className="chat-banner error" role="alert">
                <span>{chatError}</span>
                <button type="button" className="chat-icon-button small" onClick={() => setChatError("")} aria-label="Chiudi avviso">
                  <X size={14} aria-hidden="true" />
                </button>
              </div>
            ) : null}
            {notice ? (
              <div className="chat-toast" role="status">
                {notice}
              </div>
            ) : null}
            <MessageThread
              conversationId={selectedConversation.id}
              items={threadItems}
              loading={messagesLoading}
              localPreviews={localPreviews}
              onRetry={retryMessage}
              onDiscard={discardMessage}
              onOpenPractice={selectedConversation.leadId ? openPractice : undefined}
            />
            <Composer
              textAreaRef={textAreaRef}
              mode={messageMode}
              replyWindowOpen={replyWindow.open}
              templates={templateChoices}
              selectedTemplate={selectedTemplate}
              text={text}
              drafts={drafts}
              practiceDocuments={practiceDocuments}
              attachmentsDisabledReason={attachmentsDisabledReason}
              fileError={fileError}
              sending={sending}
              onModeChange={(mode) => setMessageMode(mode === "text" && !replyWindow.open ? "template" : mode)}
              onTemplateChange={setTemplateKey}
              onTextChange={setText}
              onAddFiles={addFiles}
              onPickPracticeDocument={pickPracticeDocument}
              onRemoveDraft={removeDraft}
              onDismissFileError={() => setFileError("")}
              onSubmit={submitComposer}
            />
            {dragActive ? (
              <div className="chat-drop-overlay" aria-hidden="true">
                <strong>Rilascia per allegare</strong>
                <span>{attachmentsDisabledReason || "Immagini, PDF, Word, Excel o CSV fino a 8 MB"}</span>
              </div>
            ) : null}
          </>
        ) : (
          <ChatEmptyState hasConversations={conversations.length > 0} />
        )}
      </section>

      {selectedConversation ? (
        <>
          {infoOpen ? <button type="button" className="chat-scrim info" aria-label="Chiudi dettagli" onClick={() => setInfoOpen(false)} /> : null}
          <div className="chat-pane chat-pane-info">
            <ChatDecisionEngine
              lead={currentLead}
              selectedConversation={selectedConversation}
              openTasks={openTasks}
              timeline={leadDetail?.timeline || []}
              leadLoading={leadLoading}
              leadError={leadError}
              authUsername={authUsername}
              actionBusyKey={actionBusyKey}
              completedActionKey={completedActionKey}
              onClose={() => setInfoOpen(false)}
              onCallCustomer={callCustomer}
              onRequestDocuments={() => prepareTemplate("documents", "request_documents")}
              onRequestPaymentReminder={() => prepareTemplate("payments", "payment_followup")}
              onScheduleCallback={(payload) => void scheduleCallback(payload)}
              callbackScheduling={actionBusyKey === "schedule-callback"}
              onMarkDocumentReceived={(documentId) => void markDocumentReceived(documentId)}
              onMarkPaymentReceived={(paymentId) => void markPaymentReceived(paymentId)}
              onVerifyPayment={(paymentId) => void verifyPayment(paymentId)}
              onCompleteTask={(taskId) => void completeTask(taskId)}
              onPostponeTaskOneDay={(taskId) => void postponeTaskOneDay(taskId)}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}
