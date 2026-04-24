import { TimelineItem } from "../practice-detail.types";
import { getTimelineLabel, getTimelineMeta } from "../practice-detail.utils";

type Props = {
  timeline: TimelineItem[];
};

export function PracticeTimelineCard({ timeline }: Props) {
  return (
    <section className="pd-card pd-timeline pd-card-timeline">
      <h5>Timeline pratica</h5>
      {timeline.length ? (
        timeline.slice(0, 8).map((item, idx) => {
          const meta = getTimelineMeta(item.type);
          return (
            <article key={`${item.createdAt}-${idx}`} className={`pd-timeline-item pd-timeline-${meta.className}`}>
              <div>
                <strong>
                  {meta.icon} {getTimelineLabel(item.type)}
                </strong>
                <span>{new Date(item.createdAt).toLocaleString("it-IT")}</span>
              </div>
              <p>{item.text}</p>
            </article>
          );
        })
      ) : (
        <p className="muted">Nessuna attività disponibile.</p>
      )}
    </section>
  );
}
