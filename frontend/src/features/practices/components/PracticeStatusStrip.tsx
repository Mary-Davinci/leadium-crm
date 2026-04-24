type Props = {
  status: string;
  priority: string;
  nextAction: string;
};

export function PracticeStatusStrip({ status, priority, nextAction }: Props) {
  return (
    <section className="pd-status-strip">
      <article>
        <span>Stato</span>
        <strong>{status}</strong>
      </article>
      <article>
        <span>Priorità</span>
        <strong>{priority}</strong>
      </article>
      <article>
        <span>Prossima azione</span>
        <strong>{nextAction}</strong>
      </article>
    </section>
  );
}
