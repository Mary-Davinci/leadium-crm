import { useEffect, useState } from "react";
import { BarChart3, ClipboardList, LayoutDashboard, Mail, MessageCircle, Phone, UsersRound, Workflow, FolderKanban, type LucideIcon } from "lucide-react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { api } from "../lib/api";
import { getAuthUser } from "../lib/auth";
import { Header } from "./Header";
import { ScheduledCallsAlert } from "../features/calls/ScheduledCallsAlert";
import { MAIL_READ_EVENT } from "../features/email/email.logic";
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
  { to: "/email", label: "Email", icon: Mail },
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
  if (pathname.startsWith("/email")) return "Email clienti";
  if (pathname.startsWith("/calls")) return "Contatti / 3CX";
  if (pathname.startsWith("/reports/booking-activities")) return "Report Booking";
  if (pathname.startsWith("/analytics")) return "Report";
  if (pathname.startsWith("/users")) return "Gestione utenti";
  if (pathname.startsWith("/profile")) return "Profilo";
  if (pathname.startsWith("/change-password")) return "Cambio password";
  return "Dashboard";
}

function useUnreadMail(pathname: string) {
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    const load = () => api<{ unread: number }>("/api/mail/unread").then((data) => setUnread(Number(data.unread) || 0)).catch(() => undefined);
    void load();
    const timer = window.setInterval(load, 60000);
    window.addEventListener(MAIL_READ_EVENT, load);
    return () => { window.clearInterval(timer); window.removeEventListener(MAIL_READ_EVENT, load); };
  }, [pathname]);
  return unread;
}

export function AppLayout() {
  const { pathname } = useLocation();
  const user = getAuthUser();
  const title = getTitle(pathname);
  const isAdmin = user?.role === "admin" || user?.role === "super_admin";
  const unreadMail = useUnreadMail(pathname);
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
                {item.to === "/email" && unreadMail ? <span className="menu-badge" aria-label={`${unreadMail} email da leggere`}>{unreadMail > 99 ? "99+" : unreadMail}</span> : null}
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
        <ScheduledCallsAlert />

        <section className={`content ${pathname.startsWith("/chat") ? "chat-content" : ""}`}>
          <Outlet />
        </section>
      </main>
    </div></ThreeCxProvider>
  );
}
