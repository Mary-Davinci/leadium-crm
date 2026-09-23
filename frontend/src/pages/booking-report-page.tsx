import { useCallback, useMemo, useState, type ReactNode } from "react";
import { CalendarCheck, FileText, ListChecks, UsersRound } from "lucide-react";
import { PageState } from "../components/ui/page-state";
import { api } from "../lib/api";
import { apiUrl } from "../lib/api-url";
import { getAuthToken } from "../lib/auth";
import { ReportTabs } from "../features/reports/components/ReportTabs";
import "../styles/report-page.css";
import "../styles/booking-report-page.css";

type BookingReportFilters = {
  dateFrom: string;
  dateTo: string;
  operatore: string;
  campagna: string;
  prodotto: string;
  canale: string;
  esito: string;
  statoLead: string;
};

const EMPTY_FILTERS: BookingReportFilters = {
  dateFrom: "",
  dateTo: "",
  operatore: "",
  campagna: "",
  prodotto: "",
  canale: "",
  esito: "",
  statoLead: ""
};

type BookingReportRow = {
  operatore: string;
  cliente: string;
  leadId: string;
  data: string;
  ora: string;
  numeroContatto: string;
  tipoAttivita: string;
  esito: string;
  note: string;
  appuntamento: string;
  preventivo: string;
  motivoPerdita: string;
  campagna: string;
  prodotto: string;
  prossimaAzione: string;
  canale: string;
  statoLead: string;
};

type BookingReportResponse = {
  count: number;
  rows: BookingReportRow[];
};

const numberFormatter = new Intl.NumberFormat("it-IT");
function formatCount(value: number) {
  return numberFormatter.format(value);
}

