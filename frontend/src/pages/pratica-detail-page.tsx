import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { CrmTask, getTaskBoardCache, isTaskBoardCacheFresh, setTaskBoardCache } from "../store/crm-store";
import { PracticeFocusSection, focusSectionMap } from "../features/practices/practice-links";
import cruiseHeroImage from "../asset/cruise_chatgpt.png";
import "../styles/pratica-detail-page.css";

type Workflow = {
  statuses: string[];
  flow: Record<string, string[]>;
};

type Lead = {
  id: string;
  fullName: string;
  phone: string;
  email?: string;
  source?: string;
  assignedTo?: string;
  notes?: string;
  documents?: PracticeDocumentsState;
  payments?: PracticePaymentsState;
  status: string;
  nextActionAt?: string;
};

type PracticeDocumentKey =
  | "identity_document"
  | "passenger_data"
  | "signed_contract"
  | "deposit_payment";

type PracticeDocumentItem = {
  key: PracticeDocumentKey;
  label: string;
  required: boolean;
  received: boolean;
  verified: boolean;
  note?: string;
  updatedAt?: string;
  attachments?: PracticeDocumentAttachment[];
};

type PracticeDocumentsState = {
  items: PracticeDocumentItem[];
};

type PracticeDocumentAttachment = {
  id: string;
  name: string;
  mimeType?: string;
  size?: number;
  dataUrl?: string;
  uploadedAt?: string;
};

type PaymentStatus = "pending" | "received" | "verified";

type PracticePaymentItem = {
  id: string;
  label: string;
  amount: number;
  status: PaymentStatus;
  dueAt?: string;
  receivedAt?: string;
  verifiedAt?: string;
  method?: string;
  note?: string;
  required: boolean;
  updatedAt?: string;
};

type PracticePaymentsState = {
  items: PracticePaymentItem[];
};

type TimelineItem = {
  type: string;
  text: string;
  actor: string;
  createdAt: string;
};

type CallLog = {
  id: string;
  leadId: string;
  startedAt: string;
  endedAt?: string;
  outcome: "completed" | "no_answer" | "busy" | "call_back" | "interested" | "not_interested";
  actor: string;
  note?: string;
};

type LeadDetail = {
  lead: Lead;
  timeline: TimelineItem[];
  callLogs?: CallLog[];
};

type Priority = "alta" | "media" | "bassa";

type NoteEntry = {
  id: string;
  text: string;
  createdAt: string;
  actor: string;
};

const DEFAULT_DOCUMENTS: PracticeDocumentItem[] = [
  { key: "identity_document", label: "Documento identita / passaporto", required: true, received: false, verified: false, note: "", attachments: [] },
  { key: "passenger_data", label: "Dati passeggeri", required: true, received: false, verified: false, note: "", attachments: [] },
  { key: "signed_contract", label: "Contratto firmato", required: true, received: false, verified: false, note: "", attachments: [] },
  { key: "deposit_payment", label: "Conferma pagamento acconto", required: true, received: false, verified: false, note: "", attachments: [] }
];

const DEFAULT_PAYMENTS: PracticePaymentItem[] = [
  { id: "payment_deposit", label: "Acconto", amount: 300, status: "pending", required: true, note: "" },
  { id: "payment_balance", label: "Saldo", amount: 900, status: "pending", required: true, note: "" }
];

function normalizeDocuments(input?: PracticeDocumentsState | null): PracticeDocumentsState {
  const byKey = new Map<string, PracticeDocumentItem>();
  (input?.items || []).forEach((item) => {
    byKey.set(String(item.key), item);
  });

  return {
    items: DEFAULT_DOCUMENTS.map((base) => {
      const existing = byKey.get(base.key);
      return {
        ...base,
        ...(existing || {}),
        key: base.key,
        label: existing?.label || base.label,
        required: existing?.required !== undefined ? Boolean(existing.required) : base.required,
        received: Boolean(existing?.received),
        verified: Boolean(existing?.verified),
        note: String(existing?.note || ""),
        attachments: Array.isArray(existing?.attachments)
          ? existing.attachments.map((attachment) => ({
            id: String(attachment.id || `doc_${Date.now()}`),
            name: String(attachment.name || "documento"),
            mimeType: String(attachment.mimeType || ""),
            size: Number(attachment.size || 0),
            dataUrl: String(attachment.dataUrl || ""),
            uploadedAt: attachment.uploadedAt ? String(attachment.uploadedAt) : new Date().toISOString()
          }))
          : []
      };
    })
  };
}

