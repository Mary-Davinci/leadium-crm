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

// Report values come from hand-typed and imported data (newlines in notes, stray tabs, phones
// written every possible way), so every cell is normalized here once, for the preview, the CSV
// and the Excel export alike.
const ROME_PARTS = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Rome",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23"
});

function romeParts(value: unknown) {
  const date = value ? new Date(String(value)) : null;
  if (!date || !Number.isFinite(date.getTime())) return null;
  const parts = Object.fromEntries(ROME_PARTS.formatToParts(date).map((part) => [part.type, part.value]));
  return { isoDate: `${parts.year}-${parts.month}-${parts.day}`, itDate: `${parts.day}/${parts.month}/${parts.year}`, time: `${parts.hour}:${parts.minute}` };
}

/** Italian date + time in Europe/Rome ("10/03/2026 10:00"), or "" for missing/invalid input. */
export function formatReportDateTime(value: unknown) {
  const parts = romeParts(value);
  return parts ? `${parts.itDate} ${parts.time}` : "";
}

/** One-line, trimmed text: newlines/tabs become spaces, control characters are dropped. */
export function cleanReportText(value: unknown) {
  return String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * One international form per number, never an invented prefix:
 * "+39 333-123 4567" / "0039 333..." -> "+393331234567"; Italian national mobile (3...) and
 * landline (0...) get +39; WhatsApp ids ("39" + 9-10 digits) get "+"; any other shape stays
 * digits only; nothing without digits -> "".
 */
export function cleanReportPhone(value: unknown) {
  const raw = String(value ?? "").trim();
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  if (raw.startsWith("+")) return `+${digits}`;
  if (digits.startsWith("00")) return `+${digits.slice(2)}`;
  if (/^3\d{8,9}$/.test(digits) || /^0\d{5,10}$/.test(digits)) return `+39${digits}`;
  if (/^39\d{9,10}$/.test(digits)) return `+${digits}`;
  return digits;
}

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
    // Date/time in Italian local time: toISOString() would be UTC, one or two hours early.
    const started = romeParts(call.startedAt);
    const outcome = cleanReportText(call.outcome);
    rows.push({
      operatore: cleanReportText(call.actor),
      cliente: cleanReportText(lead.fullName),
      leadId: cleanReportText(lead.id),
      data: started ? started.isoDate : "",
      ora: started ? started.time : "",
      numeroContatto: cleanReportPhone(lead.phone),
      tipoAttivita: "Chiamata",
      esito: OUTCOME_LABELS[outcome] || outcome,
      note: cleanReportText(call.note),
      appuntamento: outcome === "appointment_set" ? formatReportDateTime(lead.nextActionAt) : "",
      preventivo: QUOTE_OUTCOMES.has(outcome) ? "Si" : "",
      motivoPerdita: cleanReportText(lead.lossReason),
      campagna: cleanReportText(lead.sourceCampaignId || lead.sourcePlatform),
      prodotto: cleanReportText(latestPurchase?.product),
      prossimaAzione: formatReportDateTime(lead.nextActionAt),
      canale: cleanReportText(call.source),
      statoLead: cleanReportText(lead.status)
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

// Shared by the CSV and the Excel export so both always have the same columns in the same order.
export function buildBookingActivityCsvRows(rows: BookingActivityRow[]): Array<Array<string>> {
  return rows.map((row) => [
    row.operatore,
    row.cliente,
    row.leadId,
    row.data ? row.data.split("-").reverse().join("/") : "",
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
