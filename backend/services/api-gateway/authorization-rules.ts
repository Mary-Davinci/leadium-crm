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
 * WhatsApp is a shared inbox by product design: reading any conversation,
 * claiming/releasing ownership, and sending on any conversation are all
 * intentionally open to every authenticated operator. The template
 * test-send tool is the exception -- it fires a template outside the normal
 * compose flow purely to verify template configuration, so it is admin-only.
 */
export function isWhatsappTemplateTestSendBlocked(role: AuthRole): boolean {
  return !isAdminRole(role);
}
