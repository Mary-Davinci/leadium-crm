import { Link } from "react-router-dom";
import { NextActionMeta } from "../practice-detail.types";

type Props = {
  fullName: string;
  phone: string;
  statusLabel: string;
  statusClass: string;
  priorityLabel: string;
  priorityClass: string;
  nextMeta: NextActionMeta;
  primaryTaskLabel: string;
  primaryTaskDueAt: string;
  busy: boolean;
  onComplete: () => void;
  onReschedule: () => void;
};

export function PracticeHero({
  fullName,
  phone,
  statusLabel,
  statusClass,
  priorityLabel,
  priorityClass,
  nextMeta,
  primaryTaskLabel,
  primaryTaskDueAt,
  busy,
  onComplete,
  onReschedule
}: Props) {
  return (
    <section className="pd-top-hero">
      <div className="pd-hero-main">
        <h4>{fullName}</h4>
        <p className="pd-sub">{phone}</p>
        <div className="pd-badges">
          <span className={`pd-status ${statusClass}`}>{statusLabel}</span>
          <span className={`pd-priority ${priorityClass}`}>{priorityLabel}</span>
        </div>
      </div>
      <Link className="pd-back-btn" to="/pratiche">
        Torna a pratiche
      </Link>
      <div className={`pd-next ${nextMeta.className}`}>
        <strong>⚠ {nextMeta.label.replace(/^[🟢🟡🔴⚠]\s?/u, "")}</strong>
        <span>{nextMeta.detail}</span>
      </div>
      <div className={`pd-next-action-focus ${nextMeta.className}`}>
        <div>
          <h5>{nextMeta.label}</h5>
          <p>{primaryTaskLabel}</p>
          <small>Scadenza: {primaryTaskDueAt}</small>
        </div>
        <div className="pd-next-actions">
          <button type="button" disabled={busy} onClick={onComplete}>
            Completa
          </button>
          <button type="button" className="secondary" disabled={busy} onClick={onReschedule}>
            Riprogramma
          </button>
        </div>
      </div>
    </section>
  );
}
