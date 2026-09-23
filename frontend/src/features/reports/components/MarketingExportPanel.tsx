import { useCallback, useEffect, useState } from "react";
import { api } from "../../../lib/api";
import { apiUrl } from "../../../lib/api-url";
import { getAuthToken } from "../../../lib/auth";
import { ReportSection } from "./ReportSection";

type MarketingExportFilters = {
  dateFrom: string;
  dateTo: string;
  closingOutcome: string;
  lossReason: string;
  source: string;
  sourcePlatform: string;
  sourceCampaignId: string;
  assignedTo: string;
};

const EMPTY_EXPORT_FILTERS: MarketingExportFilters = {
  dateFrom: "",
  dateTo: "",
  closingOutcome: "",
  lossReason: "",
  source: "",
  sourcePlatform: "",
  sourceCampaignId: "",
  assignedTo: ""
};

type MarketingExportPreviewRow = {
  id: string;
  fullName: string;
  phone: string;
  email: string;
  source: string;
  sourcePlatform: string;
  closingOutcome: string;
  lossReason: string;
  assignedTo: string;
  createdAt: string | null;
};

type MarketingExportPreview = {
  count: number;
  sample: MarketingExportPreviewRow[];
};

const numberFormatter = new Intl.NumberFormat("it-IT");

function formatCount(value?: number) {
  return numberFormatter.format(Number(value || 0));
}

/**
 * Extracted verbatim from the former Panoramica ("Report") export block -- same endpoints,
 * filters, permission check (caller gates the whole page with RequireAdmin), and CSV behavior.
 * Self-contained: no props, so Panoramica and Marketing can both mount it without sharing state.
 */
