import { Bell } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { getAuthUser } from "../lib/auth";
import { getTaskBoardCache } from "../store/crm-store";

const key = (value?: string | null) => String(value || "").trim().toLocaleLowerCase("it");
const timestamp = (value?: string | null) => (value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0);

/**
 * Reads the same task-board cache GlobalSearch/Dashboard populate -- no dedicated notifications
 * endpoint exists, so this counts real overdue open tasks rather than showing fabricated content.
 */
export function NotificationsBell() {
  const navigate = useNavigate();
  const user = getAuthUser();
  const isAdmin = user?.role === "admin" || user?.role === "super_admin";
  const actorKeys = [user?.username, user?.name, user?.email].map(key).filter(Boolean);
  const cached = getTaskBoardCache();
  const tasks = cached?.data.tasks || [];
  const overdueCount = tasks.filter((task) => {
    if (task.status !== "open") return false;
    if (!isAdmin && !actorKeys.includes(key(task.assignedTo))) return false;
    return Boolean(timestamp(task.dueAt)) && timestamp(task.dueAt) < Date.now();
  }).length;

  return (
    <button
      type="button"
      className="header-icon-btn"
      aria-label={overdueCount ? `${overdueCount} attivita in ritardo` : "Nessuna attivita in ritardo"}
      onClick={() => navigate(isAdmin ? "/tasks" : "/pratiche")}
    >
      <Bell size={17} aria-hidden="true" />
      {overdueCount ? <span className="header-icon-badge">{overdueCount > 99 ? "99+" : overdueCount}</span> : null}
    </button>
  );
}