function normalizePayments(input?: PracticePaymentsState | null): PracticePaymentsState {
  const byId = new Map<string, PracticePaymentItem>();
  (input?.items || []).forEach((item) => {
    byId.set(String(item.id), item);
  });

  const now = new Date();

  return {
    items: DEFAULT_PAYMENTS.map((base, index) => {
      const existing = byId.get(base.id);
      const fallbackDueAt = new Date(now);
      fallbackDueAt.setDate(fallbackDueAt.getDate() + index * 30);
      fallbackDueAt.setHours(12, 0, 0, 0);
      return {
        ...base,
        ...(existing || {}),
        id: base.id,
        label: existing?.label || base.label,
        amount: Number(existing?.amount ?? base.amount),
        status: (existing?.status as PaymentStatus) || base.status,
        dueAt: existing?.dueAt ? String(existing.dueAt) : fallbackDueAt.toISOString(),
        receivedAt: existing?.receivedAt ? String(existing.receivedAt) : undefined,
        verifiedAt: existing?.verifiedAt ? String(existing.verifiedAt) : undefined,
        method: String(existing?.method || ""),
        note: String(existing?.note || ""),
        required: existing?.required !== undefined ? Boolean(existing.required) : base.required,
        updatedAt: existing?.updatedAt ? String(existing.updatedAt) : undefined
      };
    })
  };
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat("it-IT", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(Number(value || 0));
}

function getDocumentsBadge(documents: PracticeDocumentsState) {
  const hasMissing = documents.items.some((item) => item.required && (!item.received || !item.verified));
  return hasMissing
    ? { label: "Documenti mancanti", className: "pd-docs-badge-missing" }
    : { label: "Documenti completi", className: "pd-docs-badge-complete" };
}

function getPaymentsBadge(payments: PracticePaymentsState) {
  const pending = payments.items.filter((item) => item.required && item.status !== "verified");
  const totalPending = pending.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  return pending.length
    ? { label: `Pagamenti in sospeso (${pending.length})`, amountText: `Totale ${formatCurrency(totalPending)}`, className: "pd-payments-badge-warning" }
    : {
        label: "Pagamenti completi",
        amountText: `Totale ${formatCurrency(payments.items.reduce((sum, item) => sum + Number(item.amount || 0), 0))}`,
        className: "pd-payments-badge-complete"
      };
}

function getPaymentStatusLabel(status: PaymentStatus) {
  if (status === "received") return "Ricevuto";
  if (status === "verified") return "Verificato";
  return "In sospeso";
}

function getPaymentUrgencyMeta(item: PracticePaymentItem) {
  if (!item.dueAt) {
    return {
      label: "Pagamento da pianificare",
      detail: `Importo ${formatCurrency(item.amount)}`,
      className: "pd-next-empty",
      weight: 60
    };
  }
  const due = new Date(item.dueAt);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate()).getTime();
  const dateText = due.toLocaleString("it-IT");

  if (due.getTime() < now.getTime()) {
    return {
      label: `Pagamento scaduto: ${item.label}`,
      detail: `Scadenza: ${dateText} - ${formatCurrency(item.amount)}`,
      className: "pd-next-overdue",
      weight: 100
    };
  }
  if (dueDay === today) {
    return {
      label: `Pagamento in scadenza oggi: ${item.label}`,
      detail: `Scadenza: ${dateText} - ${formatCurrency(item.amount)}`,
      className: "pd-next-today",
      weight: 85
    };
  }
  return {
    label: `Pagamento da monitorare: ${item.label}`,
    detail: `Scadenza: ${dateText} - ${formatCurrency(item.amount)}`,
    className: "pd-next-planned",
    weight: 65
  };
}

function getMissingDocumentsCount(documents: PracticeDocumentsState) {
  return documents.items.filter((item) => item.required && (!item.received || !item.verified)).length;
}

function getDocumentRowIcon(item: PracticeDocumentItem) {
  if (item.required && (!item.received || !item.verified)) return "Mancante";
  if (item.verified) return "OK";
  return "Doc";
}

function getDocumentRowState(item: PracticeDocumentItem) {
  if (item.required && item.received && item.verified) return "complete";
  if (item.received || item.verified) return "progress";
  return "pending";
}

function readFileAsAttachment(file: File): Promise<PracticeDocumentAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve({
        id: `doc_${Date.now()}`,
        name: file.name,
        mimeType: file.type,
        size: file.size,
        dataUrl: String(reader.result || ""),
        uploadedAt: new Date().toISOString()
      });
    reader.onerror = () => reject(new Error("Errore lettura file."));
    reader.readAsDataURL(file);
  });
}

function getStatusLabel(status: string) {
  const s = String(status || "").toLowerCase();
  if (s.includes("venduta") || s.includes("invio biglietti") || s.includes("saldo effettuato")) return "Convertito";
  if (s.includes("document")) return "Documenti mancanti";
  if (s.includes("saldo") || s.includes("pagament") || s.includes("rata")) return "Pagamento in attesa";
  if (s.includes("preventivo")) return "Preventivo inviato";
  if (s.includes("interess") || s.includes("trattativa")) return "In trattativa";
  if (s.includes("contatt") || s.includes("richiam") || s.includes("non risponde")) return "In contatto";
  if (s.includes("pers")) return "Persa";
  return "Nuovo contatto";
}

function getStatusClass(status: string) {
  const s = String(status || "").toLowerCase();
  if (s.includes("venduta") || s.includes("invio biglietti") || s.includes("saldo effettuato")) return "pd-status-converted";
  if (s.includes("document") || s.includes("saldo") || s.includes("pagament") || s.includes("rata")) return "pd-status-warning";
  if (s.includes("interess") || s.includes("trattativa") || s.includes("preventivo")) return "pd-status-negotiation";
  if (s.includes("contatt") || s.includes("richiam") || s.includes("non risponde")) return "pd-status-contact";
  if (s.includes("pers")) return "pd-status-lost";
  return "pd-status-new";
}

function getPriority(lead: Lead): Priority {
  const status = String(lead.status || "").toLowerCase();
  const notes = String(lead.notes || "").toLowerCase();
  if (!lead.nextActionAt || includesAny(status + notes, ["document", "saldo", "pagament", "scad", "urg"])) return "alta";
  if (includesAny(status + notes, ["contatt", "trattativa", "preventivo", "richiam"])) return "media";
  return "bassa";
}

function getPriorityLabel(priority: Priority) {
  if (priority === "alta") return "Alta priorita";
  if (priority === "media") return "Media priorita";
  return "Bassa priorita";
}

