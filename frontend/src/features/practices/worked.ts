export type WorkState = { status?: string; closingOutcome?: string; workedAt?: string | null; closedAt?: string | null };

/** The commercial path is over: a final outcome, or closed by hand. Nobody should call again. */
export function isClosedLead(lead: WorkState) {
  return Boolean(lead.closedAt) || ["won", "lost", "disqualified"].includes(lead.closingOutcome || "") ||
    ["contattato non interessato", "fuori budget", "persa", "venduta"].includes(String(lead.status || "").trim().toLowerCase());
}

export const STALE_MONTHS = 6;

/** No movement for months and no sale: the candidates of a database cleanup. */
export function isStaleLead(lead: { updatedAt?: string; createdAt?: string; closingOutcome?: string }, now: number) {
  const last = Date.parse(String(lead.updatedAt || lead.createdAt || ""));
  return Number.isFinite(last) && lead.closingOutcome !== "won" && now - last > STALE_MONTHS * 30 * 24 * 3600 * 1000;
}

/** Out of the active queue: done for now, or closed. */
export function isWorkedLead(lead: WorkState) {
  return Boolean(lead.workedAt) || isClosedLead(lead);
}
