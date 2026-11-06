export type WorkState = { status?: string; closingOutcome?: string; workedAt?: string | null; closedAt?: string | null };

/** The commercial path is over: a final outcome, or closed by hand. Nobody should call again. */
export function isClosedLead(lead: WorkState) {
  return Boolean(lead.closedAt) || ["won", "lost", "disqualified"].includes(lead.closingOutcome || "") ||
    ["contattato non interessato", "fuori budget", "persa", "venduta"].includes(String(lead.status || "").trim().toLowerCase());
}

/** Out of the active queue: done for now, or closed. */
export function isWorkedLead(lead: WorkState) {
  return Boolean(lead.workedAt) || isClosedLead(lead);
}
