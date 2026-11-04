import { useEffect, useRef, useState } from "react";
import { api } from "../../../lib/api";
import { invalidateDashboardCache, invalidatePracticeListCaches, invalidateTaskBoardCache } from "../../../store/crm-store";
import "../../../styles/lead-action-dialog.css";

export type BulkResult = { done: string[]; skipped: Array<{ id: string; reason: string }> };

/** What the admin reads after the operation: nothing skipped must go unnoticed. */
export function describeBulkResult(action: "archive" | "restore", result: BulkResult) {
  const done = `${result.done.length} ${action === "archive" ? "lead archiviate" : "lead ripristinate"}.`;
  if (!result.skipped.length) return done;
  const sold = result.skipped.filter((item) => item.reason === "sold").length;
  const others = result.skipped.length - sold;
  return `${done}${sold ? ` ${sold} saltate perche hanno una vendita: vanno archiviate una per una.` : ""}${others ? ` ${others} saltate perche gia sistemate o non trovate.` : ""}`;
}

export function BulkLeadDialog({ action, leadIds, onClose, onDone }: {
  action: "archive" | "restore"; leadIds: string[];
  onClose: () => void; onDone: (result: BulkResult) => void | Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const archive = action === "archive";
  useEffect(() => { dialog.current?.showModal(); }, []);

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<BulkResult>(`/api/leads/bulk-${action}`, { method: "POST", body: JSON.stringify({ leadIds, reason }) });
      invalidateTaskBoardCache();
      invalidatePracticeListCaches();
      invalidateDashboardCache();
      onClose();
      await onDone(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Operazione non riuscita.");
      setBusy(false);
    }
  }

  return <dialog ref={dialog} className="lead-action-dialog" aria-labelledby="bulk-lead-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <h3 id="bulk-lead-title">{archive ? `Archivia ${leadIds.length} lead` : `Ripristina ${leadIds.length} lead`}</h3>
      {archive
        ? <p>Escono dalle liste operative e i loro promemoria si chiudono. Storico e motivo restano conservati: puoi ripristinarle da Archiviate. Le lead con una vendita vengono saltate.</p>
        : <p>Tornano visibili nelle liste operative.</p>}
      {archive && <label>Motivo obbligatorio
        <textarea autoFocus required maxLength={300} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy} />
      </label>}
      {error && <p role="alert" className="lead-action-error">{error}</p>}
      <footer>
        <button type="button" onClick={onClose} disabled={busy}>Annulla</button>
        <button type="submit" disabled={busy || (archive && !reason.trim())}>{busy ? "Operazione in corso..." : archive ? "Archivia" : "Ripristina"}</button>
      </footer>
    </form>
  </dialog>;
}
