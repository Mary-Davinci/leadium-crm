import type { ReactNode } from "react";

type ReportSectionProps = {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
};

export function ReportSection({ eyebrow, title, description, actions, children }: ReportSectionProps) {
  return (
    <section className="rpt-section">
      <header className="rpt-section-head">
        <div>
          {eyebrow ? <span className="rpt-section-eyebrow">{eyebrow}</span> : null}
          <h2 className="rpt-section-title">{title}</h2>
          {description ? <p className="rpt-section-desc">{description}</p> : null}
        </div>
        {actions ? <div className="rpt-section-actions">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}