export function MarketingExportPanel() {
  const [exportFilters, setExportFilters] = useState<MarketingExportFilters>(EMPTY_EXPORT_FILTERS);
  const [exportMode, setExportMode] = useState<"internal" | "meta">("internal");
  const [exportPreview, setExportPreview] = useState<MarketingExportPreview | null>(null);
  const [exportPreviewLoading, setExportPreviewLoading] = useState(false);
  const [exportError, setExportError] = useState("");
  const [exporting, setExporting] = useState(false);

  const buildExportQuery = useCallback(() => {
    const params = new URLSearchParams();
    if (exportFilters.dateFrom) params.set("dateFrom", new Date(exportFilters.dateFrom).toISOString());
    if (exportFilters.dateTo) params.set("dateTo", new Date(`${exportFilters.dateTo}T23:59:59`).toISOString());
    if (exportFilters.closingOutcome) params.set("closingOutcome", exportFilters.closingOutcome);
    if (exportFilters.lossReason) params.set("lossReason", exportFilters.lossReason);
    if (exportFilters.source) params.set("source", exportFilters.source);
    if (exportFilters.sourcePlatform) params.set("sourcePlatform", exportFilters.sourcePlatform);
    if (exportFilters.sourceCampaignId) params.set("sourceCampaignId", exportFilters.sourceCampaignId);
    if (exportFilters.assignedTo) params.set("assignedTo", exportFilters.assignedTo);
    return params;
  }, [exportFilters]);

  const applyDeadContactsPreset = useCallback(() => {
    setExportFilters(EMPTY_EXPORT_FILTERS);
    setExportPreview(null);
    setExportError("");
  }, []);

  const loadExportPreview = useCallback(async () => {
    setExportPreviewLoading(true);
    setExportError("");
    try {
      const params = buildExportQuery();
      setExportPreview(await api<MarketingExportPreview>(`/api/analytics/export/marketing/preview?${params.toString()}`));
    } catch (fetchError) {
      setExportError(fetchError instanceof Error ? fetchError.message : "Impossibile calcolare l'anteprima.");
    } finally {
      setExportPreviewLoading(false);
    }
  }, [buildExportQuery]);

  const exportMarketingCsv = useCallback(async () => {
    setExporting(true);
    setExportError("");
    try {
      const params = buildExportQuery();
      let preview = exportPreview;
      if (!preview) {
        preview = await api<MarketingExportPreview>(`/api/analytics/export/marketing/preview?${params.toString()}`);
        setExportPreview(preview);
      }
      if (preview.count === 0) {
        setExportError("Nessun contatto corrisponde ai filtri selezionati.");
        return;
      }
      params.set("mode", exportMode);
      const token = getAuthToken();
      const response = await fetch(apiUrl(`/api/analytics/export/marketing/csv?${params.toString()}`), {
        headers: token ? { Authorization: `Bearer ${token}` } : {}
      });
      if (!response.ok) throw new Error("Esportazione non riuscita.");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `marketing-export-${exportMode}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (fetchError) {
      setExportError(fetchError instanceof Error ? fetchError.message : "Esportazione non riuscita.");
    } finally {
      setExporting(false);
    }
  }, [buildExportQuery, exportMode, exportPreview]);

  useEffect(() => {
    setExportPreview(null);
  }, [exportFilters]);

  return (
    <ReportSection eyebrow="Export" title="Export Marketing" description="Elenco di contatti chiusi o persi, pronto per remarketing o per una Custom Audience Meta.">
      <div className="rpt-export-presets">
        <button type="button" className="rpt-export-preset" onClick={applyDeadContactsPreset}>
          Contatti chiusi/persi
        </button>
      </div>

      <div className="rpt-export-filters">
        <label>
          <span>Da</span>
          <input type="date" value={exportFilters.dateFrom} onChange={(event) => setExportFilters((f) => ({ ...f, dateFrom: event.target.value }))} />
        </label>
        <label>
          <span>A</span>
          <input type="date" value={exportFilters.dateTo} onChange={(event) => setExportFilters((f) => ({ ...f, dateTo: event.target.value }))} />
        </label>
        <label>
          <span>Esito</span>
          <select value={exportFilters.closingOutcome} onChange={(event) => setExportFilters((f) => ({ ...f, closingOutcome: event.target.value }))}>
            <option value="">Persi ed esclusi</option>
            <option value="lost">Solo persi</option>
            <option value="disqualified">Solo esclusi</option>
          </select>
        </label>
        <label>
          <span>Motivo perdita</span>
          <input
            type="text"
            value={exportFilters.lossReason}
            onChange={(event) => setExportFilters((f) => ({ ...f, lossReason: event.target.value }))}
            placeholder="es. fuori_budget"
          />
        </label>
        <label>
          <span>Fonte</span>
          <input type="text" value={exportFilters.source} onChange={(event) => setExportFilters((f) => ({ ...f, source: event.target.value }))} />
        </label>
        <label>
          <span>Piattaforma</span>
          <input
            type="text"
            value={exportFilters.sourcePlatform}
            onChange={(event) => setExportFilters((f) => ({ ...f, sourcePlatform: event.target.value }))}
            placeholder="facebook, instagram..."
          />
        </label>
        <label>
          <span>Campagna</span>
          <input
            type="text"
            value={exportFilters.sourceCampaignId}
            onChange={(event) => setExportFilters((f) => ({ ...f, sourceCampaignId: event.target.value }))}
          />
        </label>
        <label>
          <span>Operatore</span>
          <input type="text" value={exportFilters.assignedTo} onChange={(event) => setExportFilters((f) => ({ ...f, assignedTo: event.target.value }))} />
        </label>
      </div>

      <div className="rpt-export-actions">
        <div className="rpt-export-mode" role="group" aria-label="Modalita export">
          <button type="button" className={exportMode === "internal" ? "is-active" : ""} onClick={() => setExportMode("internal")}>
            Interno
          </button>
          <button type="button" className={exportMode === "meta" ? "is-active" : ""} onClick={() => setExportMode("meta")}>
            Pubblico Meta
          </button>
        </div>
        <button type="button" className="rpt-export-btn" onClick={() => void loadExportPreview()} disabled={exportPreviewLoading}>
          {exportPreviewLoading ? "Caricamento..." : "Anteprima"}
        </button>
        <button
          type="button"
          className="rpt-export-btn rpt-export-btn-primary"
          onClick={() => void exportMarketingCsv()}
          disabled={exporting || exportPreviewLoading}
        >
          {exporting ? "Esportazione..." : "Esporta CSV"}
        </button>
      </div>

      {exportError ? <p className="rpt-export-error">{exportError}</p> : null}

      {exportPreview ? (
        <div>
          <p className="rpt-export-count">{formatCount(exportPreview.count)} contatti corrispondenti ai filtri.</p>
          {exportPreview.sample.length ? (
            <div className="rpt-table-wrap">
              <table className="rpt-table">
                <thead>
                  <tr>
                    <th>Nome</th>
                    <th>Telefono</th>
                    <th>Esito</th>
                    <th>Fonte</th>
                  </tr>
                </thead>
                <tbody>
                  {exportPreview.sample.slice(0, 10).map((row) => (
                    <tr key={row.id}>
                      <td>{row.fullName || "-"}</td>
                      <td>{row.phone || "-"}</td>
                      <td>{row.closingOutcome}</td>
                      <td>{row.sourcePlatform || row.source || "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}
    </ReportSection>
  );
}
