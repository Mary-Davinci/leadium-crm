import { describe, expect, it } from "vitest";
import { getPracticeRoute, ROUTE_STOPS } from "./practice-route";

describe("getPracticeRoute", () => {
  it("maps every open workflow status to one of the five stops", () => {
    expect(getPracticeRoute("Da contattare").current).toBe(0);
    expect(getPracticeRoute("Richiamo concordato").current).toBe(0);
    expect(getPracticeRoute("Contatto interessato").current).toBe(1);
    expect(getPracticeRoute("Primo acconto").current).toBe(2);
    expect(getPracticeRoute("Invio biglietti").current).toBe(3);
    expect(getPracticeRoute("Pronta per chiusura").current).toBe(4);
    expect(ROUTE_STOPS).toHaveLength(5);
  });

  it("marks a practice ended without a sale as stopped, not as progress", () => {
    for (const status of ["Contattato non interessato", "Fuori budget", "Persa", "Annulla flusso"]) {
      expect(getPracticeRoute(status)).toEqual({ current: -1, stopped: true, completed: false, progress: 0 });
    }
  });

  it("is complete only when closed 100% and never invents a stop for unknown statuses", () => {
    expect(getPracticeRoute("Chiusa 100%")).toMatchObject({ current: 4, completed: true, progress: 1 });
    expect(getPracticeRoute("Pronta per chiusura").completed).toBe(false);
    expect(getPracticeRoute("Stato sconosciuto")).toMatchObject({ current: -1, stopped: false, progress: 0 });
    expect(getPracticeRoute(undefined).current).toBe(-1);
  });
});
