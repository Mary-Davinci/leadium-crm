import { useEffect, useRef, useState } from "react";
import { api } from "../../../lib/api";
import { invalidateDashboardCache, invalidateLeadDetailCache, invalidatePracticeListCaches, invalidateTaskBoardCache } from "../../../store/crm-store";
import "../../../styles/lead-action-dialog.css";

export type LeadAction = "archive" | "restore" | "worked" | "worked/undo" | "close" | "close/undo" | "email";
const titles: Record<LeadAction, string> = {
  archive: "Archivia contatto", restore: "Ripristina contatto", worked: "Segna come lavorata",
  "worked/undo": "Rimetti tra le attive", close: "Chiudi pratica", "close/undo": "Riapri pratica", email: "Invia email"
};

export function LeadActionDialog({ lead, action, onClose, onDone }: {
  lead: { id: string; fullName: string; email?: string }; action: LeadAction;
  onClose: () => void; onDone: () => void | Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState("");
  const [subject, setSubject] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const needsText = ["archive", "worked", "close", "email"].includes(action);
  async function submit() {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      await api(`/api/leads/${lead.id}/${action}`, {
        method: "POST", body: JSON.stringify(action === "email" ? { subject, text } : action === "archive" ? { reason: text } : { note: text })
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Operazione non riuscita.");
      setBusy(false);
      submitting.current = false;
      return;
    }
    invalidateTaskBoardCache();
    invalidatePracticeListCaches();
    invalidateLeadDetailCache(lead.id);
    invalidateDashboardCache();
    onClose();
    await onDone();
  }
  return <dialog ref={dialog} className="lead-action-dialog" aria-labelledby="lead-action-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <h3 id="lead-action-title">{titles[action]}</h3>
      <p>{lead.fullName}{action === "email" ? ` · ${lead.email || "Email mancante"}` : ""}</p>
      {action === "archive" && <p>Il contatto esce dalle liste operative. Storico e motivo restano conservati; un admin può ripristinarlo.</p>}
      {action === "worked" && <p>La pratica passa in Lavorate. I promemoria aperti vengono chiusi. Puoi rimetterla tra le attive.</p>}
      {action === "worked/undo" && <p>La pratica torna tra le attive. Imposta una nuova prossima azione se serve.</p>}
      {action === "close" && <p>La pratica passa in Pratiche chiuse: promemoria e messaggi automatici si fermano. Puoi riaprirla.</p>}
      {action === "close/undo" && <p>La pratica torna tra le attive. Imposta una nuova prossima azione se serve.</p>}
      {action === "restore" && <p>Il contatto torna visibile nelle liste operative.</p>}
      {action === "email" && <>
        <p>Una copia viene conservata nella casella aziendale. Questa versione invia solo testo.</p>
        <label>Oggetto<input autoFocus required maxLength={200} value={subject} onChange={(e) => setSubject(e.target.value)} disabled={busy} /></label>
      </>}
      {needsText && <label>{action === "archive" ? "Motivo obbligatorio" : action === "worked" ? "Cosa hai fatto con il cliente" : action === "close" ? "Perché si chiude" : "Messaggio"}
        <textarea autoFocus={action !== "email"} required maxLength={action === "email" ? 20000 : 1000} rows={6} value={text} onChange={(e) => setText(e.target.value)} disabled={busy} />
      </label>}
      {error && <p role="alert" className="lead-action-error">{error}</p>}
      <footer>
        <button type="button" onClick={onClose} disabled={busy}>Annulla</button>
        <button type="submit" disabled={busy || (needsText && !text.trim()) || (action === "email" && (!subject.trim() || !lead.email))}>{busy ? "Operazione in corso..." : titles[action]}</button>
      </footer>
    </form>
  </dialog>;
}
