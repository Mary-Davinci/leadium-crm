import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

type ReportKpiCardProps = {
  icon: LucideIcon;
  tone?: "neutral" | "info" | "success" | "warning" | "danger";
  label: string;
  value?: string;
  meta?: string;
  detail?: string;
  children?: ReactNode;
};

export function ReportKpiCard({ icon: Icon, tone = "neutral", label, value, meta, detail, children }: ReportKpiCardProps) {
  return (
    <article className={`rpt-kpi rpt-tone-${tone}`}>
      <span className="rpt-kpi-icon" aria-hidden="true">
        <Icon size={17} />
      </span>
      <span className="rpt-kpi-label">{label}</span>
      {value !== undefined ? <strong className="rpt-kpi-value">{value}</strong> : null}
      {detail ? <span className="rpt-kpi-detail">{detail}</span> : null}
      {meta ? <span className="rpt-kpi-meta">{meta}</span> : null}
      {children}
    </article>
  );
}
