import { Lead, NextActionMeta, Priority } from "./pratiche.types";

export const urgencyLabels: Record<Priority, string> = {
  alta: "Alta",
  media: "Media",
  bassa: "Bassa"
};

export function normalizeLead(input: Lead): Lead {
  return {
    ...input,
    id: String(input?.id || ""),
    fullName: String(input?.fullName || "Cliente senza nome"),
    phone: String(input?.phone || "-"),
    email: String(input?.email || ""),
    source: String(input?.source || ""),
    assignedTo: String(input?.assignedTo || ""),
    notes: String(input?.notes || ""),
    cruiseName: String(input?.cruiseName || ""),
    destination: String(input?.destination || ""),
    company: String(input?.company || ""),
    documentsMissingCount: Number(input?.documentsMissingCount || 0),
    status: String(input?.status || "Da contattare"),
    assignedAt: input?.assignedAt ? String(input.assignedAt) : null,
    sourceLeadId: input?.sourceLeadId ? String(input.sourceLeadId) : null,
    sourcePlatform: input?.sourcePlatform ? String(input.sourcePlatform) : null,
    sourceCampaignId: input?.sourceCampaignId ? String(input.sourceCampaignId) : null,
    sourceFormId: input?.sourceFormId ? String(input.sourceFormId) : null,
    firstContactAt: input?.firstContactAt ? String(input.firstContactAt) : null,
    lastContactAt: input?.lastContactAt ? String(input.lastContactAt) : null,
    slaDueAt: input?.slaDueAt ? String(input.slaDueAt) : null,
    closingOutcome: input?.closingOutcome || "open",
    lossReason: input?.lossReason ? String(input.lossReason) : null,
    lossDetail: input?.lossDetail ? String(input.lossDetail) : null,
    nextActionAt: input?.nextActionAt ? String(input.nextActionAt) : undefined,
    latestCallOutcome: input?.latestCallOutcome || null,
    latestCallAt: input?.latestCallAt ? String(input.latestCallAt) : null,
    createdAt: input?.createdAt ? String(input.createdAt) : undefined,
    updatedAt: input?.updatedAt ? String(input.updatedAt) : undefined
  };
}

export function includesAny(value: string, terms: string[]) {
  const normalized = String(value || "").toLowerCase();
  return terms.some((term) => normalized.includes(term));
}

export function getPriority(lead: Lead): Priority {
  const status = String(lead.status || "").toLowerCase();
  const notes = String(lead.notes || "").toLowerCase();
  if (status.includes("chiusa 100")) return "bassa";
  if (status.includes("pronta per chiusura")) return "media";
  if (!lead.nextActionAt || includesAny(status + notes, ["document", "saldo", "pagament", "scad", "urg"])) return "alta";
  if (includesAny(status + notes, ["contatt", "trattativa", "preventivo", "richiam"])) return "media";
  return "bassa";
}

export function getStatusLabel(status: string) {
  const normalized = String(status || "").toLowerCase();
  if (normalized.includes("chiusa 100")) return "Chiusa 100%";
  if (normalized.includes("pronta per chiusura")) return "Pronta chiusura";
  if (normalized.includes("venduta") || normalized.includes("invio biglietti") || normalized.includes("saldo effettuato")) return "Convertito";
  if (normalized.includes("document")) return "Documenti mancanti";
  if (normalized.includes("saldo") || normalized.includes("pagament") || normalized.includes("rata")) return "Pagamento in attesa";
  if (normalized.includes("preventivo")) return "Preventivo inviato";
  if (normalized.includes("interess") || normalized.includes("trattativa")) return "In trattativa";
  if (normalized.includes("contatt") || normalized.includes("richiam") || normalized.includes("non risponde")) return "In contatto";
  if (normalized.includes("pers")) return "Persa";
  return "Nuovo contatto";
}

export function getStatusClass(status: string) {
  const normalized = String(status || "").toLowerCase();
  if (normalized.includes("chiusa 100")) return "pr-status-closed";
  if (normalized.includes("pronta per chiusura")) return "pr-status-ready";
  if (normalized.includes("venduta") || normalized.includes("invio biglietti") || normalized.includes("saldo effettuato")) return "pr-status-converted";
  if (normalized.includes("document") || normalized.includes("saldo") || normalized.includes("pagament") || normalized.includes("rata")) return "pr-status-warning";
  if (normalized.includes("interess") || normalized.includes("trattativa") || normalized.includes("preventivo")) return "pr-status-negotiation";
  if (normalized.includes("contatt") || normalized.includes("richiam") || normalized.includes("non risponde")) return "pr-status-contact";
  if (normalized.includes("pers")) return "pr-status-lost";
  return "pr-status-new";
}

export function getTravelLabel(lead: Lead) {
  const parts = [String(lead.destination || "").trim(), String(lead.company || "").trim()].filter(Boolean);
  const cruiseName = String(lead.cruiseName || "").trim();
  const semanticLabel = cruiseName || parts.join(" - ");
  const fallbackNote = String(lead.notes || "").trim();
  const label = semanticLabel || fallbackNote || "Crociera da definire";
  return label.length > 42 ? `${label.slice(0, 42)}...` : label;
}

