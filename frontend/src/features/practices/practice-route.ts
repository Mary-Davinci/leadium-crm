/**
 * The practice as a cruise route: five stops derived from the workflow status only
 * (backend/services/common/workflow.ts), so the card never invents progress.
 */
export const ROUTE_STOPS = [
  { key: "contact", label: "Primo contatto", hint: "Chiamata o messaggio" },
  { key: "negotiation", label: "Trattativa", hint: "Proposta e preventivo" },
  { key: "sale", label: "Vendita", hint: "Acconto e contratto" },
  { key: "post_sale", label: "Documenti e saldo", hint: "Prima della partenza" },
  { key: "closure", label: "Chiusura", hint: "Supervisione admin" }
] as const;

const STOP_BY_STATUS: Record<string, number> = {
  "Da contattare": 0,
  "Non risponde": 0,
  "Richiamo concordato": 0,
  "Contatto interessato": 1,
  "Vendita a rate": 2,
  "Vendita unica": 2,
  "Primo acconto": 2,
  "Secondo acconto": 2,
  "Saldo": 3,
  "Venduta": 3,
  "Invio gadget": 3,
  "Invio biglietti": 3,
  "Pronta per chiusura": 4,
  "Chiusa 100%": 4
};

/** Statuses that end the practice without a sale: the route is shown as stopped. */
const STOPPED_STATUSES = new Set(["Contattato non interessato", "Fuori budget", "Persa", "Annulla flusso"]);

export type PracticeRoute = {
  /** Index of the current stop, -1 when unknown. */
  current: number;
  /** Ended without a sale (not interested, out of budget, lost, cancelled). */
  stopped: boolean;
  /** All five stops done (practice closed 100%). */
  completed: boolean;
  /** Share of the route covered, 0..1, for the progress bar. */
  progress: number;
};

export function getPracticeRoute(status: string | null | undefined): PracticeRoute {
  const value = String(status || "").trim();
  if (STOPPED_STATUSES.has(value)) return { current: -1, stopped: true, completed: false, progress: 0 };
  const current = Object.prototype.hasOwnProperty.call(STOP_BY_STATUS, value) ? STOP_BY_STATUS[value] : -1;
  const completed = value === "Chiusa 100%";
  const progress = current < 0 ? 0 : completed ? 1 : (current + 0.5) / ROUTE_STOPS.length;
  return { current, stopped: false, completed, progress };
}