function countBy(rows: BookingReportRow[], field: "campagna" | "prodotto" | "esito") {
  const map = new Map<string, number>();
  rows.forEach((row) => {
    const value = String(row[field] || "").trim();
    if (!value) return;
    map.set(value, (map.get(value) || 0) + 1);
  });
  return Array.from(map.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
}

function Breakdown({ title, rows }: { title: string; rows: Array<{ label: string; count: number }> }) {
  const maxValue = Math.max(1, ...rows.map((row) => row.count));
  return (
    <div>
      <h3 className="bkr-breakdown-title">{title}</h3>
      {rows.length ? (
        <div className="bkr-breakdown-list">
          {rows.map((row) => (
            <div className="bkr-breakdown-row" key={row.label}>
              <div className="bkr-breakdown-meta">
                <span>{row.label}</span>
                <strong>{formatCount(row.count)}</strong>
              </div>
              <div className="bkr-breakdown-track" aria-hidden="true">
                <span style={{ width: `${Math.max(4, (row.count / maxValue) * 100)}%` }} />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="bkr-empty">Nessun dato.</p>
      )}
    </div>
  );
}

export function BookingReportPage() {
  const [filters, setFilters] = useState<BookingReportFilters>(EMPTY_FILTERS);
  const [result, setResult] = useState<BookingReportResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const [hasSearched, setHasSearched] = useState(false);

  const buildQuery = useCallback(() => {
    const params = new URLSearchParams();
    if (filters.dateFrom) params.set("dateFrom", filters.dateFrom);
    if (filters.dateTo) params.set("dateTo", filters.dateTo);
    if (filters.operatore) params.set("operatore", filters.operatore);
    if (filters.campagna) params.set("campagna", filters.campagna);
    if (filters.prodotto) params.set("prodotto", filters.prodotto);
    if (filters.canale) params.set("canale", filters.canale);
    if (filters.esito) params.set("esito", filters.esito);
    if (filters.statoLead) params.set("statoLead", filters.statoLead);
    return params;
  }, [filters]);

  const runSearch = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = buildQuery();
      setResult(await api<BookingReportResponse>(`/api/report/booking-activities?${params.toString()}`));
      setHasSearched(true);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "Impossibile caricare il report.");
    } finally {
      setLoading(false);
    }
  }, [buildQuery]);

  const exportCsv = useCallback(async () => {
    setExporting(true);
    setError("");
    try {
      const params = buildQuery();
      const token = getAuthToken();
      const response = await fetch(apiUrl(`/api/report/booking-activities/csv?${params.toString()}`), {
        headers: token ? { Authorization: `Bearer ${token}` } : {}
      });
      if (!response.ok) throw new Error("Esportazione non riuscita.");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "booking-activities.csv";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "Esportazione non riuscita.");
    } finally {
      setExporting(false);
    }
  }, [buildQuery]);

  function resetFilters() {
    setFilters(EMPTY_FILTERS);
    setResult(null);
    setHasSearched(false);
    setError("");
  }

  const rows = result?.rows || [];
  // The backend caps the JSON preview at 500 rows (result.count is the real total); every
  // aggregate below is derived from `rows`, so it can only ever reflect what was fetched.
  const isPartial = Boolean(result && result.count > rows.length);

  const appointmentsCount = useMemo(() => rows.filter((row) => row.appuntamento).length, [rows]);
  const quotesCount = useMemo(() => rows.filter((row) => row.preventivo === "Si").length, [rows]);
  const activeOperators = useMemo(() => new Set(rows.map((row) => row.operatore).filter(Boolean)).size, [rows]);

  const volumeByDay = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((row) => {
      if (!row.data) return;
      map.set(row.data, (map.get(row.data) || 0) + 1);
    });
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({ date, count }));
  }, [rows]);
  const volumeMax = Math.max(1, ...volumeByDay.map((item) => item.count));

  const operatorPerf = useMemo(() => {
    const map = new Map<string, { operatore: string; attivita: number; positivi: number }>();
    rows.forEach((row) => {
      const operatore = row.operatore || "Non assegnato";
      const current = map.get(operatore) || { operatore, attivita: 0, positivi: 0 };
      current.attivita += 1;
      if (row.appuntamento || row.preventivo === "Si") current.positivi += 1;
      map.set(operatore, current);
    });
    return Array.from(map.values()).sort((a, b) => b.attivita - a.attivita);
  }, [rows]);

  const campaignBreakdown = useMemo(() => countBy(rows, "campagna"), [rows]);
  const productBreakdown = useMemo(() => countBy(rows, "prodotto"), [rows]);
  const outcomeBreakdown = useMemo(() => countBy(rows, "esito"), [rows]);

  return (
    <div className="bkr-page">
      <ReportTabs />

      <header className="bkr-head">
        <span className="rpt-eyebrow">Controllo operativo</span>
        <h1>Booking</h1>
        <p>Storico attività del Booking Workflow: volume, performance per operatore, campagne e prodotti.</p>
      </header>

      <ReportSectionLike title="Filtri" description="Combina i filtri e avvia la ricerca; ogni campo lasciato vuoto include tutti i valori.">
        <div className="bkr-filters">
          <label>
            <span>Data da</span>
            <input type="date" value={filters.dateFrom} onChange={(event) => setFilters((f) => ({ ...f, dateFrom: event.target.value }))} />
          </label>
          <label>
            <span>Data a</span>
            <input type="date" value={filters.dateTo} onChange={(event) => setFilters((f) => ({ ...f, dateTo: event.target.value }))} />
          </label>
          <label>
            <span>Operatore</span>
            <input
              type="text"
              value={filters.operatore}
              onChange={(event) => setFilters((f) => ({ ...f, operatore: event.target.value }))}
              placeholder="Tutti gli operatori"
            />
          </label>
          <label>
            <span>Campagna</span>
            <input type="text" value={filters.campagna} onChange={(event) => setFilters((f) => ({ ...f, campagna: event.target.value }))} />
          </label>
          <label>
            <span>Prodotto</span>
            <input type="text" value={filters.prodotto} onChange={(event) => setFilters((f) => ({ ...f, prodotto: event.target.value }))} />
          </label>
          <label>
            <span>Canale</span>
            <input type="text" value={filters.canale} onChange={(event) => setFilters((f) => ({ ...f, canale: event.target.value }))} placeholder="3cx, manuale..." />
          </label>
          <label>
            <span>Esito</span>
            <input type="text" value={filters.esito} onChange={(event) => setFilters((f) => ({ ...f, esito: event.target.value }))} placeholder="Interessato, Non risponde..." />
          </label>
          <label>
            <span>Stato pratica</span>
            <input type="text" value={filters.statoLead} onChange={(event) => setFilters((f) => ({ ...f, statoLead: event.target.value }))} />
          </label>
        </div>

        <div className="bkr-actions">
          <button type="button" className="bkr-btn" onClick={resetFilters}>
            Azzera filtri
          </button>
          <button type="button" className="bkr-btn bkr-btn-primary" onClick={() => void runSearch()} disabled={loading}>
            {loading ? "Ricerca..." : "Cerca"}
          </button>
          <button type="button" className="bkr-btn" onClick={() => void exportCsv()} disabled={exporting}>
            {exporting ? "Esportazione..." : "Esporta CSV"}
          </button>
        </div>

        {error ? <p className="bkr-error">{error}</p> : null}
      </ReportSectionLike>

      {hasSearched ? (
        rows.length ? (
          <>
            {isPartial ? (
              <p className="bkr-partial-note">
                {formatCount(result!.count)} attività corrispondono ai filtri: KPI, andamento, performance e breakdown sotto sono calcolati sulle prime{" "}
                {formatCount(rows.length)} (limite dell'anteprima). Restringi i filtri per un quadro completo, oppure usa "Esporta CSV" per l'elenco integrale.
              </p>
            ) : null}

            <section className="bkr-kpi-grid" aria-label="Indicatori Booking">
              <article className="bkr-kpi">
                <span className="bkr-kpi-icon" aria-hidden="true">
                  <ListChecks size={17} />
                </span>
                <span className="bkr-kpi-label">Attività totali</span>
                <strong className="bkr-kpi-value">{formatCount(result!.count)}</strong>
                <span className="bkr-kpi-meta">nel periodo/filtro selezionato</span>
              </article>
              <article className="bkr-kpi">
                <span className="bkr-kpi-icon" aria-hidden="true">
                  <CalendarCheck size={17} />
                </span>
                <span className="bkr-kpi-label">Appuntamenti fissati</span>
                <strong className="bkr-kpi-value">{formatCount(appointmentsCount)}</strong>
                <span className="bkr-kpi-meta">esito "Appuntamento fissato"</span>
              </article>
              <article className="bkr-kpi">
                <span className="bkr-kpi-icon" aria-hidden="true">
                  <FileText size={17} />
                </span>
                <span className="bkr-kpi-label">Preventivi</span>
                <strong className="bkr-kpi-value">{formatCount(quotesCount)}</strong>
                <span className="bkr-kpi-meta">richiesti o inviati</span>
              </article>
              <article className="bkr-kpi">
                <span className="bkr-kpi-icon" aria-hidden="true">
                  <UsersRound size={17} />
                </span>
                <span className="bkr-kpi-label">Operatori attivi</span>
                <strong className="bkr-kpi-value">{formatCount(activeOperators)}</strong>
                <span className="bkr-kpi-meta">con almeno un'attività</span>
              </article>
            </section>

            <ReportSectionLike title="Andamento attività" description="Volume di chiamate per giorno, nel risultato corrente.">
              {volumeByDay.length ? (
                <>
                  <div className="bkr-volume-bars" aria-hidden="true">
                    {volumeByDay.map((item) => (
                      <span key={item.date} className="bkr-volume-bar" style={{ height: `${Math.max(4, (item.count / volumeMax) * 100)}%` }} title={`${item.date}: ${item.count}`} />
                    ))}
                  </div>
                  <div className="bkr-volume-labels">
                    <span>{volumeByDay[0].date}</span>
                    {volumeByDay.length > 1 ? <span>{volumeByDay[volumeByDay.length - 1].date}</span> : null}
                  </div>
                </>
              ) : (
                <p className="bkr-empty">Nessuna attività da mostrare.</p>
              )}
            </ReportSectionLike>

            <ReportSectionLike title="Performance per operatore" description="Attività registrate ed esiti positivi (appuntamento o preventivo) nel risultato corrente.">
              <div className="bkr-table-wrap">
                <table className="bkr-table">
                  <thead>
                    <tr>
                      <th>Operatore</th>
                      <th>Attività</th>
                      <th>Esiti positivi</th>
                      <th>% positivi</th>
                    </tr>
                  </thead>
                  <tbody>
                    {operatorPerf.map((row) => (
                      <tr key={row.operatore}>
                        <td>
                          <strong>{row.operatore}</strong>
                        </td>
                        <td>{formatCount(row.attivita)}</td>
                        <td className={row.positivi ? "bkr-positive" : ""}>{formatCount(row.positivi)}</td>
                        <td>{row.attivita ? Math.round((row.positivi / row.attivita) * 100) : 0}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </ReportSectionLike>

            <ReportSectionLike title="Campagne, prodotti ed esiti" description="Distribuzione delle attività nel risultato corrente.">
              <div className="bkr-breakdown-grid">
                <Breakdown title="Campagna" rows={campaignBreakdown} />
                <Breakdown title="Prodotto" rows={productBreakdown} />
                <Breakdown title="Esito" rows={outcomeBreakdown} />
              </div>
            </ReportSectionLike>

            <ReportSectionLike title="Dettaglio attività" description={`${formatCount(rows.length)} righe mostrate su ${formatCount(result!.count)} totali.`}>
              <div className="bkr-table-wrap">
                <table className="bkr-table">
                  <thead>
                    <tr>
                      <th>Operatore</th>
                      <th>Cliente</th>
                      <th>Data</th>
                      <th>Ora</th>
                      <th>Numero</th>
                      <th>Esito</th>
                      <th>Note</th>
                      <th>Campagna</th>
                      <th>Prodotto</th>
                      <th>Prossima azione</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, index) => (
                      <tr key={`${row.leadId}_${row.data}_${row.ora}_${index}`}>
                        <td>{row.operatore || "-"}</td>
                        <td>{row.cliente || "-"}</td>
                        <td>{row.data || "-"}</td>
                        <td>{row.ora || "-"}</td>
                        <td>{row.numeroContatto || "-"}</td>
                        <td>{row.esito || "-"}</td>
                        <td>{row.note || "-"}</td>
                        <td>{row.campagna || "-"}</td>
                        <td>{row.prodotto || "-"}</td>
                        <td>{row.prossimaAzione || "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </ReportSectionLike>
          </>
        ) : (
          <PageState compact kind="empty" title="Nessun risultato" detail="Nessuna attività corrisponde ai filtri selezionati." />
        )
      ) : null}
    </div>
  );
}

// Local, page-scoped section wrapper (kept separate from the shared ReportSection so this
// page's own .bkr-* stylesheet stays self-contained, per the "dedicated stylesheet" constraint).
function ReportSectionLike({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="bkr-section">
      <header className="bkr-section-head">
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </header>
      {children}
    </section>
  );
}
