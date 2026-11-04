import { describe, expect, it } from "vitest";
import { isClosedLead, isStaleLead, isWorkedLead } from "./worked";

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
  it("tells closed practices from work that is only done for now", () => {
    for (const lead of [{ closingOutcome: "won" }, { closingOutcome: "lost" }, { status: "Persa" }, { closedAt: "2026-11-04T12:00:00Z" }]) expect(isClosedLead(lead)).toBe(true);
    expect(isClosedLead({ status: "Contatto interessato", workedAt: "2026-11-02T12:00:00Z" })).toBe(false);
    expect(isWorkedLead({ closedAt: "2026-11-04T12:00:00Z" })).toBe(true);
  });

  it("finds cleanup candidates: old, and never a sale", () => {
    const now = Date.parse("2026-11-04T12:00:00Z");
    expect(isStaleLead({ updatedAt: "2026-04-01T12:00:00Z" }, now)).toBe(true);
    expect(isStaleLead({ updatedAt: "2026-09-01T12:00:00Z" }, now)).toBe(false);
    expect(isStaleLead({ createdAt: "2026-01-01T12:00:00Z" }, now)).toBe(true);
    expect(isStaleLead({ updatedAt: "2026-04-01T12:00:00Z", closingOutcome: "won" }, now)).toBe(false);
    expect(isStaleLead({}, now)).toBe(false);
  });

  it("returns explicitly completed work to active when undone", () => {
    expect(isWorkedLead({ status: "Contatto interessato", closingOutcome: "open", workedAt: null })).toBe(false);
  });
});
