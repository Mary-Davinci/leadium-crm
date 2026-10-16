import { BarChart3, ClipboardList, LayoutDashboard, MessageCircle, Phone, UsersRound, Workflow, FolderKanban, type LucideIcon } from "lucide-react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { getAuthUser } from "../lib/auth";
import { Header } from "./Header";
import { ThreeCxProvider } from "../features/calls/threecx-context";
import "../styles/layout.css";

type MenuItem = {
  to: string;
  label: string;
  icon: LucideIcon;
};

const MENU: MenuItem[] = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/tasks", label: "Gestione operativa", icon: Workflow },
  { to: "/pratiche", label: "Pratiche", icon: FolderKanban },
  { to: "/chat", label: "Chat", icon: MessageCircle },
  { to: "/calls", label: "Chiamate", icon: Phone },
  { to: "/analytics", label: "Report", icon: BarChart3 },
  { to: "/reports/booking-activities", label: "Report Booking", icon: ClipboardList },
  { to: "/users", label: "Utenti", icon: UsersRound }
];

function getTitle(pathname: string) {
  if (pathname.startsWith("/tasks/import")) return "Importa lead";
  if (pathname.startsWith("/tasks") || pathname.startsWith("/leadboard")) return "Gestione operativa";
  if (pathname.startsWith("/pratiche")) return "Pratiche";
  if (pathname.startsWith("/chat")) return "Chat WhatsApp";
  if (pathname.startsWith("/calls")) return "Contatti / 3CX";
  if (pathname.startsWith("/reports/booking-activities")) return "Report Booking";
  if (pathname.startsWith("/analytics")) return "Report";
  if (pathname.startsWith("/users")) return "Gestione utenti";
  if (pathname.startsWith("/profile")) return "Profilo";
  if (pathname.startsWith("/change-password")) return "Cambio password";
  return "Dashboard";
}

export function AppLayout() {
  const { pathname } = useLocation();
  const user = getAuthUser();
  const title = getTitle(pathname);
  const isAdmin = user?.role === "admin" || user?.role === "super_admin";
  const menuItems = MENU.filter((item) =>
    item.to === "/users" || item.to === "/tasks" || item.to === "/reports/booking-activities" ? isAdmin : true
  );

  return (
    <ThreeCxProvider><div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-wordmark" src="/brand/crocieriamo.png" alt="Crocieriamo" />
          <div>
            <h1>Leadium</h1>
            <p>CRM Booking Team</p>
          </div>
        </div>
        <nav className="menu" aria-label="Navigazione principale">
          {menuItems.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                aria-label={item.label}
                title={item.label}
                className={({ isActive }) => `menu-item ${item.to === "/chat" ? "menu-tools-start" : ""} ${isActive ? "active" : ""}`}
              >
                <Icon className="menu-icon" size={18} strokeWidth={1.9} aria-hidden="true" />
                <span>{item.label}</span>
              </NavLink>
            );
          })}
        </nav>
        <div className="sidebar-signoff" aria-hidden="true">
          {/* Each path repeats every 224 units across a 448-wide viewBox, so sliding the SVG by half
              its width loops seamlessly. */}
          <svg className="sidebar-wave sidebar-wave-back" viewBox="0 0 448 90" preserveAspectRatio="none" fill="none">
            <path d="M0 46C37 26 75 26 112 46S187 66 224 46S299 26 336 46S411 66 448 46" stroke="#096094" strokeWidth="9" />
          </svg>
          <svg className="sidebar-wave sidebar-wave-front" viewBox="0 0 448 90" preserveAspectRatio="none" fill="none">
            <path d="M0 34C37 14 75 14 112 34S187 54 224 34S299 14 336 34S411 54 448 34" stroke="#0877ad" strokeWidth="22" />
          </svg>
        </div>
      </aside>

      <main className="main">
        <Header title={title} />

        <section className={`content ${pathname.startsWith("/chat") ? "chat-content" : ""}`}>
          <Outlet />
        </section>
      </main>
    </div></ThreeCxProvider>
  );
}
