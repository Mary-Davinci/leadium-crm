import { memo, useState, type FormEvent } from "react";
import { MessageSquarePlus, Search, X } from "lucide-react";
import { formatListTimestamp, getAvatarLabel, getConversationStatusLabel } from "../chat.logic";
import type { Conversation, InboxFilter } from "../chat.types";

export type ConversationRow = Conversation & {
  operational: { pendingPaymentCount: number; missingDocumentCount: number };
};

type ConversationListProps = {
  rows: ConversationRow[];
  counts: Record<InboxFilter, number>;
  filter: InboxFilter;
  search: string;
  selectedId: string | null;
  authUsername: string;
  loading: boolean;
  error: string;
  onFilterChange: (filter: InboxFilter) => void;
  onSearchChange: (value: string) => void;
  onSelect: (conversationId: string) => void;
  onRetry: () => void;
  /** Opens (or creates) the conversation for a typed number; resolves to an error message or "". */
  onStartChat: (phone: string, customerName: string) => Promise<string>;
};

const FILTERS: Array<{ key: InboxFilter; label: string }> = [
  { key: "all", label: "Tutte" },
  { key: "unread", label: "Non lette" },
  { key: "mine", label: "In carico" },
  { key: "unassigned", label: "Da assegnare" },
  { key: "waiting", label: "In attesa" },
  { key: "resolved", label: "Risolte" }
];

const EMPTY_BY_FILTER: Record<InboxFilter, string> = {
  all: "Nessuna conversazione WhatsApp.",
  unread: "Nessuna conversazione da leggere.",
  mine: "Nessuna conversazione assegnata a te.",
  unassigned: "Tutte le conversazioni hanno un operatore.",
  waiting: "Nessuna conversazione in attesa del cliente.",
  resolved: "Nessuna conversazione risolta."
};

function getAssigneeLabel(assignedTo: string | undefined, authUsername: string) {
  const assignee = String(assignedTo || "").trim();
  if (!assignee) return { label: "Da assegnare", tone: "unassigned" };
  if (assignee === authUsername) return { label: "Tu", tone: "mine" };
  return { label: assignee, tone: "other" };
}

const ConversationListItem = memo(function ConversationListItem({
  row,
  active,
  authUsername,
  onSelect
}: {
  row: ConversationRow;
  active: boolean;
  authUsername: string;
  onSelect: (conversationId: string) => void;
}) {
  const unread = Number(row.unreadCount || 0);
  const name = row.customerName || row.phone || "Contatto";
  const assignee = getAssigneeLabel(row.assignedTo, authUsername);
  const { pendingPaymentCount, missingDocumentCount } = row.operational;

  return (
    <li>
      <button
        type="button"
        className={`chat-conv ${active ? "active" : ""} ${unread ? "unread" : ""}`}
        onClick={() => onSelect(row.id)}
        aria-current={active ? "true" : undefined}
      >
        <span className="chat-avatar" aria-hidden="true">
          {getAvatarLabel(row.customerName, row.phone)}
        </span>
        <span className="chat-conv-body">
          <span className="chat-conv-line">
            <strong className="chat-conv-name">{name}</strong>
            <time className="chat-conv-time" dateTime={row.lastMessageAt || undefined}>
              {formatListTimestamp(row.lastMessageAt)}
            </time>
          </span>
          <span className="chat-conv-line">
            <span className="chat-conv-preview">{row.lastMessagePreview || "Nessun messaggio"}</span>
            {unread ? (
              <span className="chat-unread-badge" aria-label={`${unread} messaggi non letti`}>
                {unread > 99 ? "99+" : unread}
              </span>
            ) : null}
          </span>
          <span className="chat-conv-tags">
            <span className={`chat-tag assignee ${assignee.tone}`}>{assignee.label}</span>
            {row.status && row.status !== "open" ? (
              <span className={`chat-tag status ${row.status}`}>{getConversationStatusLabel(row.status)}</span>
            ) : null}
            {pendingPaymentCount ? <span className="chat-tag warn">{pendingPaymentCount} pag.</span> : null}
            {missingDocumentCount ? <span className="chat-tag warn">{missingDocumentCount} doc</span> : null}
          </span>
        </span>
      </button>
    </li>
  );
});

