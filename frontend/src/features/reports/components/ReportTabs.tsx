import { NavLink } from "react-router-dom";
import { getAuthUser } from "../../../lib/auth";

const TABS = [
  { to: "/analytics", label: "Panoramica", adminOnly: false },
  { to: "/reports/booking-activities", label: "Booking", adminOnly: true },
  { to: "/reports/marketing", label: "Marketing", adminOnly: true }
];

/**
 * Secondary in-page navigation shared by the three Report views. Not a change to the global
 * sidebar (untouched, still links only to /analytics and /reports/booking-activities) -- this is
 * scoped entirely inside the Report pages themselves, same visibility rule the sidebar already
 * applies (Booking/Marketing hidden for non-admins, matching their own RequireAdmin gate).
 */
export function ReportTabs() {
  const user = getAuthUser();
  const isAdmin = user?.role === "admin" || user?.role === "super_admin";
  const tabs = TABS.filter((tab) => !tab.adminOnly || isAdmin);

  return (
    <nav className="rpt-tabs" aria-label="Viste Report">
      {tabs.map((tab) => (
        <NavLink key={tab.to} to={tab.to} end className={({ isActive }) => `rpt-tab ${isActive ? "active" : ""}`}>
          {tab.label}
        </NavLink>
      ))}
    </nav>
  );
}
