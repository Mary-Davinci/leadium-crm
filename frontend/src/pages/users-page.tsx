import { FormEvent, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { getAuthUser } from "../lib/auth";
import "../styles/users-page.css";

type UserItem = {
  id: string;
  username: string;
  name: string;
  role: "super_admin" | "admin" | "operatore";
  email?: string;
  surname?: string;
  organization?: string;
};

type CreateForm = {
  username: string;
  email: string;
  name: string;
  surname: string;
  role: "super_admin" | "admin" | "operatore";
  password: string;
  confirmPassword: string;
};

type UiAlert = {
  type: "success" | "error";
  message: string;
};

const INITIAL_CREATE_FORM: CreateForm = {
  username: "",
  email: "",
  name: "",
  surname: "",
  role: "operatore",
  password: "",
  confirmPassword: ""
};

export function UsersPage() {
  const authUser = getAuthUser();
  const isSuperAdmin = authUser?.role === "super_admin";
  const [users, setUsers] = useState<UserItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState<"list" | "create">("list");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [createForm, setCreateForm] = useState<CreateForm>(INITIAL_CREATE_FORM);
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [createMessage, setCreateMessage] = useState("");
  const [uiAlert, setUiAlert] = useState<UiAlert | null>(null);
  const [editingUsername, setEditingUsername] = useState<string | null>(null);
  const [deletingUser, setDeletingUser] = useState<UserItem | null>(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  function canDeleteTarget(user: UserItem) {
    if (!authUser) return false;
    if (user.username.toLowerCase() === authUser.username.toLowerCase()) return false;
    if (authUser.role === "super_admin") return true;
    if (authUser.role === "admin") return user.role === "operatore";
    return false;
  }

  useEffect(() => {
    if (!uiAlert) return;
    const t = setTimeout(() => setUiAlert(null), 4000);
    return () => clearTimeout(t);
  }, [uiAlert]);

  async function loadUsers() {
    setLoading(true);
    setError("");
    try {
      const payload = await api<UserItem[]>("/api/users");
      setUsers(payload);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Errore caricamento utenti");
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreateMessage("");
    if (!createForm.username.trim()) {
      setCreateMessage("Username obbligatorio.");
      setUiAlert({ type: "error", message: "Username obbligatorio." });
      return;
    }
    if (!createForm.email.trim()) {
      setCreateMessage("Email obbligatoria.");
      setUiAlert({ type: "error", message: "Email obbligatoria." });
      return;
    }
    const wantsPasswordUpdate = Boolean(createForm.password.trim() || createForm.confirmPassword.trim());

    if (!editingUsername) {
      if (!createForm.password.trim()) {
        setCreateMessage("Password obbligatoria.");
        setUiAlert({ type: "error", message: "Password obbligatoria." });
        return;
      }
      if (createForm.password.trim().length < 6) {
        setCreateMessage("Password minima 6 caratteri.");
        setUiAlert({ type: "error", message: "Password minima 6 caratteri." });
        return;
      }
      if (createForm.password !== createForm.confirmPassword) {
        setCreateMessage("Conferma password non valida.");
        setUiAlert({ type: "error", message: "Conferma password non valida." });
        return;
      }
    } else if (wantsPasswordUpdate) {
      if (!createForm.password.trim() || !createForm.confirmPassword.trim()) {
        setCreateMessage("Per aggiornare la password compila entrambi i campi.");
        setUiAlert({ type: "error", message: "Per aggiornare la password compila entrambi i campi." });
        return;
      }
      if (createForm.password.trim().length < 6) {
        setCreateMessage("Password minima 6 caratteri.");
        setUiAlert({ type: "error", message: "Password minima 6 caratteri." });
        return;
      }
      if (createForm.password !== createForm.confirmPassword) {
        setCreateMessage("Conferma password non valida.");
        setUiAlert({ type: "error", message: "Conferma password non valida." });
        return;
      }
    }

    setCreateSubmitting(true);
    try {
      const payload = {
        username: createForm.username.trim(),
        email: createForm.email.trim(),
        name: createForm.name.trim() || createForm.username.trim(),
        surname: createForm.surname.trim(),
        role: createForm.role,
        password: createForm.password
      };

      if (editingUsername) {
        const updatedUser = await api<UserItem>(`/api/users/${encodeURIComponent(editingUsername)}`, {
          method: "PUT",
          body: JSON.stringify({
            username: payload.username,
            email: payload.email,
            name: payload.name,
            surname: payload.surname,
            role: payload.role
          })
        });
        if (wantsPasswordUpdate) {
          await api<{ ok: boolean }>(`/api/users/${encodeURIComponent(updatedUser.username)}/reset-password`, {
            method: "POST",
            body: JSON.stringify({ password: createForm.password.trim() })
          });
        }
        setCreateMessage("Utente aggiornato correttamente.");
        setUiAlert({ type: "success", message: "Utente aggiornato correttamente." });
      } else {
        await api<UserItem>("/api/users", {
          method: "POST",
          body: JSON.stringify(payload)
        });
        setCreateMessage("Utente creato correttamente.");
        setUiAlert({ type: "success", message: "Utente creato correttamente." });
      }
      setCreateForm(INITIAL_CREATE_FORM);
      setEditingUsername(null);
      await loadUsers();
      setActiveTab("list");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Creazione utente non riuscita.";
      setCreateMessage(message);
      setUiAlert({ type: "error", message });
    } finally {
      setCreateSubmitting(false);
    }
  }

  async function handleDelete(username: string) {
    setDeleteSubmitting(true);
    setDeleteError("");
    try {
      await api(`/api/users/${encodeURIComponent(username)}`, { method: "DELETE" });
      setDeletingUser(null);
      setUiAlert({ type: "success", message: "Utente eliminato correttamente." });
      await loadUsers();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Eliminazione non riuscita.";
      setDeleteError(message);
      setUiAlert({ type: "error", message });
    } finally {
      setDeleteSubmitting(false);
    }
  }

  function startEdit(user: UserItem) {
    setEditingUsername(user.username);
    setCreateForm({
      username: user.username,
      email: user.email || user.username,
      name: user.name || "",
      surname: user.surname || "",
      role: user.role,
      password: "",
      confirmPassword: ""
    });
    setCreateMessage("");
    setActiveTab("create");
  }

  useEffect(() => {
    loadUsers().catch(() => undefined);
  }, []);

  useEffect(() => {
    setPage(1);
  }, [query]);

  const normalizedQuery = query.trim().toLowerCase();
  const filteredUsers = useMemo(
    () =>
      users
        .filter((user) => {
          if (!normalizedQuery) return true;
          const email = String(user.email || user.username).toLowerCase();
          return (
            user.username.toLowerCase().includes(normalizedQuery) ||
            user.name.toLowerCase().includes(normalizedQuery) ||
            user.role.toLowerCase().includes(normalizedQuery) ||
            email.includes(normalizedQuery)
          );
        })
        .sort((left, right) => left.name.localeCompare(right.name, "it", { sensitivity: "base" })),
    [users, normalizedQuery]
  );

  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(filteredUsers.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const paginatedUsers = filteredUsers.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  return (
    <div className="users-page">
      <section className="panel users-shell">
        <header className="users-header">
          <h3>Utenti</h3>
          <span className="users-role-pill">
            Il tuo ruolo: {authUser?.role === "super_admin" ? "Super Admin" : authUser?.role === "admin" ? "Amministratore" : "Operatore"}
          </span>
        </header>

        <div className="users-tabs">
          <button type="button" className={`users-tab ${activeTab === "list" ? "active" : ""}`} onClick={() => setActiveTab("list")}>
            <span className="users-tab-icon users-tab-icon-list" aria-hidden="true" />
            Elenco
          </button>
          <button type="button" className={`users-tab ${activeTab === "create" ? "active" : ""}`} onClick={() => setActiveTab("create")}>
            <span className="users-tab-icon users-tab-icon-edit" aria-hidden="true" />
            Crea
          </button>
        </div>

        {uiAlert ? (
          <div className={`users-alert users-alert-${uiAlert.type}`} role="alert">
            {uiAlert.message}
          </div>
        ) : null}

        {activeTab === "list" ? (
          <div className="users-list">
            <div className="users-toolbar">
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Cerca utenti..." aria-label="Cerca utenti" />
            </div>
            {loading ? <p className="muted">Caricamento...</p> : null}
            {error ? <p className="muted">{error}</p> : null}

            <div className="users-table-wrap">
              <table className="table users-table">
                <thead>
                  <tr>
                    <th>Ruolo</th>
                    <th>Nominativo</th>
                    <th>Email</th>
                    <th>Status</th>
                    <th>Approvazione</th>
                    <th>Azioni</th>
                  </tr>
                </thead>
                <tbody>
                  {paginatedUsers.map((user) => (
                    <tr key={user.id}>
                      <td>
                        <span className={`users-chip users-chip-role ${user.role}`}>
                          {user.role === "super_admin" ? "SUPER ADMIN" : user.role === "admin" ? "AMMINISTRATORE" : "OPERATORE"}
                        </span>
                      </td>
                      <td>{user.name}</td>
                      <td>{user.email || user.username}</td>
                      <td><span className="users-chip users-chip-status">Attivo</span></td>
                      <td><span className="users-chip users-chip-approved">Approvato</span></td>
                      <td>
                        <div className="users-actions">
                          <button
                            type="button"
                            className="editBtn"
                            title="Modifica utente"
                            onClick={() => startEdit(user)}
                          >
                            <svg viewBox="0 0 512 512" aria-hidden="true" focusable="false">
                              <path d="M410.3 231l11.3-11.3c18.8-18.8 18.8-49.1 0-67.9l-61.4-61.4c-18.8-18.8-49.1-18.8-67.9 0L281 101.7 410.3 231zM63.6 337.1L32 480l142.9-31.6L386.1 237.2 274.8 125.9 63.6 337.1z" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            className="bin-button"
                            title="Elimina utente"
                            onClick={() => setDeletingUser(user)}
                            disabled={!canDeleteTarget(user)}
                          >
                            <svg className="bin-top" viewBox="0 0 39 7" aria-hidden="true" focusable="false">
                              <path
                                d="M4 0h31c1.1 0 2 .9 2 2v1c0 1.1-.9 2-2 2H4C2.9 5 2 4.1 2 3V2c0-1.1.9-2 2-2z"
                                fill="white"
                              />
                            </svg>
                            <svg className="bin-bottom" viewBox="0 0 33 39" aria-hidden="true" focusable="false">
                              <path
                                d="M4 6h25l-2.2 29.3c-.1 1.6-1.4 2.7-3 2.7H9.2c-1.6 0-2.9-1.2-3-2.7L4 6z"
                                fill="white"
                              />
                            </svg>
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {!paginatedUsers.length ? (
                    <tr>
                      <td colSpan={6}>Nessun utente disponibile.</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>

            <div className="users-pagination">
              <span>Pagina {currentPage} di {totalPages} - {filteredUsers.length} utenti</span>
              <div className="users-pagination-actions">
                <button type="button" disabled={currentPage <= 1} onClick={() => setPage((prev) => Math.max(1, prev - 1))}>
                  Indietro
                </button>
                <button type="button" disabled={currentPage >= totalPages} onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}>
                  Avanti
                </button>
              </div>
            </div>
          </div>
        ) : (
          <form className="users-create-card" onSubmit={handleCreateUser}>
            <h4>{editingUsername ? "Modifica Utente" : "Nuovo Utente"}</h4>
            <div className="users-create-grid">
              <label className="users-field">
                Username*
                <input value={createForm.username} onChange={(e) => setCreateForm((prev) => ({ ...prev, username: e.target.value }))} required />
              </label>
              <label className="users-field">
                Email*
                <input type="email" value={createForm.email} onChange={(e) => setCreateForm((prev) => ({ ...prev, email: e.target.value }))} required />
              </label>
              <label className="users-field">
                Nome
                <input value={createForm.name} onChange={(e) => setCreateForm((prev) => ({ ...prev, name: e.target.value }))} />
              </label>
              <label className="users-field">
                Cognome
                <input value={createForm.surname} onChange={(e) => setCreateForm((prev) => ({ ...prev, surname: e.target.value }))} />
              </label>
              <div className="users-field-spacer" aria-hidden="true" />
              <label className="users-field users-field-role">
                Ruolo*
                <select
                  value={createForm.role}
                  onChange={(e) =>
                    setCreateForm((prev) => ({ ...prev, role: e.target.value as "super_admin" | "admin" | "operatore" }))
                  }
                >
                  <option value="operatore">Operatore</option>
                  <option value="admin">Amministratore</option>
                  {isSuperAdmin ? <option value="super_admin">Super Admin</option> : null}
                </select>
                <small>Puoi creare solo utenti con ruoli inferiori al tuo.</small>
              </label>
              <label className="users-field">
                Password*
                <input
                  type="password"
                  value={createForm.password}
                  onChange={(e) => setCreateForm((prev) => ({ ...prev, password: e.target.value }))}
                  required={!editingUsername}
                />
              </label>
              <label className="users-field">
                Conferma Password*
                <input
                  type="password"
                  value={createForm.confirmPassword}
                  onChange={(e) => setCreateForm((prev) => ({ ...prev, confirmPassword: e.target.value }))}
                  required={!editingUsername}
                />
              </label>
              <div className="users-field-spacer" aria-hidden="true" />
            </div>
            {createMessage ? <p className="muted">{createMessage}</p> : null}
            <div className="users-create-actions">
              <button
                type="button"
                className="users-cancel-btn"
                onClick={() => {
                  setCreateForm(INITIAL_CREATE_FORM);
                  setEditingUsername(null);
                }}
              >
                Annulla
              </button>
              <button type="submit" className="users-create-btn" disabled={createSubmitting}>
                {createSubmitting ? (editingUsername ? "Salvataggio..." : "Creazione...") : editingUsername ? "Salva Utente" : "Crea Utente"}
              </button>
            </div>
          </form>
        )}
      </section>

      {deletingUser ? (
        <div className="users-modal-backdrop">
          <div className="users-modal panel">
            <h3>Conferma eliminazione</h3>
            <p>Vuoi eliminare l'utente <strong>{deletingUser.name}</strong> ({deletingUser.username})?</p>
            {deleteError ? <p className="muted users-delete-error">{deleteError}</p> : null}
            <div className="users-modal-actions">
              <button
                type="button"
                className="users-cancel-btn"
                onClick={() => {
                  if (deleteSubmitting) return;
                  setDeleteError("");
                  setDeletingUser(null);
                }}
              >
                Annulla
              </button>
              <button type="button" className="users-danger-btn" onClick={() => handleDelete(deletingUser.username).catch(() => undefined)} disabled={deleteSubmitting}>
                {deleteSubmitting ? "Elimino..." : "Elimina"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
