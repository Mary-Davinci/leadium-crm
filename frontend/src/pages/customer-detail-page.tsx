import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { PageState } from "../components/ui/page-state";
import { api } from "../lib/api";
import { CustomerDetail } from "../features/customers/customer.types";
import "../styles/customer-detail-page.css";

const currencyFormatter = new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const dateFormatter = new Intl.DateTimeFormat("it-IT", { day: "2-digit", month: "2-digit", year: "numeric" });

function formatCurrency(value?: number) {
  return currencyFormatter.format(Number(value || 0));
}

function formatDate(value?: string | null) {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "-";
  return dateFormatter.format(parsed);
}

const PURCHASE_STATUS_LABELS: Record<string, string> = {
  completed: "Completato",
  pending: "In corso",
  cancelled: "Annullato",
  refunded: "Rimborsato"
};

const OUTCOME_LABELS: Record<string, string> = {
  open: "Attiva",
  won: "Vinta",
  lost: "Persa",
  disqualified: "Esclusa"
};

export function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError("");
    try {
      setDetail(await api<CustomerDetail>(`/api/customers/${id}`));
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "Impossibile caricare la scheda cliente.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

  if (loading && !detail) {
    return (
      <section className="panel cd-state-panel">
        <PageState kind="loading" title="Caricamento scheda cliente" detail="Sto raccogliendo acquisti e opportunita del cliente." />
      </section>
    );
  }

  if (error && !detail) {
    return (
      <section className="panel cd-state-panel">
        <PageState kind="error" title="Scheda cliente non disponibile" detail={error} actionLabel="Riprova" onAction={load} />
      </section>
    );
  }

  if (!detail) return null;

  const { customer, ltv, purchases, leads, activeLead } = detail;

  const kpis = [
    { label: "Lifetime Value", value: formatCurrency(ltv.ltv) },
    { label: "Acquisti", value: String(ltv.purchaseCount) },
    { label: "Valore medio", value: formatCurrency(ltv.averageOrderValue) },
    { label: "Primo acquisto", value: formatDate(ltv.firstPurchaseAt) },
    { label: "Ultimo acquisto", value: formatDate(ltv.lastPurchaseAt) }
  ];

  return (
    <div className="cd-page">
      <header className="cd-page-head">
        <div>
          <span className="cd-eyebrow">Scheda cliente</span>
          <h1>{customer.fullName || "Cliente senza nome"}</h1>
          <p className="cd-contact">
            {customer.phone || "-"} {customer.email ? `- ${customer.email}` : ""}
          </p>
          <p className="cd-meta">
            Primo contatto {formatDate(customer.firstSeenAt)} - Ultimo contatto {formatDate(customer.lastSeenAt)}
          </p>
        </div>
        {activeLead ? (
          <Link className="cd-active-lead-link" to={`/pratiche/${activeLead.id}`}>
            Trattativa attiva: {activeLead.status}
            {activeLead.nextActionAt ? ` - prossima azione ${formatDate(activeLead.nextActionAt)}` : " - nessuna prossima azione"}
          </Link>
        ) : null}
      </header>

      {error ? <PageState compact kind="error" title="Alcuni dati potrebbero non essere aggiornati" detail={error} actionLabel="Riprova" onAction={load} /> : null}

      <section className="cd-kpi-grid" aria-label="Lifetime value">
        {kpis.map((item) => (
          <article className="cd-kpi" key={item.label}>
            <span>{item.label}</span>
            <strong>{item.value}</strong>
          </article>
        ))}
      </section>

      <section className="panel cd-section">
        <header className="cd-section-head">
          <div>
            <h2>Storico acquisti</h2>
            <p>Tutti gli acquisti registrati per questo cliente.</p>
          </div>
          <span className="cd-section-count">{purchases.length}</span>
        </header>
        {purchases.length ? (
          <div className="cd-table-wrap">
            <table className="cd-table">
              <thead>
                <tr>
                  <th>Data</th>
                  <th>Prodotto</th>
                  <th>Importo</th>
                  <th>Stato</th>
                </tr>
              </thead>
              <tbody>
                {purchases.map((purchase) => (
                  <tr key={purchase.id}>
                    <td>{formatDate(purchase.purchasedAt)}</td>
                    <td>{purchase.cruiseName || purchase.product || "-"}</td>
                    <td>{formatCurrency(purchase.amount)}</td>
                    <td>
                      <span className={`cd-purchase-status cd-purchase-status-${purchase.status}`}>
                        {PURCHASE_STATUS_LABELS[purchase.status] || purchase.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="cd-empty">Nessun acquisto registrato per questo cliente.</p>
        )}
      </section>

      <section className="panel cd-section">
        <header className="cd-section-head">
          <div>
            <h2>Lead e opportunita</h2>
            <p>Tutte le opportunita commerciali generate da questo cliente nel tempo.</p>
          </div>
          <span className="cd-section-count">{leads.length}</span>
        </header>
        {leads.length ? (
          <div className="cd-lead-list">
            {leads.map((lead) => (
              <Link className="cd-lead-row" to={`/pratiche/${lead.id}`} key={lead.id}>
                <div className="cd-lead-row-main">
                  <strong>{lead.status}</strong>
                  <span className={`cd-outcome cd-outcome-${lead.closingOutcome}`}>{OUTCOME_LABELS[lead.closingOutcome] || lead.closingOutcome}</span>
                </div>
                <div className="cd-lead-row-meta">
                  <span>{lead.assignedTo || "Non assegnata"}</span>
                  <span>{formatDate(lead.createdAt)}</span>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <p className="cd-empty">Nessuna opportunita collegata a questo cliente.</p>
        )}
      </section>
    </div>
  );
}
