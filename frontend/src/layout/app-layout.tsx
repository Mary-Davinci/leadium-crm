import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  BarChart3,
  ChevronDown,
  KeyRound,
  LayoutDashboard,
  LogOut,
  MessageCircle,
  Phone,
  ShipWheel,
  UserRound,
  UsersRound,
  Workflow,
  FolderKanban,
  type LucideIcon
} from "lucide-react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { getAuthUser, logout } from "../lib/auth";
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
  { to: "/users", label: "Utenti", icon: UsersRound }
];

function getTitle(pathname: string) {
  if (pathname.startsWith("/tasks/import")) return "Importa lead";
  if (pathname.startsWith("/tasks") || pathname.startsWith("/leadboard")) return "Gestione operativa";
  if (pathname.startsWith("/pratiche")) return "Pratiche";
  if (pathname.startsWith("/chat")) return "Chat WhatsApp";
  if (pathname.startsWith("/calls")) return "Contatti / 3CX";
  if (pathname.startsWith("/analytics")) return "Report";
  if (pathname.startsWith("/users")) return "Gestione utenti";
  if (pathname.startsWith("/profile")) return "Profilo";
  if (pathname.startsWith("/change-password")) return "Cambio password";
  return "Dashboard";
}

function getRoleLabel(role?: "super_admin" | "admin" | "operatore") {
  if (role === "super_admin") return "Super Admin";
  if (role === "admin") return "Amministratore";
  return "Operatore";
}

function getUserInitials(name?: string, surname?: string) {
  const initials = `${String(name || "").trim().charAt(0)}${String(surname || "").trim().charAt(0)}`.toUpperCase();
  return initials || "OP";
}

export function AppLayout() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const user = getAuthUser();
  const title = getTitle(pathname);
  const roleLabel = getRoleLabel(user?.role);
  const isAdmin = user?.role === "admin" || user?.role === "super_admin";
  const menuItems = MENU.filter((item) => (item.to === "/users" || item.to === "/tasks" ? isAdmin : true));

  async function handleLogout() {
    await logout();
    navigate("/login", { replace: true });
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-logo" aria-hidden="true">
            <ShipWheel size={21} strokeWidth={2.2} />
          </span>
          <div>
            <h1>Leadium</h1>
            <p>Crocieriamo Control</p>
          </div>
        </div>
        <nav className="menu" aria-label="Navigazione principale">
          {menuItems.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) => `menu-item ${isActive ? "active" : ""}`}
              >
                <Icon className="menu-icon" size={18} strokeWidth={1.9} aria-hidden="true" />
                <span>{item.label}</span>
              </NavLink>
            );
          })}
        </nav>
      </aside>

      <main className="main">
        <header className="topbar">
          <h2 className="topbar-title">{title}</h2>

          <div className="topbar-right">
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button type="button" className="topbar-user-banner" aria-label="Apri menu profilo">
                  <span className="topbar-user-dot" aria-hidden="true" />
                  <span className="topbar-user-icon" aria-hidden="true">
                    {getUserInitials(user?.name, user?.surname)}
                  </span>
                  <span className="topbar-user-meta">
                    <strong>{user?.name || "Operatore"}</strong>
                    <span>{roleLabel}</span>
                  </span>
                  <ChevronDown className="topbar-user-chevron" size={16} aria-hidden="true" />
                </button>
              </DropdownMenu.Trigger>

              <DropdownMenu.Portal>
                <DropdownMenu.Content className="topbar-user-menu" align="end" sideOffset={8}>
                  <DropdownMenu.Label className="topbar-user-menu-label">Account</DropdownMenu.Label>
                  <DropdownMenu.Item className="topbar-user-menu-item" onSelect={() => navigate("/profile")}>
                    <UserRound className="topbar-menu-icon" size={17} aria-hidden="true" />
                    Profilo
                  </DropdownMenu.Item>
                  <DropdownMenu.Item className="topbar-user-menu-item" onSelect={() => navigate("/change-password")}>
                    <KeyRound className="topbar-menu-icon" size={17} aria-hidden="true" />
                    Cambio password
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator className="topbar-user-menu-separator" />
                  <DropdownMenu.Item
                    className="topbar-user-menu-item danger"
                    onSelect={() => handleLogout().catch(() => navigate("/login"))}
                  >
                    <LogOut className="topbar-menu-icon" size={17} aria-hidden="true" />
                    Esci
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </header>

        <section className={`content ${pathname.startsWith("/chat") ? "chat-content" : ""}`}>
          <Outlet />
        </section>
      </main>
    </div>
  );
}
