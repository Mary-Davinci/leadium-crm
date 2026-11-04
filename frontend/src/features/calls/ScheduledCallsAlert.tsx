import { useCallback, useEffect, useMemo, useState } from "react";
import { BellRing, ExternalLink, Phone } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import { getAuthUser } from "../../lib/auth";
import { buildPracticeUrl } from "../practices/practice-links";
import type { CrmTask } from "../../store/crm-store";
import { useThreeCx } from "./threecx-context";
import { actorKeys, describeDue, readSnoozes, selectScheduledCalls, snoozeKey, SNOOZE_MS, writeSnoozes, type ScheduledCall, type ScheduledCallLead, type Snoozes } from "./scheduled-calls";

const REFRESH_MS = 60_000;
const CLOCK_MS = 30_000;

type CardsProps = { calls: ScheduledCall[]; now: number; canDial: boolean; onCall(call: ScheduledCall): void; onSnooze(call: ScheduledCall): void };

export function ScheduledCallCards({ calls, now, canDial, onCall, onSnooze }: CardsProps) {
  if (!calls.length) return null;
  return (
    <aside className="sc-alert" aria-label="Chiamate programmate" aria-live="polite">
      {calls.slice(0, 3).map((call) => {
        const due = describeDue(call.dueAt, now);
        return (
          <section key={snoozeKey(call)} className={`sc-alert-card${due.late ? " is-late" : ""}`}>
            <p className="sc-alert-kicker"><BellRing size={13} aria-hidden="true" /> Chiamata programmata</p>
            <strong>{call.customerName}</strong>
            <span className="sc-alert-time">{due.label}</span>
            <div className="sc-alert-actions">
              {canDial && call.phone ? (
                <button type="button" className="sc-alert-primary" onClick={() => onCall(call)}><Phone size={14} aria-hidden="true" />Chiama</button>
              ) : null}
              <Link className="sc-alert-link" to={buildPracticeUrl(call.leadId)}><ExternalLink size={13} aria-hidden="true" />Apri pratica</Link>
              <button type="button" className="sc-alert-quiet" onClick={() => onSnooze(call)}>Ricordamelo tra 10 min</button>
            </div>
          </section>
        );
      })}
      {calls.length > 3 ? <p className="sc-alert-more">Altre {calls.length - 3} chiamate da fare</p> : null}
    </aside>
  );
}

/** Reminds the signed-in operator of their calls while Leadium is open, on any page. */
export function ScheduledCallsAlert() {
  const threeCx = useThreeCx();
  const keys = useMemo(() => actorKeys(getAuthUser()), []);
  const [board, setBoard] = useState<{ tasks: CrmTask[]; leads: ScheduledCallLead[] }>({ tasks: [], leads: [] });
  const [now, setNow] = useState(Date.now());
  const [snoozes, setSnoozes] = useState<Snoozes>(() => readSnoozes(Date.now()));

  const refresh = useCallback(async () => {
    try {
      const data = await api<{ tasks: CrmTask[]; leads: ScheduledCallLead[] }>("/api/tasks/board?status=open");
      setBoard({ tasks: Array.isArray(data.tasks) ? data.tasks : [], leads: Array.isArray(data.leads) ? data.leads : [] });
    } catch { /* the next round retries: a reminder must never disturb the page it sits on */ }
  }, []);

  useEffect(() => {
    void refresh();
    const reload = window.setInterval(() => void refresh(), REFRESH_MS);
    const clock = window.setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => { window.clearInterval(reload); window.clearInterval(clock); };
  }, [refresh]);

  function snooze(call: ScheduledCall) {
    const moment = Date.now();
    const next = { ...readSnoozes(moment), [snoozeKey(call)]: moment + SNOOZE_MS };
    writeSnoozes(next);
    setSnoozes(next);
    setNow(moment);
  }

  const calls = useMemo(() => selectScheduledCalls(board.tasks, board.leads, keys, snoozes, now), [board, keys, snoozes, now]);
  return <ScheduledCallCards calls={calls} now={now} canDial={Boolean(threeCx.dn)} onSnooze={snooze} onCall={(call) => {
    // The card steps aside during the call; if the outcome is not recorded it comes back.
    snooze(call);
    void threeCx.dial(call.phone, { leadId: call.leadId, customerName: call.customerName });
  }} />;
}