function includesAny(value: string, terms: string[]) {
  const normalized = String(value || "").toLowerCase();
  return terms.some((term) => normalized.includes(term));
}

function getTimelineLabel(type: string) {
  const t = String(type || "").toLowerCase();
  if (t.includes("call")) return "Call";
  if (t.includes("status")) return "Cambio stato";
  if (t.includes("task")) return "Task";
  if (t.includes("note")) return "Nota";
  return type || "Evento";
}

function getTimelineMeta(type: string) {
  const t = String(type || "").toLowerCase();
  if (t.includes("call")) return { icon: "Call", className: "call" };
  if (t.includes("status")) return { icon: "Stato", className: "status" };
  if (t.includes("task")) return { icon: "Task", className: "task" };
  if (t.includes("note")) return { icon: "Nota", className: "note" };
  return { icon: "-", className: "generic" };
}

function getNextActionMeta(value?: string) {
  if (!value) {
    return {
      label: "Nessuna attivita programmata",
      detail: "Imposta un follow-up adesso per non perdere la pratica.",
      className: "pd-next-empty"
    };
  }
  const date = new Date(value);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dateText = date.toLocaleString("it-IT");

  if (date.getTime() < now.getTime()) {
    return {
      label: "Azione scaduta",
      detail: `Scadenza: ${dateText}`,
      className: "pd-next-overdue"
    };
  }
  if (target.getTime() === today.getTime()) {
    return {
      label: "Azione oggi",
      detail: `Scadenza: ${dateText}`,
      className: "pd-next-today"
    };
  }
  return {
    label: "Azione pianificata",
    detail: `Scadenza: ${dateText}`,
    className: "pd-next-planned"
  };
}

function formatDateDisplay(value?: string) {
  if (!value) return "Da pianificare";
  return new Date(value).toLocaleString("it-IT");
}

function formatDateParts(value?: string) {
  if (!value) return { date: "Da definire", time: "" };
  const date = new Date(value);
  return {
    date: date.toLocaleDateString("it-IT"),
    time: date.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })
  };
}

function getTimelineDayLabel(value: string) {
  const date = new Date(value);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diffDays = Math.floor((today - target) / (24 * 60 * 60 * 1000));
  if (diffDays === 0) return "Oggi";
  if (diffDays === 1) return "Ieri";
  return date.toLocaleDateString("it-IT");
}

function getPracticeLabel(lead: Lead) {
  const source = String(lead.source || "").trim();
  if (!source) return "MSC Crociere - Itinerario da definire";
  return `${source} - Itinerario da definire`;
}

function getCallOutcomeLabel(outcome: CallLog["outcome"]) {
  if (outcome === "completed") return "Completata";
  if (outcome === "no_answer") return "Nessuna risposta";
  if (outcome === "busy") return "Occupato";
  if (outcome === "call_back") return "Da richiamare";
  if (outcome === "interested") return "Interessato";
  if (outcome === "not_interested") return "Non interessato";
  return outcome;
}

function getCallOutcomeClass(outcome: CallLog["outcome"]) {
  if (outcome === "completed" || outcome === "interested") return "pd-calllog-positive";
  if (outcome === "call_back" || outcome === "busy") return "pd-calllog-warning";
  if (outcome === "no_answer" || outcome === "not_interested") return "pd-calllog-negative";
  return "pd-calllog-neutral";
}

function compareTasks(a: CrmTask, b: CrmTask) {
  const getLaneWeight = (task: CrmTask) => {
    if (task.status === "done") return 3;
    if (!task.dueAt) return 2;
    const due = new Date(task.dueAt);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate()).getTime();
    if (due.getTime() < now.getTime()) return 0;
    if (dueDay === today) return 1;
    return 2;
  };

  const laneDiff = getLaneWeight(a) - getLaneWeight(b);
  if (laneDiff !== 0) return laneDiff;
  if (b.priority !== a.priority) return b.priority - a.priority;
  const aTs = a.dueAt ? new Date(a.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
  const bTs = b.dueAt ? new Date(b.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
  return aTs - bTs;
}

function getTaskKindLabel(kind: string) {
  const value = String(kind || "").toLowerCase();
  if (value.includes("payment") || value.includes("saldo")) return "Pagamento";
  if (value.includes("document")) return "Documenti";
  if (value.includes("call") || value.includes("richiamo")) return "Richiamo";
  if (value.includes("follow")) return "Follow-up";
  if (value.includes("next_action")) return "Task principale";
  return "Task operativo";
}

function getTaskUrgencyMeta(task: CrmTask) {
  if (task.status === "done") {
    return {
      label: "Task completato",
      detail: "Il task principale risulta chiuso.",
      className: "pd-next-planned"
    };
  }
  if (!task.dueAt) {
    return {
      label: "Task da pianificare",
      detail: "Assegna una scadenza al task principale.",
      className: "pd-next-empty"
    };
  }
  const due = new Date(task.dueAt);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate()).getTime();
  const dateText = due.toLocaleString("it-IT");

  if (due.getTime() < now.getTime()) {
    return {
      label: "Task scaduto",
      detail: `Scadenza task: ${dateText}`,
      className: "pd-next-overdue"
    };
  }
  if (dueDay === today) {
    return {
      label: "Task di oggi",
      detail: `Scadenza task: ${dateText}`,
      className: "pd-next-today"
    };
  }
  return {
    label: "Task pianificato",
    detail: `Scadenza task: ${dateText}`,
    className: "pd-next-planned"
  };
}

