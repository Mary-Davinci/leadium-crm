import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../../lib/api";
import type { Lead } from "../pratiche.types";

export type Assignee = { id: string; username: string; name: string; surname: string };

function normalize(value?: string | null) {
  return String(value || "").trim().toLocaleLowerCase("it");
}

function displayName(user: Assignee) {
  return [user.name, user.surname].map((part) => String(part || "").trim()).filter(Boolean).join(" ") || user.username;
}

/** Display labels; the username is added only where two operators would otherwise look the same. */
export function assigneeLabels(users: Assignee[]) {
  const counts = new Map<string, number>();
  users.forEach((user) => counts.set(normalize(displayName(user)), (counts.get(normalize(displayName(user))) || 0) + 1));
  return new Map(users.map((user) => {
    const label = displayName(user);
    return [user.id, (counts.get(normalize(label)) || 0) > 1 ? `${label} (@${user.username})` : label];
  }));
}

/** The stored assignedTo is a username (older data may hold a name): find the operator it points to. */
export function findAssignee(users: Assignee[], assignedTo?: string | null) {
  const key = normalize(assignedTo);
  if (!key) return null;
  return users.find((user) => [user.username, user.name, displayName(user)].some((value) => normalize(value) === key)) || null;
}

type Props = {
  lead: Pick<Lead, "id" | "fullName" | "assignedTo">;
  onClose: () => void;
  onAssigned: (lead: Lead, label: string) => void;
};

export function AssignPracticeModal({ lead, onClose, onAssigned }: Props) {
  const [users, setUsers] = useState<Assignee[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  async function loadUsers() {
    setLoadError("");
    setUsers(null);
    try {
      setUsers(await api<Assignee[]>("/api/leads/assignees"));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Impossibile caricare gli operatori.");
    }
  }

  useEffect(() => {
    void loadUsers();
  }, []);

  // The search field is disabled while loading, so focus it once the operators are there
  // (keyboard users land inside the dialog, not on the page behind it).
  useEffect(() => {
    if (users !== null) searchRef.current?.focus();
    else dialogRef.current?.focus();
  }, [users]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [saving, onClose]);

  const labels = useMemo(() => assigneeLabels(users || []), [users]);
  const current = useMemo(() => findAssignee(users || [], lead.assignedTo), [users, lead.assignedTo]);
  const visible = useMemo(() => {
    const q = normalize(query);
    return (users || []).filter((user) => !q || [labels.get(user.id), user.username].some((value) => normalize(value).includes(q)));
  }, [users, labels, query]);
  const currentLabel = current
    ? labels.get(current.id)
    : lead.assignedTo
      ? `${lead.assignedTo} (non corrisponde a un operatore)`
      : "Nessuno";

  async function confirm() {
    if (!selectedId || saving) return;
    setSaving(true);
    setSaveError("");
    try {
      const updated = await api<Lead>(`/api/leads/${encodeURIComponent(lead.id)}/assign`, {
        method: "POST",
        body: JSON.stringify({ userId: selectedId })
      });
      onAssigned(updated, labels.get(selectedId) || updated.assignedTo || "");
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Assegnazione non riuscita.");
      setSaving(false);
    }
  }

  return (
    <div className="pr-call-modal-backdrop" role="presentation" onClick={() => (!saving ? onClose() : undefined)}>
      <div
        className="pr-call-modal panel pr-assign-modal"
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pr-assign-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="pr-call-modal-head">
          <div>
            <h3 id="pr-assign-title">Assegna pratica</h3>
            <p>{lead.fullName || "Pratica senza nome"}</p>
          </div>
        </div>

        <div className="pr-assign-current">
          <span>Assegnatario attuale</span>
          <strong>{users === null && !loadError ? "…" : currentLabel}</strong>
        </div>

        <div className="pr-call-modal-grid">
          <label>
            <span>Cerca operatore</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Nome, cognome o username"
              disabled={users === null || saving}
              ref={searchRef}
            />
          </label>
        </div>

        {loadError ? (
          <div className="pr-assign-state pr-assign-state-error" role="alert">
            <span>{loadError}</span>
            <button type="button" className="secondary" onClick={() => void loadUsers()}>
              Riprova
            </button>
          </div>
        ) : users === null ? (
          <p className="pr-assign-state" role="status">Caricamento operatori…</p>
        ) : !users.length ? (
          <p className="pr-assign-state" role="status">Nessun operatore disponibile: crea un utente con ruolo operatore dalla pagina Utenti.</p>
        ) : !visible.length ? (
          <p className="pr-assign-state" role="status">Nessun operatore corrisponde alla ricerca.</p>
        ) : (
          <div className="pr-assign-list" role="radiogroup" aria-label="Operatori assegnabili">
            {visible.map((user) => {
              const selected = user.id === selectedId;
              const isCurrent = current?.id === user.id;
              const label = labels.get(user.id) || user.username;
              // The username is already in the label for homonyms: do not repeat it underneath.
              const detail = [label.includes(`@${user.username}`) ? "" : `@${user.username}`, isCurrent ? "assegnatario attuale" : ""].filter(Boolean).join(" · ");
              return (
                <label key={user.id} className={`pr-assign-option${selected ? " is-selected" : ""}`}>
                  <input
                    type="radio"
                    name="pr-assignee"
                    value={user.id}
                    checked={selected}
                    disabled={saving}
                    onChange={() => setSelectedId(user.id)}
                  />
                  <span className="pr-assign-option-text">
                    <strong>{label}</strong>
                    {detail ? <small>{detail}</small> : null}
                  </span>
                </label>
              );
            })}
          </div>
        )}

        {saveError ? <p className="pr-error" role="alert">{saveError}</p> : null}

        <div className="pr-call-modal-actions">
          <button type="button" className="secondary" disabled={saving} onClick={onClose}>
            Annulla
          </button>
          <button
            type="button"
            className="primary"
            disabled={!selectedId || saving || selectedId === current?.id}
            onClick={() => void confirm()}
          >
            {saving ? "Assegnazione…" : "Conferma assegnazione"}
          </button>
        </div>
      </div>
    </div>
  );
}
