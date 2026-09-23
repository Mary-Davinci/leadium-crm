import { MarketingExportPanel } from "../features/reports/components/MarketingExportPanel";
import { ReportTabs } from "../features/reports/components/ReportTabs";
import "../styles/report-page.css";

export function MarketingReportPage() {
  return (
    <div className="rpt-page">
      <ReportTabs />

      <header className="rpt-head">
        <div>
          <span className="rpt-eyebrow">Controllo operativo</span>
          <h1>Marketing</h1>
          <p>Export dei contatti chiusi o persi per remarketing.</p>
        </div>
      </header>

      <MarketingExportPanel />
    </div>
  );
}
