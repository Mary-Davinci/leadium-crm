// Wire contract: https://github.com/3cx/call-control-service-example (types.ts).
// Notifications contain entity paths, not a completed-call payload.
export const MONITORED_DNS = ["901", "913", "910", "911", "912"] as const;
const allowed = new Set<string>(MONITORED_DNS);
export type Participant = {
  id: number; callid: number; legid?: number; dn: string; status: string;
  party_dn?: string; party_caller_id?: string; party_dn_type?: string;
  originated_by_dn?: string;
};
type Leg = { dn: string; status: string; active: boolean; endedAt?: string };
export type ObservedCall = {
  callId: string; startedAt: string; answeredAt?: string; endedAt?: string;
  direction?: "inbound" | "outbound"; customer?: string; agent?: string;
  legs: Record<string, Leg>; uncertain?: boolean; readyAt?: number;
};
export type FinalCallEvent = {
  callId: string; from: string; agent: string; direction?: string;
  startedAt: string; answeredAt?: string; endedAt: string; durationSeconds: number;
  disposition: "completed" | "no_answer"; eventType: string; note: string;
};
export type MonitorState = {
  calls: Record<string, ObservedCall>;
  finals: Record<string, { event: FinalCallEvent | null; delivered: boolean }>;
};
export const emptyMonitorState = (): MonitorState => ({ calls: {}, finals: {} });
export const legKey = (dn: string, id: number) => `${dn}/${id}`;

function externalNumber(value: unknown) {
  const raw = String(value || "").trim();
  if (!/^\+?[\d ()-]+$/.test(raw)) return null;
  const digits = raw.replace(/\D/g, "");
  // Internal DNs (including non-monitored ones), pseudo-parties and short codes aren't customers.
  if (digits.length < 7 || digits.length > 15 || allowed.has(digits)) return null;
  return (raw.startsWith("+") ? "+" : "") + digits;
}

export function observeParticipant(state: MonitorState, p: Participant, at: string, snapshot = false, dnType = "Extension") {
  if (!p || !allowed.has(p.dn) || !Number.isSafeInteger(p.id) || !Number.isSafeInteger(p.callid) || p.callid <= 0) return;
  const callId = String(p.callid);
  if (state.finals[callId]) return;
  const key = legKey(p.dn, p.id);
  // Participant identifiers may be reused; close its old association before adopting it.
  for (const old of Object.values(state.calls)) if (old.callId !== callId && old.legs[key]?.active) removeParticipant(state, p.dn, p.id, at);
  const call = state.calls[callId] ||= { callId, startedAt: at, legs: {} };
  if (!["Undefined", "Dialing", "Ringing", "Connected", "Hold", "Held"].includes(p.status)) call.uncertain = true;
  if (snapshot && !call.legs[key] && !["Dialing", "Ringing"].includes(p.status)) call.uncertain = true;
  call.legs[key] = { dn: p.dn, status: p.status, active: true };
  delete call.readyAt; delete call.endedAt;
  const direction = p.party_dn === "MakeCall" || p.originated_by_dn === p.dn || p.status === "Dialing" ? "outbound"
    : p.status === "Ringing" ? "inbound" : undefined;
  // A later queue/agent leg must not overwrite the initial external direction.
  if (!call.direction && direction) call.direction = direction;
  const party = call.direction === "outbound"
    ? externalNumber(p.party_dn) || externalNumber(p.party_caller_id)
    : externalNumber(p.party_caller_id) || externalNumber(p.party_dn);
  // Never treat an internal peer's caller-id as a customer; trunk/line peers may have a DN.
  if (!/^(Extension|Queue|RingGroup|RoutePoint)$/i.test(p.party_dn_type || "") && party) call.customer = party;
  const isAgent = dnType === "Extension";
  if (isAgent && (!call.agent || ["Connected", "Hold", "Held"].includes(p.status))) call.agent = p.dn;
  // Queue acceptance / music on hold is not the customer's conversation with an operator.
  if (isAgent && ["Connected", "Hold", "Held"].includes(p.status)) call.answeredAt ||= at;
}

export function removeParticipant(state: MonitorState, dn: string, id: number, at: string, uncertain = false) {
  const key = legKey(dn, id);
  for (const call of Object.values(state.calls)) {
    const leg = call.legs[key];
    if (!leg?.active) continue;
    leg.active = false; leg.endedAt = at;
    if (uncertain) call.uncertain = true;
    if (!Object.values(call.legs).some(item => item.active)) {
      call.endedAt = at;
      call.readyAt = Date.parse(at) + 3000; // allow a queue-to-agent handover to arrive
    }
  }
}

export function finalizeCalls(state: MonitorState, now: number) {
  for (const [id, call] of Object.entries(state.calls)) {
    if (!call.readyAt || call.readyAt > now || !call.endedAt || Object.values(call.legs).some(leg => leg.active)) continue;
    // Incomplete observations must not turn a lost connection into an invented missed call.
    const event: FinalCallEvent | null = !call.uncertain && call.customer ? {
      callId: call.callId, from: call.customer, agent: call.agent || Object.values(call.legs)[0].dn,
      direction: call.direction, startedAt: call.startedAt, answeredAt: call.answeredAt,
      endedAt: call.endedAt,
      durationSeconds: call.answeredAt ? Math.max(0, Math.round((Date.parse(call.endedAt) - Date.parse(call.answeredAt)) / 1000)) : 0,
      disposition: call.answeredAt ? "completed" : "no_answer", eventType: "call_control_final",
      note: "3CX Call Control: tempi osservati dal listener; durata dalla prima risposta osservata."
    } : null;
    state.finals[id] = { event, delivered: event === null };
    delete state.calls[id];
  }
}
