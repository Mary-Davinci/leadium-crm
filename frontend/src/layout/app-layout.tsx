import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { getAuthUser, logout } from "../lib/auth";
import "../styles/layout.css";

const MENU = [
  { to: "/dashboard", label: "Dashboard", icon: "🏠" },
  { to: "/tasks", label: "Task", icon: "🧾" },
  { to: "/pratiche", label: "Pratiche", icon: "🗂" },
  { to: "/chat", label: "Chat", icon: "💬" },
  { to: "/calls", label: "Chiamate", icon: "📞" },
  { to: "/analytics", label: "Report", icon: "📊" },
  { to: "/users", label: "Utenti", icon: "👥" }
];

function getTitle(pathname: string) {
  if (pathname.startsWith("/tasks") || pathname.startsWith("/leadboard")) return "Task";
  if (pathname.startsWith("/pratiche")) return "Pratiche";
  if (pathname.startsWith("/chat")) return "Chat WhatsApp";
  if (pathname.startsWith("/calls")) return "Contatti / 3CX";
  if (pathname.startsWith("/analytics")) return "Analytics";
  if (pathname.startsWith("/users")) return "Gestione Utenti";
  if (pathname.startsWith("/profile")) return "Profilo";
  if (pathname.startsWith("/change-password")) return "Cambio Password";
  return "Dashboard";
}

function getRoleLabel(role?: "super_admin" | "admin" | "operatore") {
  if (role === "super_admin") return "Super Admin";
  if (role === "admin") return "Amministratore";
  return "Operatore";
}

export function AppLayout() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const user = getAuthUser();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const title = getTitle(pathname);
  const roleLabel = getRoleLabel(user?.role);
  const menuItems = MENU.filter((item) =>
    item.to === "/users" ? user?.role === "admin" || user?.role === "super_admin" : true
  );

  async function handleLogout() {
    await logout();
    navigate("/login", { replace: true });
  }

  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (!menuRef.current) return;
      const target = event.target as Node;
      if (!menuRef.current.contains(target)) setMenuOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, []);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-logo">C</span>
          <div>
            <h1>Leadium</h1>
            <p>Crocieriamo Control</p>
          </div>
        </div>
        <nav className="menu">
          {menuItems.map((item) => (
            <NavLink key={item.to} to={item.to} className={({ isActive }) => `menu-item ${isActive ? "active" : ""}`}>
              <span className="menu-icon">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="main">
        <header className="topbar">
          <h2 className="topbar-title">{title}</h2>
          <div className="topbar-right">
            <span className="topbar-role-pill">{String(user?.role || "operatore").toUpperCase()}</span>
            <span className="topbar-bell-badge" aria-hidden="true">
              50
            </span>
            <div className={`topbar-user-wrap ${menuOpen ? "open" : ""}`} ref={menuRef}>
              <button type="button" className="topbar-user-banner" onClick={() => setMenuOpen((prev) => !prev)}>
                <span className="topbar-user-dot" aria-hidden="true" />
                <div className="topbar-user-icon" aria-hidden="true">
                  U
                </div>
                <div className="topbar-user-meta">
                  <strong>{user?.name || "Operatore"}</strong>
                  <span>{roleLabel}</span>
                </div>
              </button>
              <div className={`topbar-user-menu ${menuOpen ? "open" : ""}`}>
                <button
                  type="button"
                  className="topbar-user-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    navigate("/profile");
                  }}
                >
                  <span className="topbar-menu-icon">P</span> Profilo
                </button>
                <button
                  type="button"
                  className="topbar-user-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    navigate("/change-password");
                  }}
                >
                  <span className="topbar-menu-icon">S</span> Cambio Password
                </button>
                <button
                  type="button"
                  className="topbar-user-menu-item danger"
                  onClick={() => handleLogout().catch(() => navigate("/login"))}
                >
                  <span className="topbar-menu-icon">E</span> Esci
                </button>
              </div>
            </div>
          </div>
        </header>
        <section className="content">
          <Outlet />
        </section>
      </main>
    </div>
  );
}


