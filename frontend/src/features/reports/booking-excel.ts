import type * as XLSXTypes from "xlsx";

export type BookingReportRow = {
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

type ColumnKind = "text" | "date" | "datetime";

// Same columns, order and headers as the server CSV (BOOKING_ACTIVITY_HEADERS).
export const EXCEL_COLUMNS: Array<[string, keyof BookingReportRow, ColumnKind]> = [
  ["Operatore", "operatore", "text"],
  ["Cliente", "cliente", "text"],
  ["Lead/Pratica", "leadId", "text"],
  ["Data", "data", "date"],
  ["Ora", "ora", "text"],
  ["Numero contatto", "numeroContatto", "text"],
  ["Tipo attivita", "tipoAttivita", "text"],
  ["Esito", "esito", "text"],
  ["Note", "note", "text"],
  ["Appuntamento", "appuntamento", "datetime"],
  ["Preventivo", "preventivo", "text"],
  ["Motivo perdita/non interesse", "motivoPerdita", "text"],
  ["Campagna", "campagna", "text"],
  ["Prodotto", "prodotto", "text"],
  ["Prossima azione", "prossimaAzione", "datetime"],
  ["Canale", "canale", "text"],
  ["Stato pratica", "statoLead", "text"]
];

const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const DAY_MS = 86400000;

/** Excel serial day for a calendar date/time (already in Italian local time), or null if malformed. */
function excelSerial(year: number, month: number, day: number, hour = 0, minute = 0) {
  const utc = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(utc);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || hour > 23 || minute > 59) return null;
  return (utc - EXCEL_EPOCH) / DAY_MS;
}

/** "2026-10-20" (report date) -> serial; anything else -> null (kept as text). */
export function dateToSerial(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
  return match ? excelSerial(+match[1], +match[2], +match[3]) : null;
}

/** "22/10/2026 16:00" (report date-time, Italian time) -> serial; anything else -> null. */
export function dateTimeToSerial(value: string) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/.exec(value || "");
  return match ? excelSerial(+match[3], +match[2], +match[1], +match[4], +match[5]) : null;
}

/**
 * The booking activities sheet. Dates are real Excel dates (sortable and filterable), everything
 * else is text: phone numbers keep their "+39" and digits instead of becoming 3,93E+11, and no
 * value is ever turned into a formula. Header row with filters, columns sized on their content.
 */
export function buildBookingSheet(XLSX: typeof XLSXTypes, rows: BookingReportRow[]): XLSXTypes.WorkSheet {
  const sheet: XLSXTypes.WorkSheet = {};
  const widths = EXCEL_COLUMNS.map(([header]) => header.length);
  EXCEL_COLUMNS.forEach(([header], col) => {
    sheet[XLSX.utils.encode_cell({ r: 0, c: col })] = { t: "s", v: header };
  });
  rows.forEach((row, index) => {
    EXCEL_COLUMNS.forEach(([, key, kind], col) => {
      const text = String(row[key] ?? "");
      const address = XLSX.utils.encode_cell({ r: index + 1, c: col });
      const serial = kind === "date" ? dateToSerial(text) : kind === "datetime" ? dateTimeToSerial(text) : null;
      if (serial !== null) {
        sheet[address] = { t: "n", v: serial, z: kind === "date" ? "dd/mm/yyyy" : "dd/mm/yyyy hh:mm" };
        widths[col] = Math.max(widths[col], kind === "date" ? 10 : 16);
      } else {
        sheet[address] = { t: "s", v: text };
        widths[col] = Math.max(widths[col], text.length);
      }
    });
  });
  const range = { s: { r: 0, c: 0 }, e: { r: rows.length, c: EXCEL_COLUMNS.length - 1 } };
  sheet["!ref"] = XLSX.utils.encode_range(range);
  sheet["!autofilter"] = { ref: XLSX.utils.encode_range(range) };
  sheet["!cols"] = widths.map((width) => ({ wch: Math.min(60, Math.max(10, width + 2)) }));
  return sheet;
}

export function buildBookingWorkbook(XLSX: typeof XLSXTypes, rows: BookingReportRow[]) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, buildBookingSheet(XLSX, rows), "Attivita booking");
  return workbook;
}