export function ConversationList({
  rows,
  counts,
  filter,
  search,
  selectedId,
  authUsername,
  loading,
  error,
  onFilterChange,
  onSearchChange,
  onSelect,
  onRetry,
  onStartChat
}: ConversationListProps) {
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [newChatPhone, setNewChatPhone] = useState("");
  const [newChatName, setNewChatName] = useState("");
  const [newChatError, setNewChatError] = useState("");
  const [newChatBusy, setNewChatBusy] = useState(false);

  function closeNewChat() {
    setNewChatOpen(false);
    setNewChatPhone("");
    setNewChatName("");
    setNewChatError("");
  }

  async function submitNewChat(event: FormEvent) {
    event.preventDefault();
    if (newChatBusy) return;
    setNewChatBusy(true);
    setNewChatError("");
    const error = await onStartChat(newChatPhone, newChatName.trim());
    setNewChatBusy(false);
    if (error) setNewChatError(error);
    else closeNewChat();
  }

  return (
    <div className="chat-list">
      <header className="chat-list-head">
        <h2>Chat</h2>
        <span className="chat-channel">WhatsApp</span>
        <button
          type="button"
          className="chat-secondary-button small chat-new-chat-toggle"
          aria-expanded={newChatOpen}
          aria-controls="chat-new-chat-form"
          onClick={() => (newChatOpen ? closeNewChat() : setNewChatOpen(true))}
        >
          <MessageSquarePlus size={14} aria-hidden="true" />
          Nuova chat
        </button>
      </header>
      {newChatOpen ? (
        <form id="chat-new-chat-form" className="chat-new-chat" onSubmit={submitNewChat} aria-label="Nuova chat WhatsApp">
          <label>
            <span>Numero</span>
            <input
              type="tel"
              inputMode="tel"
              autoComplete="off"
              autoFocus
              value={newChatPhone}
              onChange={(event) => setNewChatPhone(event.target.value)}
              placeholder="+39 333 1234567"
              required
            />
          </label>
          <label>
            <span>Nome (facoltativo)</span>
            <input
              type="text"
              autoComplete="off"
              value={newChatName}
              onChange={(event) => setNewChatName(event.target.value)}
              placeholder="Nome e cognome"
            />
          </label>
          <p className="chat-new-chat-hint">Il primo messaggio deve essere un template approvato: dopo l'apertura scegli il template e invia.</p>
          {newChatError ? (
            <p className="chat-new-chat-error" role="alert">
              {newChatError}
            </p>
          ) : null}
          <div className="chat-new-chat-actions">
            <button type="button" className="chat-secondary-button small" onClick={closeNewChat}>
              Annulla
            </button>
            <button type="submit" className="chat-primary-button small" disabled={newChatBusy || !newChatPhone.trim()}>
              {newChatBusy ? "Apertura..." : "Apri chat"}
            </button>
          </div>
        </form>
      ) : null}
      <div className="chat-search">
        <Search size={15} aria-hidden="true" />
        <input
          type="search"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Cerca nome, numero o messaggio"
          aria-label="Cerca conversazioni"
        />
        {search ? (
          <button type="button" className="chat-search-clear" onClick={() => onSearchChange("")} aria-label="Cancella ricerca">
            <X size={14} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <div className="chat-filters" role="tablist" aria-label="Filtra conversazioni">
        {FILTERS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={filter === item.key}
            className={filter === item.key ? "active" : ""}
            onClick={() => onFilterChange(item.key)}
          >
            {item.label}
            {item.key !== "all" && counts[item.key] ? <span>{counts[item.key]}</span> : null}
          </button>
        ))}
      </div>
      {error ? (
        <div className="chat-inline-alert error" role="alert">
          <span>{error}</span>
          <button type="button" className="chat-link-button" onClick={onRetry}>
            Riprova
          </button>
        </div>
      ) : null}
      <ul className="chat-conv-list" aria-label="Conversazioni" aria-busy={loading}>
        {loading && !rows.length
          ? Array.from({ length: 6 }, (_, index) => (
              <li key={index} className="chat-conv-skeleton" aria-hidden="true">
                <span className="chat-skeleton avatar" />
                <span className="chat-skeleton-lines">
                  <span className="chat-skeleton line" />
                  <span className="chat-skeleton line short" />
                </span>
              </li>
            ))
          : rows.map((row) => (
              <ConversationListItem key={row.id} row={row} active={row.id === selectedId} authUsername={authUsername} onSelect={onSelect} />
            ))}
        {!loading && !rows.length ? (
          <li className="chat-list-empty">{search.trim() ? `Nessun risultato per "${search.trim()}".` : EMPTY_BY_FILTER[filter]}</li>
        ) : null}
      </ul>
    </div>
  );
}
