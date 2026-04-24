import { FormEvent, useState } from "react";
import { api } from "../lib/api";
import { getAuthUser } from "../lib/auth";
import "../styles/change-password-page.css";

type ChangePasswordResponse = {
  ok: boolean;
};

export function ChangePasswordPage() {
  const user = getAuthUser();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const passwordChecks = [
    { label: "Almeno 8 caratteri", valid: newPassword.length >= 8 },
    { label: "Almeno una lettera maiuscola", valid: /[A-Z]/.test(newPassword) },
    { label: "Almeno una lettera minuscola", valid: /[a-z]/.test(newPassword) },
    { label: "Almeno un numero", valid: /\d/.test(newPassword) },
    { label: "Almeno un carattere speciale (es. !@#$%)", valid: /[^A-Za-z0-9]/.test(newPassword) }
  ];
  const strengthScore = passwordChecks.filter((item) => item.valid).length;
  const strengthLabel =
    strengthScore <= 1 ? "Molto debole" : strengthScore === 2 ? "Debole" : strengthScore === 3 ? "Media" : strengthScore === 4 ? "Buona" : "Forte";
  const allRequirementsMet = passwordChecks.every((item) => item.valid);
  const canSubmit =
    !submitting &&
    currentPassword.trim().length > 0 &&
    newPassword.trim().length > 0 &&
    confirmPassword.trim().length > 0 &&
    newPassword === confirmPassword &&
    allRequirementsMet;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    if (!currentPassword.trim() || !newPassword.trim() || !confirmPassword.trim()) {
      setMessage({ type: "error", text: "Compila tutti i campi." });
      return;
    }
    if (newPassword.trim().length < 8) {
      setMessage({ type: "error", text: "La nuova password deve avere almeno 8 caratteri." });
      return;
    }
    if (newPassword !== confirmPassword) {
      setMessage({ type: "error", text: "Conferma password non valida." });
      return;
    }

    setSubmitting(true);
    try {
      await api<ChangePasswordResponse>("/api/auth/change-password", {
        method: "POST",
        body: JSON.stringify({
          currentPassword: currentPassword.trim(),
          newPassword: newPassword.trim()
        })
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setMessage({ type: "success", text: "Password aggiornata con successo." });
    } catch (error) {
      const text = error instanceof Error ? error.message : "Errore durante il cambio password.";
      setMessage({ type: "error", text });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="change-password-page">
      <h3 className="change-password-title">Cambio Password</h3>
      <section className="panel change-password-card">
        <div className="change-password-user">
          <span className="change-password-avatar">U</span>
          <div>
            <strong>{user?.name || "Utente"}</strong>
            <span>{user?.email || "-"}</span>
          </div>
        </div>

        <div className="change-password-divider" />

        <form className="change-password-form" onSubmit={handleSubmit}>
          <label>
            Password attuale
            <input
              type="password"
              placeholder="Inserisci la password attuale"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              autoComplete="current-password"
            />
          </label>
          <label>
            Nuova password
            <input
              type="password"
              placeholder="Inserisci la nuova password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              autoComplete="new-password"
            />
          </label>
          <div className="change-password-strength">
            <span>Sicurezza:</span>
            <div className="change-password-strength-bars">
              {Array.from({ length: 5 }).map((_, index) => (
                <span key={index} className={index < strengthScore ? "active" : ""} />
              ))}
            </div>
            <strong>{strengthLabel}</strong>
          </div>
          <label>
            Conferma nuova password
            <input
              type="password"
              placeholder="Conferma la nuova password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              autoComplete="new-password"
            />
          </label>

          <div className="change-password-rules">
            <h4>Requisiti Password:</h4>
            <ul>
              {passwordChecks.map((item) => (
                <li key={item.label} className={item.valid ? "ok" : ""}>
                  {item.label}
                </li>
              ))}
            </ul>
          </div>

          {message ? <div className={`change-password-alert ${message.type}`}>{message.text}</div> : null}
          <div className="change-password-actions">
            <button
              type="button"
              className="change-password-cancel"
              onClick={() => {
                setCurrentPassword("");
                setNewPassword("");
                setConfirmPassword("");
                setMessage(null);
              }}
              disabled={submitting}
            >
              Annulla
            </button>
            <button type="submit" className="change-password-submit" disabled={!canSubmit}>
              {submitting ? "Aggiorno..." : "Cambia Password"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
