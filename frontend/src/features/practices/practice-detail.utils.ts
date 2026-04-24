import { Lead, NextActionMeta, Priority, Task, TimelineMeta } from "./practice-detail.types";

export function includesAny(value: string, terms: string[]) {
  const normalized = String(value || "").toLowerCase();
  return terms.some((term) => normalized.includes(term));
}

export function getStatusLabel(status: string) {
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

export function getStatusClass(status: string) {
  const s = String(status || "").toLowerCase();
  if (s.includes("venduta") || s.includes("invio biglietti") || s.includes("saldo effettuato")) return "pd-status-converted";
  if (s.includes("document") || s.includes("saldo") || s.includes("pagament") || s.includes("rata")) return "pd-status-warning";
  if (s.includes("interess") || s.includes("trattativa") || s.includes("preventivo")) return "pd-status-negotiation";
  if (s.includes("contatt") || s.includes("richiam") || s.includes("non risponde")) return "pd-status-contact";
  if (s.includes("pers")) return "pd-status-lost";
  return "pd-status-new";
}

export function getPriority(lead: Lead): Priority {
  const status = String(lead.status || "").toLowerCase();
  const notes = String(lead.notes || "").toLowerCase();
  if (!lead.nextActionAt || includesAny(status + notes, ["document", "saldo", "pagament", "scad", "urg"])) return "alta";
  if (includesAny(status + notes, ["contatt", "trattativa", "preventivo", "richiam"])) return "media";
  return "bassa";
}

export function getPriorityLabel(priority: Priority) {
  if (priority === "alta") return "Alta priorità";
  if (priority === "media") return "Media priorità";
  return "Bassa priorità";
}

export function getTimelineLabel(type: string) {
  const t = String(type || "").toLowerCase();
  if (t.includes("call")) return "Call";
  if (t.includes("status")) return "Cambio stato";
  if (t.includes("task")) return "Task";
  if (t.includes("note")) return "Nota";
  return type || "Evento";
}

export function getTimelineMeta(type: string): TimelineMeta {
  const t = String(type || "").toLowerCase();
  if (t.includes("call")) return { icon: "📞", className: "call" };
  if (t.includes("status")) return { icon: "🔄", className: "status" };
  if (t.includes("task")) return { icon: "✅", className: "task" };
  if (t.includes("note")) return { icon: "📝", className: "note" };
  return { icon: "•", className: "generic" };
}

export function getNextActionMeta(value?: string): NextActionMeta {
  if (!value) {
    return {
      label: "🔴 Nessuna attività programmata",
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
      label: "🔴 Azione scaduta",
      detail: `Scadenza: ${dateText}`,
      className: "pd-next-overdue"
    };
  }
  if (target.getTime() === today.getTime()) {
    return {
      label: "🟡 Azione oggi",
      detail: `Scadenza: ${dateText}`,
      className: "pd-next-today"
    };
  }
  return {
    label: "🟢 Azione pianificata",
    detail: `Scadenza: ${dateText}`,
    className: "pd-next-planned"
  };
}

export function getActionNameFromTask(task?: Task | null) {
  if (!task) return "Richiamare cliente";
  const title = String(task.title || "").trim();
  if (!title) return "Richiamare cliente";
  return title.length > 48 ? `${title.slice(0, 48)}...` : title;
}

export function formatDateDisplay(value?: string) {
  if (!value) return "Da pianificare";
  return new Date(value).toLocaleString("it-IT");
}

export function getPracticeLabel(lead: Lead) {
  const source = String(lead.source || "").trim();
  if (!source) return "MSC Crociere · Itinerario da definire";
  return `${source} · Itinerario da definire`;
}

export function buildAssignees(leadsData: Lead[]): string[] {
  return Array.from(new Set((Array.isArray(leadsData) ? leadsData : []).map((lead) => String(lead.assignedTo || "").trim()).filter(Boolean))).sort(
    (a, b) => a.localeCompare(b, "it")
  );
}

export function normalizeNoteHistoryFromTimeline(timeline: { type: string; text: string; createdAt: string; actor: string }[]) {
  return timeline
    .filter((item) => includesAny(item.type, ["note", "lead_updated"]))
    .map((item, index) => ({
      id: `timeline-${index}-${item.createdAt}`,
      text: item.text,
      createdAt: item.createdAt,
      actor: item.actor || "operatore"
    }));
}
