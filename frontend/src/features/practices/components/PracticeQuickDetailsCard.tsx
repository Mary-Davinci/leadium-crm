type Props = {
  statusLabel: string;
  priorityLabel: string;
  statusTime: string;
  priorityTime: string;
};

export function PracticeQuickDetailsCard({ statusLabel, priorityLabel, statusTime, priorityTime }: Props) {
  return (
    <section className="pd-card pd-card-quick">
      <h5>Dettagli rapidi</h5>
      <div className="pd-quick-items">
        <article>
          <strong>📌 {statusLabel}</strong>
          <span>{statusTime}</span>
        </article>
        <article>
          <strong>🎯 {priorityLabel}</strong>
          <span>{priorityTime}</span>
        </article>
      </div>
    </section>
  );
}
