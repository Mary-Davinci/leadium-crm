import { CrmTask } from "../../../store/crm-store";
import { LeadDetail } from "../pratiche.types";
import { formatDate, getStatusClass, getStatusLabel, getTimelineLabel, getTimelineMeta } from "../pratiche.utils";

export type PracticesQuickDetailProps = {
  detail: LeadDetail | null;
  linkedTask?: CrmTask | null;
  loading: boolean;
  onOpenFullDetail: (id: string) => void;
};

function getQuickCallOutcomeLabel(outcome: string) {
  if (outcome === "completed") return "Completata";
  if (outcome === "no_answer") return "Nessuna risposta";
  if (outcome === "busy") return "Occupato";
  if (outcome === "call_back") return "Da richiamare";
  if (outcome === "interested") return "Interessato";
  if (outcome === "not_interested") return "Non interessato";
  return outcome;
}

function getTaskKindLabel(kind: string) {
  const value = String(kind || "").toLowerCase();
  if (value.includes("payment") || value.includes("saldo")) return "Pagamento";
  if (value.includes("document")) return "Documenti";
  if (value.includes("call") || value.includes("richiamo")) return "Richiamo";
  if (value.includes("follow")) return "Follow-up";
  if (value.includes("next_action")) return "Task principale";
  return "Task operativo";
}

function getTaskUrgencyLabel(task: CrmTask) {
  if (task.status === "done") return "Completato";
  if (!task.dueAt) return "Da pianificare";
  const due = new Date(task.dueAt);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate()).getTime();
  if (due.getTime() < now.getTime()) return "Scaduto";
  if (dueDay === today) return "Oggi";
  return "Pianificato";
}

export function PracticesQuickDetail({ detail, linkedTask, loading, onOpenFullDetail }: PracticesQuickDetailProps) {
  const recentCalls = (detail?.callLogs || []).slice(0, 3);

  return (
    <>
      <h3>Dettaglio rapido</h3>
      {loading ? (
        <p className="muted">Caricamento dettaglio...</p>
      ) : !detail ? (
        <p className="muted">Seleziona una pratica per vedere dettaglio, timeline e prossime azioni.</p>
      ) : (
        <div className="pr-quick-detail">
          <section className="pr-quick-head">
            <h4>{detail.lead.fullName}</h4>
            <p>{detail.lead.phone}</p>
            <span className={`pr-status pr-quick-status ${getStatusClass(detail.lead.status)}`}>
              {getStatusLabel(detail.lead.status)}
            </span>
          </section>

          {detail.lead.notes?.trim() ? (
            <section className="pr-quick-box pr-missing-box">
              <h5>Cosa manca</h5>
              <p>{detail.lead.notes}</p>
            </section>
          ) : null}

          <section className="pr-quick-box">
            <h5>{linkedTask ? "Task principale" : "Prossima azione"}</h5>
            {linkedTask ? (
              <>
                <p>{linkedTask.title}</p>
                <p>
                  {getTaskKindLabel(linkedTask.kind)} · {getTaskUrgencyLabel(linkedTask)}
                </p>
                <p>Scadenza: {linkedTask.dueAt ? new Date(linkedTask.dueAt).toLocaleString("it-IT") : "Da pianificare"}</p>
              </>
            ) : (
              <p>{formatDate(detail.lead.nextActionAt)}</p>
            )}
          </section>

          <section className="pr-quick-box">
            <h5>Ultime attività</h5>
            <div className="pr-mini-timeline">
              {(detail.timeline || [])
                .slice()
                .reverse()
                .slice(0, 4)
                .map((item, index) => {
                  const timeline = getTimelineMeta(item.type);
                  return (
                    <article key={`${item.createdAt}-${index}`} className={`pr-timeline-${timeline.className}`}>
                      <strong>
                        {timeline.icon} {getTimelineLabel(item.type)}
                      </strong>
                      <span>{new Date(item.createdAt).toLocaleString("it-IT")}</span>
                      <p>{item.text}</p>
                    </article>
                  );
                })}
            </div>
          </section>

          {recentCalls.length ? (
            <section className="pr-quick-box">
              <h5>Ultime chiamate</h5>
              <div className="pr-mini-timeline">
                {recentCalls.map((call) => (
                  <article
                    key={call.id}
                    className={`pr-timeline-${
                      call.outcome === "completed" || call.outcome === "interested"
                        ? "task"
                        : call.outcome === "call_back" || call.outcome === "busy"
                          ? "status"
                          : "call"
                    }`}
                  >
                    <strong>📞 {getQuickCallOutcomeLabel(call.outcome)}</strong>
                    <span>{new Date(call.startedAt).toLocaleString("it-IT")}</span>
                    {call.note ? <p>{call.note}</p> : null}
                  </article>
                ))}
              </div>
            </section>
          ) : null}

          <button type="button" onClick={() => onOpenFullDetail(detail.lead.id)}>
            Apri dettaglio completo
          </button>
        </div>
      )}
    </>
  );
}
