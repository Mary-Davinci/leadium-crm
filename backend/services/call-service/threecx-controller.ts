import { MonitorConfig } from "./threecx-monitor";
import { getMongoDb, isMongoEnabled } from "../common/mongo";
import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { DEVICE_PSEUDONYM } from "./threecx-device-label";
import { isAgentDn, transferDns } from "./threecx-topology";

export class CallControlError extends Error {
  /** Reference of the makecall attempt, so a refused call can be found in the admin diagnostics. */
  attemptId?: string;
  constructor(public status: number, message: string) { super(message); }
}
export function validateThreeCxDn(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || !isAgentDn(value)) throw new CallControlError(400, "Interno 3CX non autorizzato.");
  return value;
}
export function normalizeCallPhone(value: unknown): string {
  if (typeof value !== "string" || !/^\+?[\d ()-]+$/.test(value.trim())) throw new CallControlError(400, "Numero telefonico non valido.");
  const raw = value.trim().replace(/[ ()-]/g, "");
  const phone = raw.startsWith("00") ? "+" + raw.slice(2) : raw;
  if (!/^\+?\d{7,15}$/.test(phone)) throw new CallControlError(400, "Numero telefonico non valido.");
  return phone;
}

/** Shared OAuth cache. Never serialized or exposed to the browser; no automatic mutation retry. */
export class ThreeCxOAuth {
  private cached = { token: "", expiresAt: 0 };
  private pending?: Promise<{ token: string; expiresAt: number }>;
  constructor(private config: MonitorConfig, private http: typeof fetch = fetch, private timeoutMs = 10000) {}
  async get() {
    if (!this.config.enabled || !this.config.configured) throw new CallControlError(503, "3CX momentaneamente non disponibile");
    if (this.cached.expiresAt > Date.now()) return this.cached;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      try {
        const secret = this.config.credential();
        if (!secret) throw new Error();
        const response = await this.http(this.config.baseUrl + "/connect/token", {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(this.timeoutMs),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "client_credentials", client_id: this.config.clientId, client_secret: secret })
        });
        if (!response.ok) throw new Error();
        const body = await response.json() as any;
        if (typeof body.access_token !== "string" || !body.access_token || !Number.isFinite(body.expires_in) || body.expires_in <= 0) throw new Error();
        return this.cached = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 800 };
      } catch { throw new CallControlError(503, "3CX momentaneamente non disponibile"); }
      finally { this.pending = undefined; }
    })();
    return this.pending;
  }
  clear() { this.cached = { token: "", expiresAt: 0 }; }
}

/**
 * Sanitized outbound attempt record for admin diagnostics. "accepted" only means 3CX
 * acknowledged the makecall request; it never proves the device or destination rang.
 * Destination keeps format, digit count and last two digits only; no token, device ID or body.
 */
export type CallAttempt = {
  attemptId: string; dn: string; at: string;
  outcome: "accepted" | "rejected_before_pbx" | "rejected_by_pbx" | "pbx_unreachable";
  code: string; httpStatus?: number; finalStatus?: string; deviceCount?: number;
  destination?: { format: "international" | "national"; digits: number; lastDigits: string };
  callId?: string; deviceMasked?: string; deviceSelection?: "explicit" | "only_device";
};
type CallTrace = { dn: string; firstSeenAt: string; lastSeenAt: string; steps: string[]; ended: boolean };
export type AttemptObserver = {
  trace(callId: string): CallTrace | null;
  between(dn: string, fromMs: number, toMs: number): Array<CallTrace & { callId: string }>;
};
/** Window in which the monitor is expected to report a placed call; later silence is still not proof. */
export const OBSERVATION_WINDOW_MS = 60000;
type UpstreamTrace = { httpStatus?: number; finalStatus?: string };
const safeToken = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_ -]{1,40}$/.test(value) ? value : value === undefined ? undefined : "unrecognized";
export const maskCallId = (id: string) => "***" + id.slice(-4);
export function describeDestination(phone: string): CallAttempt["destination"] {
  const digits = phone.replace(/\D/g, "");
  return { format: phone.startsWith("+") ? "international" : "national", digits: digits.length, lastDigits: digits.slice(-2) };
}

/**
 * Observed phase of the agent leg, derived only from PBX events:
 * incoming, callback_ringing (makecall rings the operator's own device first),
 * callback_answered, dialing_customer, connected (agent leg connected to the external party),
 * hold, other. connectedAt is the first observation of "connected", never the API acceptance.
 */
