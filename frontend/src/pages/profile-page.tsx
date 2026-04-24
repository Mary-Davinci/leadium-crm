import { getAuthUser } from "../lib/auth";
import "../styles/profile-page.css";

function roleLabel(role?: "super_admin" | "admin" | "operatore") {
  if (role === "super_admin") return "Super Admin";
  if (role === "admin") return "Admin";
  return "Operatore";
}

export function ProfilePage() {
  const user = getAuthUser();
  const rawName = String(user?.name || "").trim();
  const fallbackName = rawName || String(user?.username || "utente");
  const derivedName = rawName.split(" ").filter(Boolean);
  const firstName = derivedName[0] || fallbackName;
  const lastName = String(user?.surname || "").trim() || derivedName.slice(1).join(" ");
  const email = String(user?.email || "").trim() || "-";
  const username = String(user?.username || "").trim() || "-";

  return (
    <div className="profile-page">
      <h3 className="profile-page-title">Profilo</h3>
      <section className="panel profile-card">
        <div className="profile-top">
          <div className="profile-identity">
            <h4>{username}</h4>
            <p>{roleLabel(user?.role)}</p>
          </div>
         
        </div>

        <div className="profile-separator" />

        <div className="profile-section">
          <h5>Contatti</h5>
          <div className="profile-row">
            <span className="profile-mail-icon" aria-hidden="true" />
            <span>{email}</span>
          </div>
        </div>

        <div className="profile-separator" />

        <div className="profile-section">
          <h5>Informazioni Personali</h5>
          <div className="profile-personal">
            <div className="profile-personal-item">
              <span>Nome:</span>
              <strong>{firstName}</strong>
            </div>
            <div className="profile-personal-item">
              <span>Cognome:</span>
              <strong>{lastName || "-"}</strong>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
