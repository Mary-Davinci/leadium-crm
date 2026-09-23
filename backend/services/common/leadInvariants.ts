import { LEAD_STATUSES } from "./workflow";

export type LeadInvariantInput = {
  status?: string;
  closingOutcome?: string;
  nextActionAt?: string | null;
};

/**
 * Central, testable definition of when the "active lead must have a next
 * action" rule does NOT apply. Keep this narrow and explicit -- every new
 * exemption here is a deliberate business decision, not a workaround.
 *
 * - a lead that is no longer "open" (won/lost/disqualified) is not active,
 *   the invariant is meaningless for it.
 * - a brand-new lead still sitting at "Da contattare" hasn't been worked yet;
 *   it must be allowed to exist without a next action until first contact.
 */
export function isActiveLeadInvariantExempt(lead: LeadInvariantInput): boolean {
  const closingOutcome = String(lead.closingOutcome || "open");
  if (closingOutcome !== "open") return true;
  if (String(lead.status || "") === LEAD_STATUSES.TO_CONTACT) return true;
  return false;
}

/**
 * Whether this lead currently satisfies "no active lead without an outcome
 * or a next action": either it's exempt, or it has a scheduled nextActionAt,
 * or it has at least one open operational task tracking what happens next.
 *
 * `honorPreContactExemption` defaults to true for general-purpose callers
 * (e.g. a dashboard "leads with no next action" count, which should not flag
 * a lead that has simply never been worked yet). Pass `false` from the one
 * call site that matters most -- right after an operator records a commercial
 * activity outcome -- because at that moment contact has just happened, so
 * "never contacted yet" is no longer a valid excuse for leaving no next step.
 */
export function isActiveLeadInvariantSatisfied(
  lead: LeadInvariantInput,
  options: { hasOpenOperationalTask?: boolean; honorPreContactExemption?: boolean } = {}
): boolean {
  const { hasOpenOperationalTask = false, honorPreContactExemption = true } = options;
  const closingOutcome = String(lead.closingOutcome || "open");
  if (closingOutcome !== "open") return true;
  if (honorPreContactExemption && String(lead.status || "") === LEAD_STATUSES.TO_CONTACT) return true;
  if (Boolean(lead.nextActionAt)) return true;
  return hasOpenOperationalTask;
}