export type CallPhase = "incoming" | "callback_ringing" | "callback_answered" | "dialing_customer" | "connected" | "hold" | "other";
export type LiveCall = {
  callId: string; direction: "inbound" | "outbound"; customerPhone: string; agentDn: string;
  status: "ringing" | "connected" | "hold"; startedAt: string; answeredAt?: string;
  participantId: number; directControl: boolean; phase?: CallPhase; connectedAt?: string;
};
export function capabilities(call: LiveCall) {
  return { answer: call.status === "ringing" && call.direction === "inbound" && call.directControl,
    hangup: true, transfer: call.status === "connected", hold: false, resume: false };
}
type Actor = { userId: string; threeCxDn: string };
type Audit = Actor & { action: string; callId: string | null; timestamp: string; result: "attempted" | "success" | "failure" };
export async function auditThreeCxAction(row: Audit) {
  if (isMongoEnabled()) {
    const db = await getMongoDb();
    if (!db) throw new Error("Audit unavailable");
    await db.collection("threecxActions").insertOne(row);
  } else {
    const file = (process.env.JSON_DB_FILE || "data/db.json") + ".threecx-actions.ndjson";
    await fs.mkdir(require("node:path").dirname(file), { recursive: true });
    await fs.appendFile(file, JSON.stringify(row) + "\n", { mode: 0o600 });
  }
}

