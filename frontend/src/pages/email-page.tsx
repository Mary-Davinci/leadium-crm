import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLink, Mail, Paperclip, Search, Send } from "lucide-react";
import { Link } from "react-router-dom";
import { buildPracticeUrl } from "../features/practices/practice-links";
import { formatAttachmentSize, formatMailTime, groupThreads, lastInbound, replySubject, type MailMessage, type MailThread } from "../features/email/email.logic";
import { api } from "../lib/api";
import { getAuthUser } from "../lib/auth";
import "../styles/email-page.css";

type MailData = { configured: boolean; lastSyncAt: string | null; lastError: string | null; messages: MailMessage[] };
type LeadOption = { id: string; fullName?: string; email?: string; phone?: string };

const POLL_MS = 30000;

export function EmailPage() {
  const user = getAuthUser();
  const isAdmin = user?.role === "admin" || user?.role === "super_admin";
  const [data, setData] = useState<MailData | null>(null);
  const [error, setError] = useState("");
  const [selectedKey, setSelectedKey] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await api<MailData>("/api/mail/messages"));
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Impossibile leggere le email.");
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const threads = useMemo(() => groupThreads(data?.messages || []), [data]);
  const selected = threads.find((thread) => thread.key === selectedKey) || null;

  // Opening a conversation reads its new emails.
  useEffect(() => {
    if (!selected?.unread) return;
    const unread = selected.messages.filter((message) => message.direction === "inbound" && !message.readAt);
    void Promise.all(unread.map((message) => api(`/api/mail/messages/${encodeURIComponent(message.id)}`, { method: "PATCH", body: JSON.stringify({ read: true }) })))
      .then(() => load())
      .catch(() => undefined);
  }, [selected?.key, selected?.unread, load]);

  return (
    <div className={`email-shell${selected ? " has-selection" : ""}`}>
      <aside className="email-list" aria-label="Conversazioni email">
        <header className="email-list-head">
          <h2>Email clienti</h2>
          {data?.lastSyncAt ? <small>Aggiornata alle {formatMailTime(data.lastSyncAt).split(", ")[1]}</small> : null}
        </header>
        {error ? <p className="email-notice is-error" role="alert">{error}</p> : null}
        {data && !data.configured ? <p className="email-notice">Casella non collegata: un amministratore deve configurare la posta.</p> : null}
        {data?.lastError ? <p className="email-notice is-error" role="alert">{data.lastError}</p> : null}
        {data && !threads.length && !error ? <p className="email-empty">Nessuna email dei tuoi clienti.</p> : null}
        <ul>
          {threads.map((thread) => (
            <li key={thread.key}>
              <button type="button" className={`email-row${thread.key === selectedKey ? " is-selected" : ""}${thread.unread ? " is-unread" : ""}`} onClick={() => setSelectedKey(thread.key)}>
                <span className="email-row-top"><strong>{thread.title}</strong><time>{formatMailTime(thread.lastAt)}</time></span>
                <span className="email-row-subject">{thread.subject || "(senza oggetto)"}</span>
                {thread.leadId ? null : <span className="email-tag">Da collegare a una pratica</span>}
                {thread.unread ? <span className="email-unread" aria-label={`${thread.unread} da leggere`}>{thread.unread}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <section className="email-thread" aria-label="Conversazione">
        {selected ? <Thread key={selected.key} thread={selected} isAdmin={isAdmin} onBack={() => setSelectedKey("")} onChanged={load} /> : (
          <div className="email-placeholder"><Mail size={26} aria-hidden="true" /><p>Scegli una conversazione per leggerla e rispondere.</p></div>
        )}
      </section>
    </div>
  );
}

function Thread({ thread, isAdmin, onBack, onChanged }: { thread: MailThread; isAdmin: boolean; onBack(): void; onChanged(): Promise<void> }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const answered = lastInbound(thread);

  async function send() {
    if (!thread.leadId || !text.trim()) return;
    setBusy(true);
    setNotice("");
    try {
      await api(`/api/leads/${encodeURIComponent(thread.leadId)}/email`, {
        method: "POST",
        body: JSON.stringify({ subject: replySubject(answered?.subject || thread.subject), text, ...(answered ? { replyToMailId: answered.id } : {}) })
      });
      setText("");
      await onChanged();
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "Invio non riuscito.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header className="email-thread-head">
        <button type="button" className="email-back" onClick={onBack}>Conversazioni</button>
        <div>
          <h3>{thread.title}</h3>
          <p>{thread.from}</p>
        </div>
        {thread.leadId ? <Link className="email-practice" to={buildPracticeUrl(thread.leadId)}><ExternalLink size={14} aria-hidden="true" />Apri pratica</Link> : null}
      </header>
      <div className="email-messages">
        {thread.messages.map((message) => (
          <article key={message.id} className={`email-message is-${message.direction}`}>
            <header>
              <strong>{message.direction === "inbound" ? message.fromName || message.from : `Inviata da ${message.sentBy || "Leadium"}`}</strong>
              <time>{formatMailTime(message.receivedAt)}</time>
            </header>
            <p className="email-message-subject">{message.subject || "(senza oggetto)"}</p>
            {/* Plain text only: an email is never rendered as HTML here. */}
            <p className="email-message-text">{message.text}</p>
            {message.attachments.length ? (
              <ul className="email-attachments" aria-label="Allegati">
                {message.attachments.map((item) => (
                  <li key={`${item.filename}-${item.size}`}><Paperclip size={13} aria-hidden="true" />{item.filename} ({formatAttachmentSize(item.size)})</li>
                ))}
              </ul>
            ) : null}
          </article>
        ))}
      </div>
      {thread.leadId ? (
        <form className="email-reply" onSubmit={(event) => { event.preventDefault(); void send(); }}>
          {notice ? <p className="email-notice is-error" role="alert">{notice}</p> : null}
          <label htmlFor="email-reply-text">Rispondi al cliente</label>
          <textarea id="email-reply-text" value={text} rows={4} maxLength={20000} onChange={(event) => setText(event.target.value)} placeholder="Scrivi la risposta" />
          <button type="submit" disabled={busy || !text.trim()}><Send size={15} aria-hidden="true" />{busy ? "Invio in corso…" : "Invia risposta"}</button>
        </form>
      ) : isAdmin ? <LinkToPractice mailId={thread.messages[0].id} onLinked={onChanged} /> : null}
    </>
  );
}

/** A sender Leadium could not recognise: an admin says which practice it belongs to. */
function LinkToPractice({ mailId, onLinked }: { mailId: string; onLinked(): Promise<void> }) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<LeadOption[]>([]);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) { setOptions([]); return; }
    const timer = window.setTimeout(() => {
      api<LeadOption[]>(`/api/leads?search=${encodeURIComponent(term)}`).then((rows) => setOptions(rows.slice(0, 6))).catch(() => setOptions([]));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  async function link(leadId: string) {
    setNotice("");
    try {
      await api(`/api/mail/messages/${encodeURIComponent(mailId)}`, { method: "PATCH", body: JSON.stringify({ linkLeadId: leadId, read: true }) });
      await onLinked();
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "Collegamento non riuscito.");
    }
  }

  return (
    <div className="email-reply">
      {notice ? <p className="email-notice is-error" role="alert">{notice}</p> : null}
      <label htmlFor="email-link-search">Collega a una pratica per rispondere</label>
      <div className="email-link-search">
        <Search size={15} aria-hidden="true" />
        <input id="email-link-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Nome, telefono o email del cliente" />
      </div>
      {options.length ? (
        <ul className="email-link-options">
          {options.map((lead) => (
            <li key={lead.id}><button type="button" onClick={() => void link(lead.id)}><strong>{lead.fullName || "Cliente"}</strong><span>{lead.email || lead.phone || ""}</span></button></li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
