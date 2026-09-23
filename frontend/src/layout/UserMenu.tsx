import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDown, KeyRound, LogOut, UserRound } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { getAuthUser, logout } from "../lib/auth";

function getRoleLabel(role?: "super_admin" | "admin" | "operatore") {
  if (role === "super_admin") return "Super Admin";
  if (role === "admin") return "Amministratore";
  return "Operatore";
}

function getUserInitials(name?: string, surname?: string) {
  const initials = `${String(name || "").trim().charAt(0)}${String(surname || "").trim().charAt(0)}`.toUpperCase();
  return initials || "OP";
}

export function UserMenu() {
  const navigate = useNavigate();
  const user = getAuthUser();
  const roleLabel = getRoleLabel(user?.role);

  async function handleLogout() {
    await logout();
    navigate("/login", { replace: true });
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="umenu-trigger" aria-label="Apri menu profilo">
          <span className="umenu-avatar" aria-hidden="true">
            {getUserInitials(user?.name, user?.surname)}
            <span className="umenu-status" aria-hidden="true" />
          </span>
          <span className="umenu-meta">
            <strong>{user?.name || "Operatore"}</strong>
            <span>{roleLabel}</span>
          </span>
          <ChevronDown className="umenu-chevron" size={15} aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content className="umenu-content" align="end" sideOffset={10}>
          <DropdownMenu.Group>
            <DropdownMenu.Label className="umenu-label">Account</DropdownMenu.Label>
            <DropdownMenu.Item className="umenu-item" onSelect={() => navigate("/profile")}>
              <UserRound className="umenu-item-icon" size={16} aria-hidden="true" />
              Profilo
            </DropdownMenu.Item>
            <DropdownMenu.Item className="umenu-item" onSelect={() => navigate("/change-password")}>
              <KeyRound className="umenu-item-icon" size={16} aria-hidden="true" />
              Cambia password
            </DropdownMenu.Item>
          </DropdownMenu.Group>
          <DropdownMenu.Separator className="umenu-separator" />
          <DropdownMenu.Item className="umenu-item danger" onSelect={() => handleLogout().catch(() => navigate("/login"))}>
            <LogOut className="umenu-item-icon" size={16} aria-hidden="true" />
            Esci
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
