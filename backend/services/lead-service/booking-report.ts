import { PurchaseRecord } from "../common/purchaseStore";

// Looser than CallLogRecord's own CallOutcome union: the report must stay robust to any stored
// outcome value (legacy data, future additions) rather than assume the enum is exhaustive.
type BookingCallLogInput = {
  leadId: string;
  startedAt: string;
  outcome: string;
  actor: string;
  note?: string;
  source?: string;
};

export type BookingActivityFilters = {
  dateFrom?: string;
  dateTo?: string;
  operatore?: string;
  campagna?: string;
  prodotto?: string;
  canale?: string;
  esito?: string;
  statoLead?: string;
};

export type BookingActivityRow = {
  operatore: string;
  cliente: string;
  leadId: string;
  data: string;
  ora: string;
  numeroContatto: string;
  tipoAttivita: string;
  esito: string;
  note: string;
  appuntamento: string;
  preventivo: string;
  motivoPerdita: string;
  campagna: string;
  prodotto: string;
  prossimaAzione: string;
  canale: string;
  statoLead: string;
};

const OUTCOME_LABELS: Record<string, string> = {
  completed: "Completata",
  no_answer: "Non risponde",
  busy: "Occupato",
  call_back: "Da richiamare",
  interested: "Interessato",
  not_interested: "Non interessato",
  quote_required: "Preventivo richiesto",
  quote_sent: "Preventivo inviato",
  appointment_set: "Appuntamento fissato",
  other: "Altro"
};

const QUOTE_OUTCOMES = new Set(["quote_required", "quote_sent"]);

export const BOOKING_ACTIVITY_HEADERS = [
  "Operatore",
  "Cliente",
  "Lead/Pratica",
  "Data",
  "Ora",
  "Numero contatto",
  "Tipo attivita",
  "Esito",
  "Note",
  "Appuntamento",
  "Preventivo",
  "Motivo perdita/non interesse",
  "Campagna",
  "Prodotto",
  "Prossima azione",
  "Canale",
  "Stato pratica"
];

/**
 * "Attivita Booking" = the call dispositions recorded by the Booking Workflow (callStore), joined
 * against the owning Lead (for customer/campaign/status context) and, when the lead resulted in a
 * sale, its Purchase (for "prodotto"). WhatsApp-originated activities (customer actions, template
 * sends) are tracked as Lead activities/tasks but are a different shape and are not folded into
 * this same report -- documented as a boundary, not built here, to avoid an ad hoc unified log.
 */
export function buildBookingActivityRows(
  callLogs: BookingCallLogInput[],
  leadsById: Map<string, any>,
  purchasesByLeadId: Map<string, PurchaseRecord[]>
): BookingActivityRow[] {
  const rows: BookingActivityRow[] = [];
  for (const call of callLogs) {
    const lead = leadsById.get(call.leadId);
    if (!lead) continue;
    const purchases = purchasesByLeadId.get(call.leadId) || [];
    const latestPurchase = purchases[0] || null;
    const startedAt = new Date(call.startedAt);
    const hasValidDate = Number.isFinite(startedAt.getTime());
    const outcome = String(call.outcome || "");
    rows.push({
      operatore: String(call.actor || ""),
      cliente: String(lead.fullName || ""),
      leadId: String(lead.id || ""),
      data: hasValidDate ? startedAt.toISOString().slice(0, 10) : "",
      ora: hasValidDate ? startedAt.toISOString().slice(11, 16) : "",
      numeroContatto: String(lead.phone || ""),
      tipoAttivita: "Chiamata",
      esito: OUTCOME_LABELS[outcome] || outcome,
      note: String(call.note || ""),
      appuntamento: outcome === "appointment_set" ? String(lead.nextActionAt || "") : "",
      preventivo: QUOTE_OUTCOMES.has(outcome) ? "Si" : "",
      motivoPerdita: String(lead.lossReason || ""),
      campagna: String(lead.sourceCampaignId || lead.sourcePlatform || ""),
      prodotto: String(latestPurchase?.product || ""),
      prossimaAzione: String(lead.nextActionAt || ""),
      canale: String(call.source || ""),
      statoLead: String(lead.status || "")
    });
  }
  return rows.sort((a, b) => `${b.data}${b.ora}`.localeCompare(`${a.data}${a.ora}`));
}

export function filterBookingActivityRows(rows: BookingActivityRow[], filters: BookingActivityFilters): BookingActivityRow[] {
  const dateFrom = String(filters.dateFrom || "").trim();
  const dateTo = String(filters.dateTo || "").trim();
  const operatore = String(filters.operatore || "").trim();
  const campagna = String(filters.campagna || "").trim();
  const prodotto = String(filters.prodotto || "").trim();
  const canale = String(filters.canale || "").trim();
  const esito = String(filters.esito || "").trim();
  const statoLead = String(filters.statoLead || "").trim();

  return rows.filter((row) => {
    if (dateFrom && row.data && row.data < dateFrom) return false;
    if (dateTo && row.data && row.data > dateTo) return false;
    if (operatore && row.operatore !== operatore) return false;
    if (campagna && row.campagna !== campagna) return false;
    if (prodotto && row.prodotto !== prodotto) return false;
    if (canale && row.canale !== canale) return false;
    if (esito && row.esito !== esito) return false;
    if (statoLead && row.statoLead !== statoLead) return false;
    return true;
  });
}

export function buildBookingActivityCsvRows(rows: BookingActivityRow[]): Array<Array<string>> {
  return rows.map((row) => [
    row.operatore,
    row.cliente,
    row.leadId,
    row.data,
    row.ora,
    row.numeroContatto,
    row.tipoAttivita,
    row.esito,
    row.note,
    row.appuntamento,
    row.preventivo,
    row.motivoPerdita,
    row.campagna,
    row.prodotto,
    row.prossimaAzione,
    row.canale,
    row.statoLead
  ]);
}
