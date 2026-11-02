export type WorkState = { status?: string; closingOutcome?: string; workedAt?: string | null };

export function isWorkedLead(lead: WorkState) {
  return Boolean(lead.workedAt) || ["won", "lost", "disqualified"].includes(lead.closingOutcome || "") ||
    ["contattato non interessato", "fuori budget", "persa", "venduta"].includes(String(lead.status || "").trim().toLowerCase());
}
