import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { buildBookingWorkbook, dateTimeToSerial, dateToSerial, EXCEL_COLUMNS, type BookingReportRow } from "./booking-excel";

const row = (overrides: Partial<BookingReportRow> = {}): BookingReportRow => ({
  operatore: "giuseppe", cliente: "Mario Rossi", leadId: "lead_1791", data: "2026-10-20", ora: "10:15",
  numeroContatto: "+393331234567", tipoAttivita: "Chiamata", esito: "Appuntamento fissato",
  note: "Richiamare dopo le 18; chiede preventivo", appuntamento: "22/10/2026 16:00", preventivo: "",
  motivoPerdita: "", campagna: "-promo", prodotto: "", prossimaAzione: "22/10/2026 16:00", canale: "3cx", statoLead: "In contatto",
  ...overrides
});

/** Writes a real .xlsx file and reads it back, as Excel would receive it. */
function roundTrip(rows: BookingReportRow[]) {
  const bytes = XLSX.write(buildBookingWorkbook(XLSX, rows), { type: "array", bookType: "xlsx" });
  const book = XLSX.read(bytes, { type: "array", cellNF: true });
  return book.Sheets[book.SheetNames[0]];
}
const col = (header: string) => XLSX.utils.encode_col(EXCEL_COLUMNS.findIndex(([name]) => name === header));

describe("booking Excel export", () => {
  it("dates are real Excel dates in Italian format, sortable and filterable", () => {
    const sheet = roundTrip([row(), row({ data: "2026-11-02" })]);
    expect(sheet[col("Data") + "2"]).toMatchObject({ t: "n", w: "20/10/2026" });
    expect(sheet[col("Data") + "2"].v).toBeLessThan(sheet[col("Data") + "3"].v);
    expect(sheet[col("Appuntamento") + "2"]).toMatchObject({ t: "n", w: "22/10/2026 16:00" });
    expect(sheet[col("Prossima azione") + "2"].t).toBe("n");
  });

  it("phones and values starting with + - = stay text, never numbers or formulas", () => {
    const sheet = roundTrip([row({ note: "=HYPERLINK(\"http://x\")", cliente: "@cliente" })]);
    expect(sheet[col("Numero contatto") + "2"]).toMatchObject({ t: "s", v: "+393331234567" });
    expect(sheet[col("Campagna") + "2"]).toMatchObject({ t: "s", v: "-promo" });
    expect(sheet[col("Note") + "2"]).toMatchObject({ t: "s", v: "=HYPERLINK(\"http://x\")" });
    expect(sheet[col("Note") + "2"].f).toBeUndefined();
    expect(sheet[col("Cliente") + "2"].v).toBe("@cliente");
  });

  it("missing or malformed dates stay as they are instead of becoming wrong dates", () => {
    const sheet = roundTrip([row({ data: "", appuntamento: "", prossimaAzione: "31/02/2026 10:00" })]);
    expect(sheet[col("Data") + "2"]).toMatchObject({ t: "s", v: "" });
    expect(sheet[col("Prossima azione") + "2"]).toMatchObject({ t: "s", v: "31/02/2026 10:00" });
    expect(dateToSerial("2026-02-31")).toBeNull();
    expect(dateTimeToSerial("22/10/2026 24:00")).toBeNull();
  });

  it("headers, filter on every column, readable widths, an empty report still has its header", () => {
    const sheet = roundTrip([row({ note: "x".repeat(200) })]);
    expect(EXCEL_COLUMNS.map(([header], index) => sheet[XLSX.utils.encode_col(index) + "1"].v)).toEqual(EXCEL_COLUMNS.map(([header]) => header));
    expect(sheet["!autofilter"]?.ref).toBe("A1:Q2");
    const empty = roundTrip([]);
    expect(empty["!ref"]).toBe("A1:Q1");
    const book = buildBookingWorkbook(XLSX, [row({ note: "x".repeat(200) })]);
    const widths = book.Sheets["Attivita booking"]["!cols"]!.map((c) => c.wch);
    expect(widths[EXCEL_COLUMNS.findIndex(([h]) => h === "Note")]).toBe(60);
    expect(Math.min(...(widths as number[]))).toBeGreaterThanOrEqual(10);
  });
});