/** The only PBX action transport. The monitor continues to expose reads only. */
export class ThreeCxController {
  private recent = new Map<string, { key: string; expires: number; promise: Promise<any> }>();
  private active = new Set<string>();
  private rates = new Map<string, number[]>();
  private ownedCalls = new Map<string, { participantId?: number; ended: boolean; expires: number }>();
  private attempts: CallAttempt[] = [];
  /**
   * Admin projection: callId masked; observation comes from the monitor, never from the PBX
   * response. correlation says how sure the link is:
   * - callid: monitor trace with the native callid returned by makecall, on the same DN;
   * - callid_other_dn: same callid seen on another DN only (uncertain);
   * - probable_no_callid / ambiguous_no_callid: no callid returned, one / several traces on the
   *   DN right after the attempt (time-window guess, never certain);
   * - pending: inside the observation window, nothing yet;
   * - not_observed: nothing seen by this process; NOT proof that 3CX placed no call;
   * - not_applicable: the request never reached or was refused by the PBX.
   */
  recentAttempts(observer: AttemptObserver = { trace: () => null, between: () => [] }, now = Date.now()) {
    return this.attempts.map(({ callId, ...row }) => {
      const at = Date.parse(row.at), waiting = now - at < OBSERVATION_WINDOW_MS;
      if (row.outcome !== "accepted") return { ...row, correlation: "not_applicable" };
      if (callId) {
        const trace = observer.trace(callId);
        return { ...row, callId: maskCallId(callId), correlation: trace ? (trace.dn === row.dn ? "callid" : "callid_other_dn") : waiting ? "pending" : "not_observed", ...(trace ? { observation: trace } : {}) };
      }
      const candidates = observer.between(row.dn, at - 2000, at + OBSERVATION_WINDOW_MS);
      if (!candidates.length) return { ...row, correlation: waiting ? "pending" : "not_observed" };
      const [first] = candidates;
      return { ...row, correlation: candidates.length === 1 ? "probable_no_callid" : "ambiguous_no_callid", candidateCount: candidates.length,
        ...(candidates.length === 1 ? { observation: { dn: first.dn, firstSeenAt: first.firstSeenAt, lastSeenAt: first.lastSeenAt, steps: first.steps, ended: first.ended } } : {}) };
    });
  }
  private trackAttempt(row: CallAttempt) {
    this.attempts = [{ ...row }, ...this.attempts].slice(0, 25);
    // One sanitized line per attempt, so server logs can be matched with the 3CX call log.
    console.log(`[3cx] makecall attempt=${row.attemptId} dn=${row.dn} outcome=${row.outcome} code=${row.code} http=${row.httpStatus ?? "-"} final=${row.finalStatus ?? "-"} devices=${row.deviceCount ?? "-"} dest=${row.destination ? `${row.destination.format}/${row.destination.digits}d/..${row.destination.lastDigits}` : "-"} callId=${row.callId ? maskCallId(row.callId) : "-"}`);
  }
  constructor(private config: MonitorConfig, private oauth: ThreeCxOAuth,
    private live: () => LiveCall[], private audit: (row: Audit) => Promise<void> = auditThreeCxAction,
    private http: typeof fetch = fetch, private timeoutMs = 10000,
    private devices: (dn: string) => readonly string[] | null = () => null,
    private maskDevice: (deviceId: string) => string = () => "device-unknown",
    private noteMakecall: (callId: string) => void = () => {}) {}
  private async request(path: string, method: "GET" | "POST", body?: unknown, missingIsEnded = false, acknowledgement = false, trace?: UpstreamTrace) {
    if (!this.config.enabled) throw new CallControlError(503, "3CX momentaneamente non disponibile");
    try {
      const { token } = await this.oauth.get();
      const response = await this.http(this.config.baseUrl + path, {
        method, redirect: "error", signal: AbortSignal.timeout(this.timeoutMs),
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      if (trace) trace.httpStatus = response.status;
      if (!response.ok) {
        if (missingIsEnded && response.status === 404) return null;
        if (response.status === 401) this.oauth.clear();
        throw new CallControlError(response.status === 404 ? 409 : 503, response.status === 404 ? "Chiamata non più disponibile." : "3CX momentaneamente non disponibile");
      }
      const text = await response.text();
      if (!text && response.status === 202) return { accepted: true };
      const data = text ? JSON.parse(text) : {};
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
      if (trace) trace.finalStatus = safeToken(data.finalstatus);
      if (method === "POST" && (![200, 202].includes(response.status)
        || (data.finalstatus !== undefined ? data.finalstatus !== "Success" : !acknowledgement && response.status !== 202))) throw new CallControlError(409, "Operazione non accettata da 3CX.");
      return data;
    } catch (error) {
      if (error instanceof CallControlError) throw error;
      throw new CallControlError(503, "3CX momentaneamente non disponibile");
    }
  }
  private async currentHangupParticipant(dn: string, callId: string): Promise<number | null> {
    const snapshot = await this.request(`/callcontrol/${dn}`, "GET");
    if (snapshot?.dn !== dn || !Array.isArray(snapshot.participants)
      || snapshot.participants.some((p: any) => !p || !Number.isSafeInteger(p.id) || p.id < 0
        || !Number.isSafeInteger(p.callid) || p.callid <= 0 || (p.dn !== undefined && p.dn !== dn))) throw new CallControlError(409, "Stato chiamata non disponibile.");
    const current = snapshot.participants.filter((p: any) => String(p.callid) === callId);
    if (current.length > 1) throw new CallControlError(409, "Chiamata ambigua per il tuo interno.");
    return current[0]?.id ?? null;
  }
  async execute(actor: Actor, action: string, input: Record<string, unknown> = {}, callId?: string) {
    const dn = validateThreeCxDn(actor.threeCxDn);
    if (!actor.userId || !dn) throw new CallControlError(403, "Interno 3CX non configurato");
    if (!this.config.enabled || !this.config.configured) throw new CallControlError(503, "3CX momentaneamente non disponibile");
    const key = JSON.stringify([actor.userId, dn, action, callId, input]);
    for (const [id, row] of this.recent) if (row.expires <= Date.now()) this.recent.delete(id);
    for (const [id, row] of this.ownedCalls) if (row.expires <= Date.now()) this.ownedCalls.delete(id);
    const previous = this.recent.get(key);
    if (previous && previous.expires > Date.now()) {
      return previous.promise;
    }
    if (this.active.has(dn)) throw new CallControlError(429, "Attendi prima di inviare un altro comando 3CX.");
    const times = (this.rates.get(dn) || []).filter(time => Date.now() - time < 60000);
    if (times.length >= 12) throw new CallControlError(429, "Troppi comandi 3CX. Riprova tra un minuto.");
    times.push(Date.now()); this.rates.set(dn, times);
    this.active.add(dn);
    const promise = this.perform(actor, action, input, callId);
    const entry = { key, expires: Infinity, promise };
    this.recent.set(key, entry);
    // Rejections are also retained briefly: a lost response must not redial automatically.
    void promise.then(() => { this.active.delete(dn); entry.expires = Date.now() + 5000; }, () => { this.active.delete(dn); entry.expires = Date.now() + 5000; });
    return promise;
  }
  private async perform(actor: Actor, action: string, input: Record<string, unknown>, callId?: string) {
    const record = async (result: Audit["result"], id = callId || null) => {
      try { await this.audit({ ...actor, action, callId: id, timestamp: new Date().toISOString(), result }); }
      catch { throw new CallControlError(503, "Audit chiamate non disponibile. Riprova più tardi."); }
    };
    // Fail closed if the audit cannot be written before a PBX action.
    await record("attempted");
    try {
      if (action === "call") {
        const attempt: CallAttempt = { attemptId: randomBytes(4).toString("hex"), dn: actor.threeCxDn, at: new Date().toISOString(), outcome: "rejected_before_pbx", code: "invalid_input" };
        const upstream: UpstreamTrace = {};
        let requested = false;
        try {
          if (Object.keys(input).some(key => key !== "phone" && key !== "device")) throw new CallControlError(400, "Parametri chiamata non ammessi.");
          // The client may only name a device by its pseudonym; it is resolved against the DN's
          // current registrations here, so a stale or foreign choice can never be dialed.
          if (input.device !== undefined && (typeof input.device !== "string" || !DEVICE_PSEUDONYM.test(input.device))) throw new CallControlError(400, "Dispositivo 3CX non valido.");
          const destination = normalizeCallPhone(input.phone);
          attempt.destination = describeDestination(destination);
          const devices = this.devices(actor.threeCxDn);
          if (devices !== null) attempt.deviceCount = devices.length;
          attempt.code = devices === null ? "devices_unknown" : devices.length === 0 ? "no_device" : "invalid_device";
          if (devices === null) throw new CallControlError(503, "Dispositivi 3CX non ancora disponibili. Riprova tra poco.");
          if (devices.length === 0) throw new CallControlError(409, "Nessun dispositivo 3CX registrato per questo interno.");
          let deviceId: string;
          if (typeof input.device === "string") {
            const chosen = devices.filter(id => { try { return this.maskDevice(id) === input.device; } catch { return false; } });
            if (chosen.length !== 1) { attempt.code = "device_unavailable"; throw new CallControlError(409, "Il dispositivo scelto non e piu collegato al tuo interno. Scegli di nuovo."); }
            deviceId = chosen[0]; attempt.deviceSelection = "explicit";
          } else if (devices.length === 1) {
            deviceId = devices[0]; attempt.deviceSelection = "only_device";
          } else {
            attempt.code = "multiple_devices";
            throw new CallControlError(409, "Più dispositivi 3CX disponibili. Selezione dispositivo necessaria.");
          }
          try { attempt.deviceMasked = this.maskDevice(String(deviceId)); } catch { /* diagnostics only */ }
          if (typeof deviceId !== "string" || !deviceId.trim() || deviceId.length > 4096 || [".", ".."].includes(deviceId) || /[\u0000-\u001f\u007f]/.test(deviceId)) throw new CallControlError(503, "Dispositivi 3CX non ancora disponibili. Riprova tra poco.");
          requested = true;
          const result = await this.request(`/callcontrol/${actor.threeCxDn}/devices/${encodeURIComponent(deviceId)}/makecall`, "POST", { destination, timeout: 30 }, false, true, upstream);
          const id = Number.isSafeInteger(result.result?.callid) && result.result.callid > 0 ? String(result.result.callid) : null;
          const participant = result.result;
          if ((participant?.dn !== undefined && participant.dn !== actor.threeCxDn) || (participant?.device_id !== undefined && participant.device_id !== deviceId)) {
            attempt.code = "inconsistent_response";
            throw new CallControlError(409, "Risposta chiamata 3CX non coerente con il dispositivo richiesto.");
          }
          // Before answering the client: the monitor reads phases of this call from now on.
          if (id) this.noteMakecall(id);
          if (id) this.ownedCalls.set(`${actor.threeCxDn}:${id}`, {
            ...(Number.isSafeInteger(participant?.id) && participant.id >= 0 ? { participantId: participant.id } : {}),
            ended: false, expires: Date.now() + 600000
          });
          // An empty 202 or a body without callid is still only an acknowledgement.
          Object.assign(attempt, { outcome: "accepted", code: id ? "accepted_with_callid" : "accepted_without_callid", ...upstream, ...(id ? { callId: id } : {}) });
          this.trackAttempt(attempt);
          await record("success", id);
          return { accepted: true, attemptId: attempt.attemptId, ...(id ? { callId: id } : {}) };
        } catch (error) {
          if (attempt.outcome !== "accepted") {
            Object.assign(attempt, upstream);
            if (requested && attempt.code !== "inconsistent_response") {
              attempt.outcome = upstream.httpStatus === undefined ? "pbx_unreachable" : "rejected_by_pbx";
              attempt.code = upstream.httpStatus === undefined ? "no_http_response" : upstream.httpStatus >= 400 ? `http_${upstream.httpStatus}` : upstream.finalStatus ? "final_status_not_success" : "unexpected_response";
            } else if (requested) attempt.outcome = "rejected_by_pbx";
            this.trackAttempt(attempt);
          }
          if (error instanceof CallControlError) error.attemptId = attempt.attemptId;
          throw error;
        }
      }
      if (!["answer", "hangup", "transfer"].includes(action)) throw new CallControlError(422, "Azione non supportata dall’API 3CX documentata.");
      if (!callId || !/^\d+$/.test(callId)) throw new CallControlError(400, "Identificativo chiamata non valido.");
      if (Object.keys(input).some(key => action !== "transfer" || key !== "target")) throw new CallControlError(400, "Parametri chiamata non ammessi.");
      const matches = this.live().filter(call => call.callId === callId && call.agentDn === actor.threeCxDn);
      const ownershipKey = `${actor.threeCxDn}:${callId}`;
      const owned = this.ownedCalls.get(ownershipKey);
      const ended = async () => {
        this.ownedCalls.set(ownershipKey, { ended: true, expires: Date.now() + 600000 });
        await record("success"); return { accepted: true, alreadyEnded: true };
      };
      if (matches.length > 1) throw new CallControlError(409, "Chiamata ambigua per il tuo interno.");
      if (!matches.length && !(action === "hangup" && owned)) throw new CallControlError(403, "Chiamata non disponibile per il tuo interno.");
      if (!matches.length && owned?.ended) return ended();
      let participantId: number | null = matches[0]?.participantId ?? null;
      if (action === "hangup") {
        // An initiator or live-cache participant may have been replaced. Read the
        // current DN before selecting any participant, never use the response ID blindly.
        participantId = await this.currentHangupParticipant(actor.threeCxDn, callId);
        if (participantId === null) return ended();
      }
      if (participantId === null || !Number.isSafeInteger(participantId) || participantId < 0) throw new CallControlError(409, "Stato chiamata non disponibile.");
      // Verify the participant again immediately before signaling, using only a known native ID.
      const participant = await this.request(`/callcontrol/${actor.threeCxDn}/participants/${participantId}`, "GET", undefined, action === "hangup");
      if (participant === null && action === "hangup") {
        if (await this.currentHangupParticipant(actor.threeCxDn, callId) !== null) throw new CallControlError(409, "Stato chiamata aggiornato. Riprova.");
        return ended();
      }
      if (participant.dn !== actor.threeCxDn || String(participant.callid) !== callId || participant.id !== participantId) throw new CallControlError(409, "Chiamata non più disponibile.");
      const status = participant.status === "Ringing" || (action === "hangup" && participant.status === "Dialing") ? "ringing" : participant.status === "Connected" ? "connected" : ["Hold", "Held"].includes(participant.status) ? "hold" : null;
      if (!status) throw new CallControlError(409, "Stato chiamata non controllabile.");
      if (action !== "hangup" && !capabilities({ ...matches[0], status, directControl: participant.direct_control === true })[action as "answer" | "transfer"]) throw new CallControlError(409, "Azione non supportata dal dispositivo o dallo stato chiamata.");
      if (action === "transfer" && (typeof input.target !== "string" || !transferDns().includes(input.target) || input.target === actor.threeCxDn)) throw new CallControlError(400, "Destinazione trasferimento non autorizzata.");
      const providerAction = action === "hangup" ? "drop" : action === "transfer" ? "transferto" : "answer";
      const result = await this.request(`/callcontrol/${actor.threeCxDn}/participants/${participantId}/${providerAction}`, "POST", action === "transfer" ? { destination: input.target, reason: "None", timeout: 30 } : {}, action === "hangup");
      if (action === "hangup") {
        if (result === null && await this.currentHangupParticipant(actor.threeCxDn, callId) !== null) throw new CallControlError(409, "Stato chiamata aggiornato. Riprova.");
        this.ownedCalls.set(ownershipKey, { ended: true, expires: Date.now() + 600000 });
        if (result === null) return ended();
      }
      await record("success");
      return { accepted: true };
    } catch (error) {
      await record("failure");
      if (error instanceof CallControlError) throw error;
      throw new CallControlError(503, "3CX momentaneamente non disponibile");
    }
  }
}
