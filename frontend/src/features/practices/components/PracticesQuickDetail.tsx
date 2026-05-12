import { LeadDetail } from "../pratiche.types";

export type PracticesQuickDetailProps = {
  detail: LeadDetail | null;
  loading: boolean;
};

function getPhoneHref(phone?: string) {
  const cleaned = String(phone || "").replace(/[^\d+]/g, "");
  return cleaned ? `tel:${cleaned}` : "#";
}

function getWhatsAppHref(phone?: string) {
  const cleaned = String(phone || "").replace(/\D/g, "");
  return cleaned ? `https://wa.me/${cleaned}` : "#";
}

function getDocumentPendingCount(detail: LeadDetail) {
  const items = detail.lead.documents?.items || [];
  return items.filter((item) => item.required && (!item.received || !item.verified)).length;
}

function getPaymentPendingCount(detail: LeadDetail) {
  const items = detail.lead.payments?.items || [];
  return items.filter((item) => item.required && item.status !== "verified").length;
}

export function PracticesQuickDetail({ detail, loading }: PracticesQuickDetailProps) {
  if (loading) {
    return (
      <div className="pr-drawer-shell">
        <p className="muted">Caricamento dettaglio...</p>
      </div>
    );
  }

  if (!detail) {
    return null;
  }

  const documentsPending = getDocumentPendingCount(detail);
  const paymentsPending = getPaymentPendingCount(detail);
  const hasBlockers = documentsPending > 0 || paymentsPending > 0;

  return (
    <div className="pr-drawer-shell">
      <header className="pr-drawer-head">
        <div className="pr-drawer-identity">
          <h3>{detail.lead.fullName}</h3>
          <p>{detail.lead.phone}</p>
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
        <a className="pr-drawer-action pr-drawer-action-primary" href={getPhoneHref(detail.lead.phone)}>
          Chiama
        </a>
        <a className="pr-drawer-action" href={getWhatsAppHref(detail.lead.phone)} target="_blank" rel="noreferrer">
          WhatsApp
        </a>
      </footer>
    </div>
  );
}
