import { useCallback, useEffect, useMemo, useState } from "react";
import { ContactRound, Gauge, TrendingUp, TriangleAlert, UsersRound } from "lucide-react";
import { PageState } from "../components/ui/page-state";
import { api } from "../lib/api";
import { getAuthUser } from "../lib/auth";
import type { Lead } from "../features/practices/pratiche.types";
import { ReportEmptyState } from "../features/reports/components/ReportEmptyState";
import { ReportKpiCard } from "../features/reports/components/ReportKpiCard";
import { ReportLegend } from "../features/reports/components/ReportLegend";
import { ReportSection } from "../features/reports/components/ReportSection";
import { ReportTabs } from "../features/reports/components/ReportTabs";
import "../styles/report-page.css";

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

// Kpi shape matches backend computeKpis() exactly -- no metric here is
// invented or client-derived; every field is what /api/analytics/kpis
// already returns today.
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

// Real workflow progression (backend/services/common/workflow.ts LEAD_STATUSES), used only to
// ORDER the already-real statusBreakdown counts into a readable funnel -- not a re-implementation
// of transition rules, and no conversion % is claimed between non-adjacent/branching stages.
const STATUS_FUNNEL_ORDER = [
  "Da contattare",
  "Richiamo concordato",
  "Non risponde",
  "Contatto interessato",
  "Vendita a rate",
  "Vendita unica",
  "Venduta",
  "Primo acconto",
  "Secondo acconto",
  "Saldo",
  "Invio gadget",
  "Invio biglietti",
  "Pronta per chiusura",
  "Chiusa 100%",
  "Contattato non interessato",
  "Fuori budget",
  "Persa",
  "Annulla flusso"
];

const numberFormatter = new Intl.NumberFormat("it-IT");
const key = (value?: string | null) => String(value || "").trim().toLocaleLowerCase("it");
const timestamp = (value?: string | null) => (value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0);

function formatCount(value?: number) {
  return numberFormatter.format(Number(value || 0));
}