export function formatDate(value?: string) {
  if (!value) return "Nessuna attività programmata";
  return new Date(value).toLocaleString("it-IT");
}

export function getNextActionMeta(value?: string): NextActionMeta {
  if (!value) {
    return {
      label: "⚠ Da pianificare",
      dateText: "Nessuna attività programmata. Imposta un follow-up.",
      className: "pr-next-empty"
    };
  }

  const date = new Date(value);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dateText = date.toLocaleString("it-IT");

  if (date.getTime() < now.getTime()) {
    return {
      label: "🔴 Scaduto",
      dateText,
      className: "pr-next-overdue"
    };
  }

  if (target.getTime() === today.getTime()) {
    return {
      label: "🟡 Oggi",
      dateText,
      className: "pr-next-today"
    };
  }

  return {
    label: "🟢 Pianificato",
    dateText,
    className: "pr-next-planned"
  };
}

export function getSmartBucket(lead: Lead): "overdue" | "today" | "planned" | "new" {
  if (!lead.nextActionAt) return "new";
  const date = new Date(lead.nextActionAt);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  if (date.getTime() < now.getTime()) return "overdue";
  if (target === today) return "today";
  return "planned";
}

export function getPriorityScore(lead: Lead) {
  const now = new Date();
  const next = lead.nextActionAt ? new Date(lead.nextActionAt) : null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const nextDay = next ? new Date(next.getFullYear(), next.getMonth(), next.getDate()).getTime() : null;
  const isOverdue = Boolean(next && next.getTime() < now.getTime());
  const isToday = Boolean(nextDay !== null && nextDay === today);
  const isUrgent = String(lead.notes || "").toLowerCase().includes("urgente");

  if (isOverdue) return 100;
  if (isToday) return 80;
  if (isUrgent) return 60;
  if (next) return 40;
  return 20;
}

export function getSuggestedAction(lead: Lead): { label: string; kind: "call" | "open" | "task" } {
  const status = String(lead.status || "").toLowerCase();
  const notes = String(lead.notes || "").toLowerCase();

  if (status.includes("chiusa 100")) {
    return { label: "Archivio pratica", kind: "open" };
  }

  if (status.includes("pronta per chiusura")) {
    return { label: "Chiudi pratica", kind: "open" };
  }

  if (!lead.nextActionAt) {
    return { label: "Pianifica follow-up", kind: "task" };
  }

  const bucket = getSmartBucket(lead);
  if (bucket === "overdue") return { label: "📞 Chiama subito", kind: "call" };
  if (status.includes("nuovo")) return { label: "🧭 Primo contatto", kind: "call" };
  if (status.includes("preventivo")) return { label: "📨 Invia preventivo", kind: "task" };
  if (notes.includes("pagamento") || notes.includes("saldo") || status.includes("pagament")) {
    return { label: "💶 Sollecita pagamento", kind: "task" };
  }
  return { label: "🔎 Aggiorna pratica", kind: "open" };
}

export function getTimelineLabel(type: string) {
  const normalized = String(type || "").toLowerCase();
  if (normalized.includes("call")) return "Call";
  if (normalized.includes("status")) return "Cambio stato";
  if (normalized.includes("task")) return "Task";
  return type || "Evento";
}

export function getTimelineMeta(type: string) {
  const normalized = String(type || "").toLowerCase();
  if (normalized.includes("call")) return { icon: "📞", className: "call" };
  if (normalized.includes("status")) return { icon: "🔄", className: "status" };
  if (normalized.includes("task")) return { icon: "📝", className: "task" };
  return { icon: "•", className: "generic" };
}

export function getCallOutcomeLabel(outcome?: string | null) {
  const normalized = String(outcome || "").toLowerCase();
  if (normalized === "completed") return "Chiamata completata";
  if (normalized === "no_answer") return "Nessuna risposta";
  if (normalized === "busy") return "Occupato";
  if (normalized === "call_back") return "Da richiamare";
  if (normalized === "interested") return "Interessato";
  if (normalized === "not_interested") return "Non interessato";
  return "Nessuna chiamata";
}

export function getCallOutcomeClass(outcome?: string | null) {
  const normalized = String(outcome || "").toLowerCase();
  if (normalized === "completed" || normalized === "interested") return "pr-call-positive";
  if (normalized === "call_back" || normalized === "busy") return "pr-call-warning";
  if (normalized === "no_answer" || normalized === "not_interested") return "pr-call-negative";
  return "pr-call-neutral";
}

export function getMissingDocumentsCount(lead: Lead) {
  if (typeof lead.documentsMissingCount === "number" && lead.documentsMissingCount > 0) return lead.documentsMissingCount;
  const items = Array.isArray(lead.documents?.items) ? lead.documents?.items : [];
  return items.filter((item) => item.required && (!item.received || !item.verified)).length;
}
