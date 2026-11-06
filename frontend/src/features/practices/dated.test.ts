import { describe, expect, it } from "vitest";
import { datedKind, describeSource, isDatedLead, lastActivityAt, loadedFiles, monthsAgoLabel } from "./dated";

const now = Date.parse("2026-11-06T12:00:00Z");
const ago = (months: number) => new Date(now - months * 30 * 24 * 3600 * 1000).toISOString();

describe("contatti datati", () => {
  it("counts from the last real contact, not from who last touched the record", () => {
    expect(isDatedLead({ lastContactAt: ago(7), createdAt: ago(20) }, now, 6)).toBe(true);
    expect(isDatedLead({ lastContactAt: ago(2), createdAt: ago(20) }, now, 6)).toBe(false);
    expect(isDatedLead({ lastContactAt: ago(7) }, now, 12)).toBe(false);
    expect(isDatedLead({}, now, 6)).toBe(false);
  });
  it("an old contact uploaded recently is old: the file's own date wins", () => {
    const lead = { createdAt: ago(1), notes: `Campagna: Caraibi\nLead creata il: ${ago(10)}\nForm: crociere` };
    expect(lastActivityAt(lead)).toBe(Date.parse(ago(10)));
    expect(isDatedLead(lead, now, 6)).toBe(true);
    expect(isDatedLead({ createdAt: ago(1), notes: "Lead creata il: non una data" }, now, 6)).toBe(false);
  });
  it("sales and contacts with a callback still to come stay out", () => {
    expect(isDatedLead({ createdAt: ago(9), closingOutcome: "won" }, now, 6)).toBe(false);
    expect(isDatedLead({ createdAt: ago(9), status: "Primo acconto" }, now, 6)).toBe(false);
    expect(isDatedLead({ createdAt: ago(9), nextActionAt: ago(-1) }, now, 6)).toBe(false);
    expect(isDatedLead({ createdAt: ago(9), nextActionAt: ago(8) }, now, 6)).toBe(true);
  });
  it("sorts them by what an admin decides on", () => {
    expect(datedKind({ callAttempts: 0 })).toBe("never-contacted");
    expect(datedKind({ status: "Non risponde", callAttempts: 3, lastContactAt: ago(8) })).toBe("no-answer");
    expect(datedKind({ status: "Non risponde", callAttempts: 1, lastContactAt: ago(8) })).toBe("worked");
    expect(datedKind({ status: "Contatto interessato", lastContactAt: ago(8) })).toBe("worked");
  });
  it("reads the file the contact was loaded from", () => {
    expect(describeSource("excel_campagna_caraibi_2025")).toEqual({ channel: "Excel", detail: "campagna caraibi 2025", file: "excel_campagna_caraibi_2025" });
    expect(describeSource("excel_import_20261105").detail).toBe("Importazione del 05/11/2026");
    expect(describeSource("3cx_chiamata").channel).toBe("Chiamata in arrivo");
    expect(describeSource("whatsapp_chat").channel).toBe("WhatsApp");
    expect(describeSource("").channel).toBe("Import");
    expect(describeSource("passaparola_agenzia").channel).toBe("passaparola agenzia");
  });
  it("lists each file once, oldest first, with its load date", () => {
    const files = loadedFiles([
      { source: "excel_nuovo", createdAt: ago(1) },
      { source: "excel_vecchio", createdAt: ago(9) },
      { source: "excel_vecchio", createdAt: ago(10) },
      { source: "whatsapp_chat", createdAt: ago(10) }
    ]);
    expect(files.map((file) => [file.label, file.count])).toEqual([["vecchio", 2], ["nuovo", 1]]);
    expect(files[0].loadedAt).toBe(Date.parse(ago(10)));
  });
  it("says how long ago in months", () => {
    expect(monthsAgoLabel(Date.parse(ago(0.5)), now)).toBe("Meno di un mese fa");
    expect(monthsAgoLabel(Date.parse(ago(1)), now)).toBe("1 mese fa");
    expect(monthsAgoLabel(Date.parse(ago(9)), now)).toBe("9 mesi fa");
  });
});
