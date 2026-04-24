import { NextActionMeta } from "../practice-detail.types";

type Props = {
  title: string;
  nextActionDate: string;
  company: string;
  nextMeta: NextActionMeta;
};

export function PracticeOverviewCard({ title, nextActionDate, company, nextMeta }: Props) {
  return (
    <section className="pd-card pd-card-practice">
      <h5>Dettagli pratica</h5>
      <div className="pd-practice-line">
        <strong>{title}</strong>
      </div>
      <div className="pd-practice-line muted">Prossima azione: {nextActionDate}</div>
      <div className="pd-practice-grid">
        <p>
          <span>Crociera</span>
          <strong>{title || "Da definire"}</strong>
        </p>
        <p>
          <span>Data partenza</span>
          <strong>{nextActionDate}</strong>
        </p>
        <p>
          <span>Compagnia</span>
          <strong>{company || "MSC/Costa"}</strong>
        </p>
        <p>
          <span>Cabina</span>
          <strong>In definizione</strong>
        </p>
      </div>
      <div className={`pd-next pd-next-inline ${nextMeta.className}`}>
        <strong>{nextMeta.label}</strong>
        <span>{nextMeta.detail}</span>
      </div>
    </section>
  );
}