function Breakdown({ rows, emptyLabel }: { rows?: BreakdownRow[]; emptyLabel: string }) {
  const maxValue = Math.max(1, ...(rows || []).map((row) => row.count));
  if (!rows?.length) return <ReportEmptyState message={emptyLabel} />;
  return (
    <div className="rpt-breakdown-list">
      {rows.map((row) => (
        <div className="rpt-breakdown-row" key={row.label}>
          <div className="rpt-breakdown-meta">
            <span>{row.label}</span>
            <strong>{formatCount(row.count)}</strong>
          </div>
          <div className="rpt-breakdown-track" aria-hidden="true">
            <span style={{ width: `${Math.max(4, (row.count / maxValue) * 100)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function AnalyticsPage() {
  const authUser = getAuthUser();
  const isAdmin = authUser?.role === "admin" || authUser?.role === "super_admin";
  const actorKeys = useMemo(
    () => [authUser?.username, authUser?.name, authUser?.email].map(key).filter(Boolean),
    [authUser?.username, authUser?.name, authUser?.email]
  );

  const [kpi, setKpi] = useState<Kpi | null>(null);
  const [leadsSummary, setLeadsSummary] = useState<Lead[]>([]);
  const [trendDays, setTrendDays] = useState(14);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Two requests: /kpis (the proven snapshot, unchanged) and /leads?view=summary (already used
  // elsewhere in the app -- added here solely because /kpis has no time dimension and createdAt
  // is the only real field that can drive the trend chart). No new endpoint, no caching layer.
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [kpiData, leadsData] = await Promise.all([
        api<Kpi>("/api/analytics/kpis"),
        api<Lead[]>("/api/leads?view=summary")
      ]);
      setKpi(kpiData);
      setLeadsSummary(Array.isArray(leadsData) ? leadsData : []);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "Impossibile caricare i report.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

  const trend = useMemo(() => {
    const scoped = leadsSummary.filter((lead) => isAdmin || actorKeys.includes(key(lead.assignedTo)));
    return Array.from({ length: trendDays }, (_, index) => {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - trendDays + index + 1);
      const end = new Date(start);
      end.setDate(end.getDate() + 1);
      return {
        date: start,
        count: scoped.filter((lead) => timestamp(lead.createdAt) >= start.getTime() && timestamp(lead.createdAt) < end.getTime()).length
      };
    });
  }, [leadsSummary, trendDays, isAdmin, actorKeys]);

  const trendMax = Math.max(2, ...trend.map((item) => item.count));
  const trendPoints = trend.map((item, index) => `${38 + (index * 604) / (trendDays - 1)},${162 - (item.count / trendMax) * 128}`).join(" ");
  const trendTotal = trend.reduce((sum, item) => sum + item.count, 0);

  const funnelRows = useMemo(() => {
    const rows = kpi?.statusBreakdown || [];
    return [...rows].sort((a, b) => {
      const ia = STATUS_FUNNEL_ORDER.indexOf(a.label);
      const ib = STATUS_FUNNEL_ORDER.indexOf(b.label);
      return (ia === -1 ? STATUS_FUNNEL_ORDER.length : ia) - (ib === -1 ? STATUS_FUNNEL_ORDER.length : ib);
    });
  }, [kpi?.statusBreakdown]);
  const funnelMax = Math.max(1, ...funnelRows.map((row) => row.count));

  const conversionRate = kpi?.interested ? Math.round((kpi.sold / kpi.interested) * 100) : 0;

  if (loading && !kpi) {
    return (
      <div className="rpt-page">
        <ReportTabs />
        <section className="panel">
          <PageState kind="loading" title="Preparazione report" detail="Sto aggiornando indicatori e andamento." />
        </section>
      </div>
    );
  }

  if (error && !kpi) {
    return (
      <div className="rpt-page">
        <ReportTabs />
        <section className="panel">
          <PageState kind="error" title="Report non disponibili" detail={error} actionLabel="Riprova" onAction={load} />
        </section>
      </div>
    );
  }

  return (
    <div className="rpt-page">
      <ReportTabs />

      <header className="rpt-head">
        <div>
          <span className="rpt-eyebrow">Controllo operativo</span>
          <h1>Panoramica</h1>
          <p>Carico, avanzamento e criticità del lavoro commerciale.</p>
        </div>
        {loading ? <span className="rpt-refreshing">Aggiornamento...</span> : null}
      </header>

      {error ? (
        <div className="rpt-error" role="alert">
          <span>Alcuni dati potrebbero non essere aggiornati: {error}</span>
          <button type="button" onClick={() => void load()}>
            Riprova
          </button>
        </div>
      ) : null}

      <section className="rpt-kpi-grid" aria-label="Indicatori principali">
        <ReportKpiCard icon={UsersRound} label="Lead totali" value={formatCount(kpi?.total)} meta="nel CRM" />
        <ReportKpiCard icon={ContactRound} tone="info" label="Da contattare" value={formatCount(kpi?.toContact)} meta="richiedono azione" />
        <ReportKpiCard
          icon={TrendingUp}
          tone="success"
          label="Conversione"
          value={`${conversionRate}%`}
          detail={`${formatCount(kpi?.sold)} vendute su ${formatCount(kpi?.interested)} interessati`}
          meta="interessati -> vendute"
        />
        <ReportKpiCard icon={Gauge} tone="warning" label="Pronte per chiusura" value={formatCount(kpi?.readyToClose)} meta="da chiudere" />
        <ReportKpiCard icon={TriangleAlert} tone="danger" label="Rischio operativo">
          <div className="rpt-kpi-risk-rows">
            <div className="rpt-risk-row callbacks">
              <span className="rpt-risk-row-label">Richiami scaduti</span>
              <strong className="rpt-risk-row-value">{formatCount(kpi?.overdueCallbacks)}</strong>
            </div>
            <div className="rpt-risk-row sla">
              <span className="rpt-risk-row-label">SLA primo contatto superata</span>
              <strong className="rpt-risk-row-value">{formatCount(kpi?.slaBreached)}</strong>
            </div>
          </div>
        </ReportKpiCard>
      </section>

      <ReportSection
        eyebrow="Andamento"
        title="Nuovi lead nel tempo"
        description="L'unico grafico dominante della pagina."
        actions={
          <div className="rpt-period">
            <select aria-label="Periodo del grafico" value={trendDays} onChange={(event) => setTrendDays(Number(event.target.value))}>
              <option value={14}>Ultimi 14 giorni</option>
              <option value={30}>Ultimi 30 giorni</option>
            </select>
            <p className="rpt-period-hint">Il periodo si applica solo a questo grafico.</p>
          </div>
        }
      >
        <div className="rpt-chart-summary">
          <strong>{formatCount(trendTotal)}</strong>
          <span>lead ricevuti nel periodo</span>
        </div>
        <ReportLegend items={[{ label: "Nuovi lead", color: "var(--brand-sky-500)" }]} />
        <svg
          className="rpt-chart"
          viewBox="0 0 660 200"
          role="img"
          aria-label={`Nuovi lead negli ultimi ${trendDays} giorni: ${trend.map((item) => `${item.date.toLocaleDateString("it-IT")}: ${item.count}`).join(", ")}`}
        >
          <defs>
            <linearGradient id="rpt-chart-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#5191fa" stopOpacity=".22" />
              <stop offset="100%" stopColor="#5191fa" stopOpacity=".02" />
            </linearGradient>
          </defs>
          {[0, 0.5, 1].map((ratio) => (
            <g key={ratio}>
              <line x1="38" x2="642" y1={162 - ratio * 128} y2={162 - ratio * 128} stroke="var(--border-subtle)" />
              <text x="25" y={166 - ratio * 128} textAnchor="end">
                {Math.round(trendMax * ratio)}
              </text>
            </g>
          ))}
          <polygon points={`38,162 ${trendPoints} 642,162`} fill="url(#rpt-chart-fill)" />
          <polyline points={trendPoints} fill="none" stroke="var(--brand-navy-800)" strokeWidth="2.5" strokeLinejoin="round" />
          {trend.map((item, index) => (
            <g key={index}>
              <circle cx={38 + (index * 604) / (trendDays - 1)} cy={162 - (item.count / trendMax) * 128} r="3" fill="#5191fa" stroke="white">
                <title>
                  {item.date.toLocaleDateString("it-IT")}: {item.count} lead
                </title>
              </circle>
              {(index === 0 || index === trendDays - 1 || index === Math.floor(trendDays / 2)) && (
                <text
                  x={38 + (index * 604) / (trendDays - 1)}
                  y="190"
                  textAnchor={index === 0 ? "start" : index === trendDays - 1 ? "end" : "middle"}
                >
                  {item.date.toLocaleDateString("it-IT", { day: "numeric", month: "short" })}
                </text>
              )}
            </g>
          ))}
        </svg>
      </ReportSection>

      <ReportSection eyebrow="Pipeline" title="Distribuzione per fase" description="Stati reali del workflow, ordinati per progressione. Non implica un tasso di conversione tra fasi non adiacenti.">
        {funnelRows.length ? (
          <div className="rpt-funnel">
            {funnelRows.map((row) => (
              <div className="rpt-funnel-row" key={row.label}>
                <span className="rpt-funnel-label">{row.label}</span>
                <span className="rpt-funnel-track" aria-hidden="true">
                  <span style={{ width: `${Math.max(4, (row.count / funnelMax) * 100)}%` }} />
                </span>
                <span className="rpt-funnel-value">{formatCount(row.count)}</span>
              </div>
            ))}
          </div>
        ) : (
          <ReportEmptyState message="Nessuno stato disponibile." />
        )}
      </ReportSection>

      <ReportSection
        eyebrow="Team"
        title="Performance operativa"
        description="Confronto tra pratiche assegnate, completate e criticità."
        actions={<span className="rpt-kpi-meta">{formatCount(kpi?.ownerLoad?.length)} operatori</span>}
      >
        <div className="rpt-table-wrap">
          <table className="rpt-table">
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
                    <td>
                      <strong>{row.owner}</strong>
                    </td>
                    <td>{formatCount(row.total)}</td>
                    <td>{formatCount(row.ready)}</td>
                    <td className="rpt-positive">{formatCount(row.closed)}</td>
                    <td className={row.overdue ? "rpt-negative" : ""}>{formatCount(row.overdue)}</td>
                    <td className={row.slaBreached ? "rpt-negative" : ""}>{formatCount(row.slaBreached)}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="rpt-table-empty">
                    Nessun dato operatore disponibile.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </ReportSection>

      <div className="rpt-secondary-grid">
        <ReportSection eyebrow="Origine" title="Canali di acquisizione" description="Volumi per fonte/piattaforma.">
          <Breakdown rows={kpi?.sourceBreakdown} emptyLabel="Nessuna sorgente disponibile." />
        </ReportSection>
        <ReportSection eyebrow="Chiusure" title="Motivi di perdita" description="Cause dichiarate sulle opportunità non concluse.">
          <Breakdown rows={kpi?.lossReasons} emptyLabel="Nessun motivo di perdita registrato." />
        </ReportSection>
      </div>
    </div>
  );
}
