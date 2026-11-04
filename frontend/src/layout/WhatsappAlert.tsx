import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";

export type WaitingChat = { id: string; phone: string; lastInboundAt: string | null };

const POLL_MS = 10000;

export function formatWaitingPhone(phone: string) {
  const value = String(phone || "").trim();
  return value.startsWith("+") ? value : `+${value}`;
}

function WhatsappLogo() {
  return (
    <svg viewBox="0 0 32 32" width="22" height="22" fill="none" aria-hidden="true">
      <path d="M27.281 4.673A15.815 15.815 0 0 0 16.028 0C7.308 0 .215 7.093.212 15.813a15.74 15.74 0 0 0 2.124 7.923L0 32l8.47-2.221a15.814 15.814 0 0 0 7.551 1.919h.007c8.718 0 15.812-7.094 15.815-15.813A15.7 15.7 0 0 0 27.281 4.673Z" fill="#25D366" />
      <path d="M12.506 9.144c-.263-.585-.54-.597-.79-.607-.204-.009-.438-.008-.671-.008-.232 0-.611.087-.931.437-.32.35-1.221 1.193-1.221 2.91 0 1.716 1.249 3.375 1.423 3.608.175.233 2.414 3.87 5.956 5.267 2.944 1.161 3.543.93 4.181.871.638-.059 2.057-.842 2.348-1.658.291-.816.291-1.514.204-1.658-.087-.145-.32-.233-.669-.408-.349-.175-2.058-1.017-2.378-1.133-.32-.117-.552-.175-.785.175-.233.35-.902 1.134-1.105 1.367-.204.233-.407.262-.756.087-.349-.175-1.473-.543-2.806-1.731-1.037-.925-1.737-2.065-1.94-2.414-.204-.35-.022-.539.153-.713.157-.156.349-.408.523-.612.175-.204.233-.35.349-.582.117-.233.059-.437-.029-.612-.087-.175-.768-1.851-1.082-2.549Z" fill="#ffffff" />
    </svg>
  );
}

/** The cards, separate from the polling so they can be checked without a server. */
export function WhatsappAlertCards({ chats, busyId, notice, onTake }: { chats: WaitingChat[]; busyId: string; notice: string; onTake(chat: WaitingChat): void }) {
  return (
    <div className="wa-alert-cards" aria-live="polite">
      {notice ? <p className="wa-alert-notice" role="status">{notice}</p> : null}
      {chats.slice(0, 3).map((chat) => (
        <button type="button" key={chat.id} className="wa-alert-card" disabled={Boolean(busyId)} onClick={() => onTake(chat)}>
          <strong>Ti scrive {formatWaitingPhone(chat.phone)}</strong>
          <span>{busyId === chat.id ? "Apro la chat…" : "Clicca per rispondere"}</span>
        </button>
      ))}
      {chats.length > 3 ? <p className="wa-alert-more">Altri {chats.length - 3} in attesa</p> : null}
    </div>
  );
}

/** Customers no operator has taken yet: the first one to click answers them. */
export function WhatsappAlert() {
  const navigate = useNavigate();
  const [chats, setChats] = useState<WaitingChat[]>([]);
  const [open, setOpen] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [notice, setNotice] = useState("");
  const knownIds = useRef(new Set<string>());

  const refresh = useCallback(async () => {
    try {
      const waiting = await api<WaitingChat[]>("/api/whatsapp/conversations/unclaimed");
      // A new customer brings the card back even if it was closed.
      if (waiting.some((chat) => !knownIds.current.has(chat.id))) setOpen(true);
      knownIds.current = new Set(waiting.map((chat) => chat.id));
      setChats(waiting);
    } catch { /* the next round retries; a missed round only delays the alert */ }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  async function take(chat: WaitingChat) {
    setBusyId(chat.id);
    setNotice("");
    try {
      await api(`/api/whatsapp/conversations/${encodeURIComponent(chat.id)}/claim`, { method: "POST" });
      setChats((current) => current.filter((item) => item.id !== chat.id));
      navigate(`/chat?conversationId=${encodeURIComponent(chat.id)}`);
    } catch (error) {
      setNotice(error instanceof Error && error.message ? error.message : "Non e stato possibile aprire la chat. Riprova.");
      await refresh();
    } finally {
      setBusyId("");
    }
  }

  if (!chats.length && !notice) return null;
  return (
    <div className="wa-alert">
      {open ? <WhatsappAlertCards chats={chats} busyId={busyId} notice={notice} onTake={(chat) => void take(chat)} /> : null}
      {chats.length ? (
        <button
          type="button"
          className="header-icon-btn wa-alert-logo"
          aria-expanded={open}
          aria-label={`Clienti WhatsApp in attesa di un operatore: ${chats.length}`}
          title="Clienti WhatsApp in attesa"
          onClick={() => setOpen((value) => !value)}
        >
          <WhatsappLogo />
          <span className="header-icon-badge">{chats.length > 99 ? "99+" : chats.length}</span>
        </button>
      ) : null}
    </div>
  );
}
