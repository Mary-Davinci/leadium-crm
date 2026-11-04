import { GlobalSearch } from "./GlobalSearch";
import { NotificationsBell } from "./NotificationsBell";
import { UserMenu } from "./UserMenu";
import { WhatsappAlert } from "./WhatsappAlert";

export function Header({ title }: { title: string }) {
  return (
    <header className="topbar">
      <div className="topbar-left">
        <span className="topbar-eyebrow">Leadium</span>
        <h2 className="topbar-title">{title}</h2>
      </div>

      <div className="topbar-center">
        <GlobalSearch />
      </div>

      <div className="topbar-right">
        <WhatsappAlert />
        <NotificationsBell />
        <span className="topbar-divider" aria-hidden="true" />
        <UserMenu />
      </div>
    </header>
  );
}