export function PraticaDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [detail, setDetail] = useState<LeadDetail | null>(null);
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [assignees, setAssignees] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [noteDraft, setNoteDraft] = useState("");
  const [noteModalOpen, setNoteModalOpen] = useState(false);
  const [noteHistory, setNoteHistory] = useState<NoteEntry[]>([]);
  const [statusDraft, setStatusDraft] = useState("");
  const [assigneeDraft, setAssigneeDraft] = useState("");
  const [taskBoardTasks, setTaskBoardTasks] = useState<CrmTask[]>(() => getTaskBoardCache()?.data.tasks || []);
  const [documentsDraft, setDocumentsDraft] = useState<PracticeDocumentsState>({ items: DEFAULT_DOCUMENTS });
  const [paymentsDraft, setPaymentsDraft] = useState<PracticePaymentsState>({ items: DEFAULT_PAYMENTS });
  const [expandedDocumentNotes, setExpandedDocumentNotes] = useState<Record<string, boolean>>({});
  const [showOnlyMissingDocuments, setShowOnlyMissingDocuments] = useState(false);
  const [highlightSection, setHighlightSection] = useState<PracticeFocusSection | null>(null);

  async function load() {
    if (!id) return;
    setLoading(true);
    setError("");
    try {
      const [payload, workflowData, leadsData] = await Promise.all([
        api<LeadDetail>(`/api/leads/${id}`),
        api<Workflow>("/api/workflow"),
        api<Lead[]>("/api/leads")
      ]);
      setDetail(payload);
      setWorkflow(workflowData);
      setNoteDraft(String(payload.lead.notes || ""));
      setAssigneeDraft(String(payload.lead.assignedTo || ""));
      setDocumentsDraft(normalizeDocuments(payload.lead.documents));
      setPaymentsDraft(normalizePayments(payload.lead.payments));
      setStatusDraft("");
      setAssignees(
        Array.from(new Set((Array.isArray(leadsData) ? leadsData : []).map((lead) => String(lead.assignedTo || "").trim()).filter(Boolean))).sort(
          (a, b) => a.localeCompare(b, "it")
        )
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Errore caricamento pratica.");
    } finally {
      setLoading(false);
    }
  }

  async function createTask() {
    if (!detail?.lead.id) return;
    setBusy(true);
    setError("");
    try {
      await api("/api/tasks", {
        method: "POST",
        body: JSON.stringify({
          leadId: detail.lead.id,
          kind: "follow_up",
          title: `Follow-up ${detail.lead.fullName}`,
          description: `Task creato dal dettaglio pratica per ${detail.lead.fullName}.`,
          source: "pratica_detail",
          priority: 80,
          dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        })
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Errore creazione task.");
    } finally {
      setBusy(false);
    }
  }

  async function registerCall() {
    if (!detail?.lead.id) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/leads/${detail.lead.id}/calls`, {
        method: "POST",
        body: JSON.stringify({ disposition: "completed", actor: "operatore pratica" })
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Errore registrazione chiamata.");
    } finally {
      setBusy(false);
    }
  }

  async function updateStatus() {
    if (!detail?.lead.id || !statusDraft) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/leads/${detail.lead.id}/status`, {
        method: "POST",
        body: JSON.stringify({ toStatus: statusDraft, actor: "operatore pratica" })
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Errore cambio stato.");
    } finally {
      setBusy(false);
    }
  }

  async function updateAssignee() {
    if (!detail?.lead.id) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/leads/${detail.lead.id}`, {
        method: "PATCH",
        body: JSON.stringify({ assignedTo: assigneeDraft })
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Errore assegnazione.");
    } finally {
      setBusy(false);
    }
  }

  async function saveNote() {
    if (!detail?.lead.id) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/leads/${detail.lead.id}`, {
        method: "PATCH",
        body: JSON.stringify({ notes: noteDraft })
      });
      await load();
      setNoteModalOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Errore salvataggio nota.");
    } finally {
      setBusy(false);
    }
  }

  async function saveDocuments(nextDocuments: PracticeDocumentsState) {
    if (!detail?.lead.id) return;
    setBusy(true);
    setError("");
    try {
      const updatedLead = await api<Lead>(`/api/leads/${detail.lead.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          documents: nextDocuments,
          actor: "operatore pratica"
        })
      });
      const normalized = normalizeDocuments(updatedLead.documents);
      setDocumentsDraft(normalized);
      setDetail((prev) => (prev ? { ...prev, lead: { ...prev.lead, documents: normalized } } : prev));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Errore salvataggio documenti.");
    } finally {
      setBusy(false);
    }
  }

  async function savePayments(nextPayments: PracticePaymentsState) {
    if (!detail?.lead.id) return;
    setBusy(true);
    setError("");
    try {
      const updatedLead = await api<Lead>(`/api/leads/${detail.lead.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          payments: nextPayments,
          actor: "operatore pratica"
        })
      });
      const normalized = normalizePayments(updatedLead.payments);
      setPaymentsDraft(normalized);
      setDetail((prev) => (prev ? { ...prev, lead: { ...prev.lead, payments: normalized } } : prev));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Errore salvataggio pagamenti.");
    } finally {
      setBusy(false);
    }
  }

  function updateDocumentItem(key: PracticeDocumentKey, updates: Partial<PracticeDocumentItem>) {
    const nextDocuments = {
      items: documentsDraft.items.map((item) =>
        item.key === key
          ? {
            ...item,
            ...updates,
            updatedAt: new Date().toISOString()
          }
          : item
      )
    };
    setDocumentsDraft(nextDocuments);
    void saveDocuments(nextDocuments);
  }

  async function handleDocumentUpload(key: PracticeDocumentKey, file?: File | null) {
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) {
      setError("Il file supera 4MB. Riduci la dimensione prima di caricarlo.");
      return;
    }
    try {
      const attachment = await readFileAsAttachment(file);
      const nextDocuments = {
        items: documentsDraft.items.map((item) =>
          item.key === key
            ? {
              ...item,
              received: true,
              attachments: [...(item.attachments || []), attachment],
              updatedAt: new Date().toISOString()
            }
            : item
        )
      };
      setDocumentsDraft(nextDocuments);
      await saveDocuments(nextDocuments);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Errore caricamento documento.");
    }
  }

  function removeDocumentAttachment(key: PracticeDocumentKey, attachmentId: string) {
    const nextDocuments = {
      items: documentsDraft.items.map((item) =>
        item.key === key
          ? {
            ...item,
            attachments: (item.attachments || []).filter((attachment) => attachment.id !== attachmentId),
            updatedAt: new Date().toISOString()
          }
          : item
      )
    };
    setDocumentsDraft(nextDocuments);
    void saveDocuments(nextDocuments);
  }

  function updatePaymentItem(id: string, updates: Partial<PracticePaymentItem>) {
    const nextPayments = {
      items: paymentsDraft.items.map((item) =>
        item.id === id
          ? {
              ...item,
              ...updates,
              updatedAt: new Date().toISOString()
            }
          : item
      )
    };
    setPaymentsDraft(nextPayments);
    void savePayments(nextPayments);
  }

  function updatePaymentStatus(item: PracticePaymentItem, status: PaymentStatus) {
    const now = new Date().toISOString();
    if (status === "pending") {
      updatePaymentItem(item.id, { status, receivedAt: undefined, verifiedAt: undefined });
      return;
    }
    if (status === "received") {
      updatePaymentItem(item.id, { status, receivedAt: item.receivedAt || now, verifiedAt: undefined });
      return;
    }
    updatePaymentItem(item.id, {
      status: "verified",
      receivedAt: item.receivedAt || now,
      verifiedAt: item.verifiedAt || now
    });
  }

  function postponePayment(item: PracticePaymentItem, days: number) {
    const nextDue = item.dueAt ? new Date(item.dueAt) : new Date();
    nextDue.setDate(nextDue.getDate() + days);
    if (!item.dueAt) nextDue.setHours(12, 0, 0, 0);
    updatePaymentItem(item.id, { dueAt: nextDue.toISOString() });
  }

  useEffect(() => {
    load().catch(() => null);
  }, [id]);

  useEffect(() => {
    let canceled = false;

    const hydrateTasks = async () => {
      const cached = getTaskBoardCache();
      if (cached?.data?.tasks?.length && !canceled) {
        setTaskBoardTasks(cached.data.tasks);
      }

      if (cached?.data?.tasks?.length && isTaskBoardCacheFresh()) return;

      try {
        const payload = await api<{ tasks: CrmTask[]; leads: Lead[] }>("/api/tasks/board");
        if (canceled) return;
        setTaskBoardCache(payload.tasks, payload.leads);
        setTaskBoardTasks(payload.tasks);
      } catch { }
    };

    hydrateTasks().catch(() => null);

    return () => {
      canceled = true;
    };
  }, []);

  const searchParams = useMemo(() => new URLSearchParams(location.search), [location.search]);

  const focus = useMemo(() => {
    const value = searchParams.get("focus");
    if (!value) return null;
    return Object.prototype.hasOwnProperty.call(focusSectionMap, value) ? (value as PracticeFocusSection) : null;
  }, [searchParams]);

  const paymentKey = useMemo(() => searchParams.get("payment"), [searchParams]);
  const documentKey = useMemo(() => searchParams.get("document"), [searchParams]);

  useEffect(() => {
    if (!detail) return;
    if (!focus) return;
    const targetId = focusSectionMap[focus];
    if (!targetId) return;
    if (focus === "documents") {
      setShowOnlyMissingDocuments(true);
    }
    const target = document.getElementById(targetId);
    if (!target) return;
    window.requestAnimationFrame(() => {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, [detail, focus]);

  useEffect(() => {
    if (!detail || !focus) return;
    if (!focusSectionMap[focus]) return;
    setHighlightSection(focus);
    const timeout = window.setTimeout(() => setHighlightSection(null), 1800);
    return () => window.clearTimeout(timeout);
  }, [detail, focus]);

  useEffect(() => {
    if (!detail) return;
    if (focus !== "documents") return;
    if (!documentKey) return;
    const exists = documentsDraft.items.some((item) => item.key === documentKey);
    if (!exists) return;
    setExpandedDocumentNotes((prev) => ({ ...prev, [documentKey]: true }));
  }, [detail, focus, documentKey, documentsDraft.items]);


  const timeline = useMemo(() => (detail?.timeline || []).slice().reverse(), [detail]);
  const priority = detail ? getPriority(detail.lead) : "media";
  const statusClass = detail ? getStatusClass(detail.lead.status) : "pd-status-new";
  const nextStatuses = detail ? workflow?.flow[detail.lead.status] || [] : [];
  const compactTimeline = useMemo(() => timeline.slice(0, 8), [timeline]);
  const documentsState = useMemo(() => normalizeDocuments(detail?.lead.documents || documentsDraft), [detail?.lead.documents, documentsDraft]);
  const documentsBadge = useMemo(() => getDocumentsBadge(documentsState), [documentsState]);
  const missingDocumentsCount = useMemo(() => getMissingDocumentsCount(documentsState), [documentsState]);
  const paymentsState = useMemo(() => normalizePayments(detail?.lead.payments || paymentsDraft), [detail?.lead.payments, paymentsDraft]);
  const pendingPayments = useMemo(
    () => paymentsState.items.filter((item) => item.required && item.status !== "verified"),
    [paymentsState]
  );
  const paymentsBadge = useMemo(() => getPaymentsBadge(paymentsState), [paymentsState]);
  const totalRequiredPayments = useMemo(
    () => paymentsState.items.filter((item) => item.required).reduce((sum, item) => sum + Number(item.amount || 0), 0),
    [paymentsState]
  );
  const totalPaidPayments = useMemo(
    () =>
      paymentsState.items
        .filter((item) => item.required && item.status !== "pending")
        .reduce((sum, item) => sum + Number(item.amount || 0), 0),
    [paymentsState]
  );
  const totalRemainingPayments = Math.max(0, totalRequiredPayments - totalPaidPayments);
  const paymentProgress = totalRequiredPayments > 0 ? Math.min(100, Math.round((totalPaidPayments / totalRequiredPayments) * 100)) : 0;
  const visibleDocuments = useMemo(
    () =>
      showOnlyMissingDocuments
        ? documentsState.items.filter((item) => item.required && (!item.received || !item.verified))
        : documentsState.items,
    [documentsState, showOnlyMissingDocuments]
  );
  return (
    <div className="pd-page panel">


      {loading ? <p className="muted">Caricamento dettaglio...</p> : null}
      {error ? <p className="pd-error">{error}</p> : null}

      {detail ? (
        <>
          <section
            id="overview-section"
            className={`pd-top-hero ${highlightSection === "overview" ? "pd-focus-highlight" : ""}`}
          >
            <div className="pd-hero-visual" aria-hidden="true">
              <img src={cruiseHeroImage} alt="" />
            </div>
            <div className="pd-hero-main">
              <Link className="pd-back-btn pd-back-btn-inline" to="/pratiche">
                Torna a pratiche
              </Link>
              <h4>{detail.lead.fullName}</h4>
              <p className="pd-sub">{detail.lead.phone}</p>
              <p className="pd-sub pd-sub-secondary">{detail.lead.email || "-"}</p>
              <div className="pd-badges">
                <span className={`pd-status ${statusClass}`}>{getStatusLabel(detail.lead.status)}</span>
                <span className={`pd-priority pd-priority-${priority}`}>{getPriorityLabel(priority)}</span>
              </div>
              <div className="pd-hero-actions">
                <button type="button" disabled={busy} onClick={registerCall}>
                  Chiama
                </button>
                <button type="button" className="secondary" onClick={() => navigate("/chat")}>
                  Apri chat
                </button>
                <button type="button" className="secondary" disabled={busy} onClick={createTask}>
                  Crea task
                </button>
                <button type="button" className="secondary" onClick={() => setNoteModalOpen(true)}>
                  Inserisci nota
                </button>
                <details className="pd-hero-more">
                  <summary>Altre azioni</summary>
                  <div className="pd-hero-more-menu">
                    <div className="pd-inline-control pd-inline-control-block">
                      <select value={statusDraft} onChange={(event) => setStatusDraft(event.target.value)}>
                        <option value="">Cambia stato...</option>
                        {nextStatuses.map((status) => (
                          <option key={status} value={status}>
                            {status}
                          </option>
                        ))}
                      </select>
                      <button type="button" className="secondary" disabled={busy || !statusDraft} onClick={updateStatus}>
                        Applica
                      </button>
                    </div>
                    <div className="pd-inline-control pd-inline-control-block">
                      <input
                        list="pd-assignees"
                        value={assigneeDraft}
                        onChange={(event) => setAssigneeDraft(event.target.value)}
                        placeholder="Assegna a..."
                      />
                      <datalist id="pd-assignees">
                        {assignees.map((assignee) => (
                          <option key={assignee} value={assignee} />
                        ))}
                      </datalist>
                      <button type="button" className="secondary" disabled={busy} onClick={updateAssignee}>
                        Assegna
                      </button>
                    </div>
                  </div>
                </details>
              </div>
            </div>
          </section>

          <div className="pd-grid">
            <section
              id="documents-section"
              className={`pd-card pd-card-documents ${highlightSection === "documents" ? "pd-focus-highlight" : ""}`}
            >
              <div className="pd-docs-head">
                <div>
                  <h5>Documenti</h5>
                  <p className="pd-docs-subtitle">
                    {missingDocumentsCount > 0
                      ? `${missingDocumentsCount} mancanti`
                      : "Documenti completi"}
                  </p>
                </div>
                {missingDocumentsCount > 0 ? (
                  <button
                    type="button"
                    className={`pd-docs-badge pd-docs-badge-button ${documentsBadge.className} ${showOnlyMissingDocuments ? "is-active" : ""}`}
                    onClick={() => setShowOnlyMissingDocuments((prev) => !prev)}
                  >
                    {showOnlyMissingDocuments ? "Mostra tutti" : "Solo mancanti"}
                  </button>
                ) : null}
              </div>
              <div className={`pd-docs-alert ${documentsBadge.className} ${showOnlyMissingDocuments ? "is-active" : ""}`}>
                <strong>
                  {missingDocumentsCount > 0 ? `Documenti mancanti (${missingDocumentsCount})` : "Documenti completi"}
                </strong>
                <span>
                  {missingDocumentsCount > 0
                    ? showOnlyMissingDocuments
                      ? "Stai vedendo solo i documenti ancora da completare."
                      : "Completa ricezione e verifica dei documenti richiesti per sbloccare la pratica."
                    : "Tutti i documenti richiesti risultano ricevuti e verificati."}
                </span>
              </div>
              <div className="pd-docs-list">
                {visibleDocuments.map((item) => (
                  <article
                    key={item.key}
                    className={`pd-doc-row pd-doc-row-${getDocumentRowState(item)} ${documentKey === item.key ? "pd-focus-target-row" : ""}`}
                  >
                    <div className="pd-doc-row-main">
                      <strong>
                        <span className="pd-doc-row-icon" aria-hidden="true">
                          {getDocumentRowIcon(item)}
                        </span>{" "}
                        {item.label}
                      </strong>
                      <div className="pd-doc-flags">
                        <label>
                          <input
                            type="checkbox"
                            checked={item.required}
                            disabled={busy}
                            onChange={(event) => updateDocumentItem(item.key, { required: event.target.checked })}
                          />
                          Richiesto
                        </label>
                        <label>
                          <input
                            type="checkbox"
                            checked={item.received}
                            disabled={busy}
                            onChange={(event) =>
                              updateDocumentItem(item.key, {
                                received: event.target.checked,
                                verified: event.target.checked ? item.verified : false
                              })
                            }
                          />
                          Ricevuto
                        </label>
                        <label>
                          <input
                            type="checkbox"
                            checked={item.verified}
                            disabled={busy || !item.received}
                            onChange={(event) =>
                              updateDocumentItem(item.key, {
                                verified: event.target.checked,
                                received: event.target.checked ? true : item.received
                              })
                            }
                          />
                          Verificato
                        </label>
                      </div>
                    </div>
                    <div className="pd-doc-row-actions">
                      <label className="pd-doc-upload" title="Carica documento">
                        <span className="pd-doc-upload-shine" aria-hidden="true" />
                        <span className="pd-doc-upload-icons" aria-hidden="true">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="m5 12 7-7 7 7" />
                            <path d="M12 19V5" />
                          </svg>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="m5 12 7-7 7 7" />
                            <path d="M12 19V5" />
                          </svg>
                        </span>
                        <input
                          type="file"
                          accept=".pdf,.jpg,.jpeg,.png,.webp,.doc,.docx"
                          onChange={(event) => {
                            void handleDocumentUpload(item.key, event.currentTarget.files?.[0] || null);
                            event.currentTarget.value = "";
                          }}
                        />
                      </label>
                      <button
                        type="button"
                        className="pd-doc-note-toggle"
                        onClick={() =>
                          setExpandedDocumentNotes((prev) => ({
                            ...prev,
                            [item.key]: !prev[item.key]
                          }))
                        }
                      >
                        {item.note?.trim() || expandedDocumentNotes[item.key] ? "Modifica" : "+ Nota"}
                      </button>
                    </div>
                    {item.attachments?.length ? (
                      <div className="pd-doc-attachments">
                        {item.attachments.map((attachment) => (
                          <div key={attachment.id} className="pd-doc-attachment">
                            {attachment.dataUrl ? (
                              <a href={attachment.dataUrl} download={attachment.name} target="_blank" rel="noreferrer">
                                Allegato: {attachment.name}
                              </a>
                            ) : (
                              <span>Allegato: {attachment.name}</span>
                            )}
                            <button type="button" onClick={() => removeDocumentAttachment(item.key, attachment.id)}>
                              x
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    {item.note?.trim() && !expandedDocumentNotes[item.key] ? <p className="pd-doc-note-preview">{item.note}</p> : null}
                    {expandedDocumentNotes[item.key] ? (
                      <input
                        className="pd-doc-note-inline"
                        type="text"
                        value={item.note || ""}
                        onChange={(event) =>
                          setDocumentsDraft((prev) => ({
                            items: prev.items.map((doc) => (doc.key === item.key ? { ...doc, note: event.target.value } : doc))
                          }))
                        }
                        onBlur={(event) => updateDocumentItem(item.key, { note: event.target.value })}
                        placeholder="Aggiungi una nota rapida sul documento"
                      />
                    ) : null}
                  </article>
                ))}
                {!visibleDocuments.length ? <p className="muted">Nessun documento mancante.</p> : null}
              </div>
            </section>

            <section
              id="payments-section"
              className={`pd-card pd-card-payments ${highlightSection === "payments" ? "pd-focus-highlight" : ""}`}
            >
              <div className="pd-payments-head">
                <div>
                  <h5>Pagamenti pratica</h5>
                  <p className="pd-payments-subtitle">
                    {pendingPayments.length
                      ? `${pendingPayments.length} rate mancanti - ${paymentsBadge.amountText}`
                      : `${paymentsBadge.amountText}`}
                  </p>
                </div>
              </div>
              <div className="pd-payments-summary-card">
                <div className="pd-payments-summary">
                  <article>
                    <span>Totale pratica</span>
                    <strong>{formatCurrency(totalRequiredPayments)}</strong>
                  </article>
                  <article>
                    <span>Pagato</span>
                    <strong>{formatCurrency(totalPaidPayments)}</strong>
                    <small>{paymentProgress}%</small>
                  </article>
                  <article>
                    <span>Residuo</span>
                    <strong className={totalRemainingPayments > 0 ? "is-warning" : "is-ok"}>{formatCurrency(totalRemainingPayments)}</strong>
                  </article>
                </div>
                <div className="pd-payments-progress">
                  <div className="pd-payments-progress-bar" aria-hidden="true">
                    <span style={{ width: `${paymentProgress}%` }} />
                  </div>
                  <div className="pd-payments-progress-foot">
                    <span>{paymentProgress}%</span>
                  </div>
                </div>
              </div>
              {pendingPayments.length ? (
                <div className={`pd-payments-alert ${paymentsBadge.className}`}>
                  <strong>Pagamenti in sospeso ({pendingPayments.length})</strong>
                  <span>Richiedi il pagamento o verifica quelli ricevuti per sbloccare la pratica.</span>
                </div>
              ) : (
                <div className={`pd-payments-alert ${paymentsBadge.className}`}>
                  <strong>Pagamenti completi</strong>
                  <span>Tutti i pagamenti richiesti risultano verificati.</span>
                </div>
              )}
              <div className="pd-payments-table-head" aria-hidden="true">
                <span>Voce</span>
                <span>Importo</span>
                <span>Scadenza</span>
                <span>Stato</span>
                <span>Azioni</span>
              </div>
              <div className="pd-payments-list">
                {paymentsState.items.map((item) => {
                  const due = formatDateParts(item.dueAt);
                  return (
                    <article key={item.id} className={`pd-payment-row pd-payment-${item.status} ${paymentKey === item.id ? "pd-focus-target-row" : ""}`}>
                      <div className="pd-payment-main">
                        <strong>{item.label}</strong>
                      </div>
                      <span className="pd-payment-amount">{formatCurrency(item.amount)}</span>
                      <div className="pd-payment-meta">
                        <small>
                          <span>{due.date}</span>
                          {due.time ? <span>{due.time}</span> : null}
                        </small>
                      </div>
                      <span className={`pd-payment-status pd-payment-status-${item.status}`}>{getPaymentStatusLabel(item.status)}</span>
                      <div className="pd-payment-actions">
                        <details className="pd-payment-menu">
                          <summary className="pd-payment-menu-trigger">Azioni</summary>
                          <div className="pd-payment-menu-list">
                            {item.status === "pending" ? (
                              <button type="button" disabled={busy} onClick={() => updatePaymentStatus(item, "received")}>
                                Segna ricevuto
                              </button>
                            ) : null}
                            {item.status === "pending" ? (
                              <button type="button" disabled={busy} onClick={() => postponePayment(item, 1)}>
                                Posticipa +1 giorno
                              </button>
                            ) : null}
                            {item.status === "pending" ? (
                              <button type="button" disabled={busy} onClick={registerCall}>
                                Chiama cliente
                              </button>
                            ) : null}
                            {item.status !== "verified" ? (
                              <button type="button" disabled={busy} onClick={() => updatePaymentStatus(item, "verified")}>
                                Verifica
                              </button>
                            ) : null}
                            {item.status !== "pending" ? (
                              <button type="button" disabled={busy} onClick={() => updatePaymentStatus(item, "pending")}>
                                Riapri pagamento
                              </button>
                            ) : null}
                          </div>
                        </details>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>

            <section
              id="timeline-section"
              className={`pd-card pd-card-timeline ${highlightSection === "timeline" ? "pd-focus-highlight" : ""}`}
            >
              <div className="pd-timeline-head">
                <div>
                  <h5>Timeline attivita</h5>
                  <p className="pd-timeline-subtitle">
                    {compactTimeline.length ? `${compactTimeline.length} eventi recenti` : "Nessuna attivita recente"}
                  </p>
                </div>
              </div>
              {compactTimeline.length ? (
                <div className="pd-timeline-list">
                  {compactTimeline.map((item, idx) => {
                    const meta = getTimelineMeta(item.type);
                    return (
                      <article key={`${item.createdAt}-${idx}`} className={`pd-timeline-entry pd-timeline-${meta.className}`}>
                        <span className="pd-timeline-dot" aria-hidden="true" />
                        <div className="pd-timeline-content">
                          <div className="pd-timeline-topline">
                            <strong>{getTimelineLabel(item.type)}</strong>
                            <span>{formatDateDisplay(item.createdAt)}</span>
                          </div>
                          <p>{item.text}</p>
                          <small>{item.actor || "Sistema"}</small>
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <p className="muted">Nessuna attivita disponibile.</p>
              )}
            </section>
          </div>

          {noteModalOpen ? (
            <div className="pd-note-modal-backdrop" role="presentation" onClick={() => setNoteModalOpen(false)}>
              <div
                className="pd-note-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby="pd-note-modal-title"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="pd-note-modal-head">
                  <div>
                    <h5 id="pd-note-modal-title">Inserisci nota</h5>
                    <p>Aggiungi o aggiorna il commento operativo della pratica.</p>
                  </div>
                  <button type="button" className="secondary" onClick={() => setNoteModalOpen(false)}>
                    Chiudi
                  </button>
                </div>
                <textarea
                  className="pd-notes-input"
                  value={noteDraft}
                  onChange={(event) => setNoteDraft(event.target.value)}
                  rows={6}
                  placeholder="Scrivi qui la nota o il commento..."
                />
                <div className="pd-note-modal-actions">
                  <button type="button" className="secondary" onClick={() => setNoteModalOpen(false)}>
                    Annulla
                  </button>
                  <button type="button" disabled={busy} onClick={saveNote}>
                    Salva nota
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}










