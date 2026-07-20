import { useCallback, useEffect, useMemo, useState } from "react";
import { CircleCheck, Clock3, ContactRound, Gauge, TriangleAlert, UsersRound } from "lucide-react";
import { PageState } from "../components/ui/page-state";
import { api } from "../lib/api";
import "../styles/analytics-page.css";

type BreakdownRow = {
  label: string;
  count: number;
};

type OwnerLoadRow = {
  owner: string;
  total: number;
  ready: number;
  closed: number;
  overdue: number;
  slaBreached: number;
};

type Kpi = {
  total: number;
  toContact: number;
  interested: number;
  sold: number;
  noAnswer: number;
  overdueCallbacks: number;
  readyToClose: number;
  closed: number;
  lost: number;
  disqualified: number;
  unassigned: number;
  slaBreached: number;
  lossReasons: BreakdownRow[];
  statusBreakdown: BreakdownRow[];
  sourceBreakdown: BreakdownRow[];
  ownerLoad: OwnerLoadRow[];
};

const numberFormatter = new Intl.NumberFormat("it-IT");

function formatCount(value?: number) {
  return numberFormatter.format(Number(value || 0));
}

function BreakdownList({ rows, emptyLabel }: { rows?: BreakdownRow[]; emptyLabel: string }) {
  const maxValue = Math.max(1, ...(rows || []).map((row) => row.count));

  if (!rows?.length) return <p className="an-empty">{emptyLabel}</p>;

  return (
    <div className="an-breakdown-list">
      {rows.map((row) => (
        <div className="an-breakdown-row" key={row.label}>
          <div className="an-breakdown-meta">
            <span>{row.label}</span>
            <strong>{formatCount(row.count)}</strong>
          </div>
          <div className="an-breakdown-track" aria-hidden="true">
            <span style={{ width: `${Math.max(4, (row.count / maxValue) * 100)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function AnalyticsPage() {
  const [kpi, setKpi] = useState<Kpi | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setKpi(await api<Kpi>("/api/analytics/kpis"));
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "Impossibile caricare i report.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

  const summaryItems = useMemo(
    () => [
      { label: "Lead totali", value: kpi?.total ?? 0, meta: "nel CRM", icon: UsersRound, tone: "neutral" },
      { label: "Da contattare", value: kpi?.toContact ?? 0, meta: "richiedono azione", icon: ContactRound, tone: "info" },
      { label: "Pronte", value: kpi?.readyToClose ?? 0, meta: "da chiudere", icon: Gauge, tone: "warning" },
      { label: "Chiuse", value: kpi?.closed ?? 0, meta: "completate al 100%", icon: CircleCheck, tone: "success" },
      { label: "Richiami scaduti", value: kpi?.overdueCallbacks ?? 0, meta: "fuori scadenza", icon: Clock3, tone: "danger" },
      { label: "SLA superata", value: kpi?.slaBreached ?? 0, meta: "primo contatto", icon: TriangleAlert, tone: "danger" }
    ],
    [kpi]
  );

  if (loading && !kpi) {
    return (
      <section className="panel an-state-panel">
        <PageState kind="loading" title="Preparazione report" detail="Sto aggiornando indicatori e carico operatori." />
      </section>
    );
  }

  if (error && !kpi) {
    return (
      <section className="panel an-state-panel">
        <PageState kind="error" title="Report non disponibili" detail={error} actionLabel="Riprova" onAction={load} />
      </section>
    );
  }

  return (
    <div className="an-page">
      <header className="an-page-head">
        <div>
          <span className="an-eyebrow">Controllo operativo</span>
          <h1>Report CRM</h1>
          <p>Carico, avanzamento e criticità del lavoro commerciale.</p>
        </div>
        {loading ? <span className="an-refreshing">Aggiornamento...</span> : null}
      </header>

      {error ? <PageState compact kind="error" title="Alcuni dati potrebbero non essere aggiornati" detail={error} actionLabel="Riprova" onAction={load} /> : null}

      <section className="an-kpi-grid" aria-label="Indicatori principali">
        {summaryItems.map((item) => {
          const Icon = item.icon;
          return (
            <article className={`an-kpi an-tone-${item.tone}`} key={item.label}>
              <span className="an-kpi-icon" aria-hidden="true">
                <Icon size={18} />
              </span>
              <div>
                <span>{item.label}</span>
                <strong>{formatCount(item.value)}</strong>
                <small>{item.meta}</small>
              </div>
            </article>
          );
        })}
      </section>

      <div className="an-grid-two">
        <section className="panel an-section">
          <header className="an-section-head">
            <div>
              <h2>Distribuzione stati</h2>
              <p>Dove si concentra il portafoglio attuale.</p>
            </div>
          </header>
          <BreakdownList rows={kpi?.statusBreakdown} emptyLabel="Nessuno stato disponibile." />
        </section>

        <section className="panel an-section">
          <header className="an-section-head">
            <div>
              <h2>Origine lead</h2>
              <p>Volumi acquisiti per sorgente.</p>
            </div>
          </header>
          <BreakdownList rows={kpi?.sourceBreakdown} emptyLabel="Nessuna sorgente disponibile." />
        </section>
      </div>

      <section className="panel an-section an-owner-section">
        <header className="an-section-head">
          <div>
            <h2>Carico operatori</h2>
            <p>Confronto tra pratiche assegnate, completate e criticità.</p>
          </div>
          <span className="an-section-count">{formatCount(kpi?.ownerLoad?.length)} operatori</span>
        </header>

        <div className="an-table-wrap">
          <table className="an-table">
            <thead>
              <tr>
                <th>Operatore</th>
                <th>Pratiche</th>
                <th>Pronte</th>
                <th>Chiuse</th>
                <th>Scadute</th>
                <th>SLA superata</th>
              </tr>
            </thead>
            <tbody>
              {kpi?.ownerLoad?.length ? (
                kpi.ownerLoad.map((row) => (
                  <tr key={row.owner}>
                    <td><strong>{row.owner}</strong></td>
                    <td>{formatCount(row.total)}</td>
                    <td>{formatCount(row.ready)}</td>
                    <td className="an-positive">{formatCount(row.closed)}</td>
                    <td className={row.overdue ? "an-negative" : ""}>{formatCount(row.overdue)}</td>
                    <td className={row.slaBreached ? "an-negative" : ""}>{formatCount(row.slaBreached)}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="an-table-empty">Nessun dato operatore disponibile.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <div className="an-grid-two an-grid-secondary">
        <section className="panel an-section">
          <header className="an-section-head">
            <div>
              <h2>Motivi di perdita</h2>
              <p>Cause dichiarate sulle opportunità non concluse.</p>
            </div>
          </header>
          <BreakdownList rows={kpi?.lossReasons} emptyLabel="Nessun motivo di perdita registrato." />
        </section>

        <section className="panel an-section an-summary-list">
          <header className="an-section-head">
            <div>
              <h2>Altri indicatori</h2>
              <p>Segnali utili per la revisione amministrativa.</p>
            </div>
          </header>
          <dl>
            <div><dt>Interessati</dt><dd>{formatCount(kpi?.interested)}</dd></div>
            <div><dt>Vendute</dt><dd>{formatCount(kpi?.sold)}</dd></div>
            <div><dt>Non risponde</dt><dd>{formatCount(kpi?.noAnswer)}</dd></div>
            <div><dt>Non assegnate</dt><dd>{formatCount(kpi?.unassigned)}</dd></div>
            <div><dt>Perse</dt><dd>{formatCount(kpi?.lost)}</dd></div>
            <div><dt>Escluse</dt><dd>{formatCount(kpi?.disqualified)}</dd></div>
          </dl>
        </section>
      </div>
    </div>
  );
}
