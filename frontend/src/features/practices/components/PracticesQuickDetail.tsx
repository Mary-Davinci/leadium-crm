import { Link } from "react-router-dom";
import { buildCrmChatPath } from "../../../lib/whatsapp";
import { Lead } from "../pratiche.types";
import { useThreeCx } from "../../calls/threecx-context";

export type PracticesQuickDetailProps = {
  lead: Lead | null;
};

export function PracticesQuickDetail({ lead }: PracticesQuickDetailProps) {
  const threeCx = useThreeCx();
  if (!lead) {
    return null;
  }

  const documentsPending = Number(lead.documentsMissingCount || 0);
  const paymentsPending = Number(lead.pendingPaymentsCount || 0);
  const hasBlockers = documentsPending > 0 || paymentsPending > 0;

  return (
    <div className="pr-drawer-shell">
      <header className="pr-drawer-head">
        <div className="pr-drawer-identity">
          <h3>{lead.fullName}</h3>
          <p>{lead.phone}</p>
        </div>
      </header>

      <section className="pr-drawer-section">
        <h4>Bloccanti</h4>
        <div className="pr-drawer-blockers">
          <article className={`pr-drawer-blocker ${paymentsPending ? "warning" : "ok"}`}>
            <span>Pagamenti sospesi</span>
            <strong>{paymentsPending ? `${paymentsPending}` : "Nessuno"}</strong>
          </article>
          <article className={`pr-drawer-blocker ${documentsPending ? "warning" : "ok"}`}>
            <span>Documenti mancanti</span>
            <strong>{documentsPending ? `${documentsPending}` : "Nessuno"}</strong>
          </article>
          {!hasBlockers ? <p className="pr-drawer-empty">Nessun bloccante attivo su questa pratica.</p> : null}
        </div>
      </section>

      <footer className="pr-drawer-actions">
        <button type="button" disabled={threeCx.busy} className="pr-drawer-action pr-drawer-action-primary" onClick={() => void threeCx.dial(lead.phone || "")}>
          Chiama
        </button>
        <Link className="pr-drawer-action" to={buildCrmChatPath(lead)}>
          WhatsApp
        </Link>
      </footer>
    </div>
  );
}
