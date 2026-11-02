import { describe, expect, it } from "vitest";
import { isWorkedLead } from "./worked";

describe("operator worked queue", () => {
  it("keeps notes and non-terminal call outcomes in active work", () => {
    for (const status of ["Da contattare", "Non risponde", "Richiamo concordato", "Contatto interessato", "Primo acconto"]) {
      expect(isWorkedLead({ status, closingOutcome: "open" })).toBe(false);
    }
  });
  it("moves final outcomes and explicitly completed work out of the active queue", () => {
    for (const closingOutcome of ["won", "lost", "disqualified"]) expect(isWorkedLead({ closingOutcome })).toBe(true);
    for (const status of ["Contattato non interessato", "Fuori budget", "Persa", "Venduta"]) expect(isWorkedLead({ status })).toBe(true);
    expect(isWorkedLead({ status: "Contatto interessato", workedAt: "2026-11-02T12:00:00Z" })).toBe(true);
  });
  it("returns explicitly completed work to active when undone", () => {
    expect(isWorkedLead({ status: "Contatto interessato", closingOutcome: "open", workedAt: null })).toBe(false);
  });
});
