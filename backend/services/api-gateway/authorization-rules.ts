import { AuthRole } from "./auth-store";

function isAdminRole(role: AuthRole) {
  return role === "admin" || role === "super_admin";
}

/**
 * Task board reads/creates/completes/postpones stay open to any authenticated
 * user -- Dashboard, Pratica Detail, Chat and the Booking scheduler all rely
 * on that. The one action gated here is a raw dismiss (status "dismissed"):
 * unlike completing a task, dismissing silently discards it without an
 * outcome, which defeats the Booking "active lead must have a next action"
 * invariant if any operator could do it unchecked.
 */
export function isTaskDismissBlocked(role: AuthRole, nextStatus?: string): boolean {
  return nextStatus === "dismissed" && !isAdminRole(role);
}

/**
 * The template test-send tool fires a template outside the normal compose flow
 * purely to verify template configuration, so it is admin-only. Who may open a
 * conversation is decided in whatsapp-access.ts.
 */
export function isWhatsappTemplateTestSendBlocked(role: AuthRole): boolean {
  return !isAdminRole(role);
}

/** Internal service-to-service routes (automation tick, ...) are never reachable from the browser. */
export function isInternalServicePath(pathname: string): boolean {
  return /^\/api\/whatsapp\/internal(\/|$)/.test(pathname);
}
