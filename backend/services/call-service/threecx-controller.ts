import { MonitorConfig } from "./threecx-monitor";
import { getMongoDb, isMongoEnabled } from "../common/mongo";
import fs from "node:fs/promises";

export class CallControlError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const agentDns = ["901", "913"];
export const transferDns = ["901", "913", "910", "911", "912"];
export function validateThreeCxDn(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || !agentDns.includes(value)) throw new CallControlError(400, "Interno 3CX non autorizzato.");
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

export type LiveCall = {
  callId: string; direction: "inbound" | "outbound"; customerPhone: string; agentDn: string;
  status: "ringing" | "connected" | "hold"; startedAt: string; answeredAt?: string;
  participantId: number; directControl: boolean;
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
  constructor(private config: MonitorConfig, private oauth: ThreeCxOAuth,
    private live: () => LiveCall[], private audit: (row: Audit) => Promise<void> = auditThreeCxAction,
    private http: typeof fetch = fetch, private timeoutMs = 10000) {}
  private async request(path: string, method: "GET" | "POST", body?: unknown) {
    if (!this.config.enabled) throw new CallControlError(503, "3CX momentaneamente non disponibile");
    try {
      const { token } = await this.oauth.get();
      const response = await this.http(this.config.baseUrl + path, {
        method, redirect: "error", signal: AbortSignal.timeout(this.timeoutMs),
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      if (!response.ok) {
        if (response.status === 401) this.oauth.clear();
        throw new CallControlError(response.status === 404 ? 409 : 503, response.status === 404 ? "Chiamata non più disponibile." : "3CX momentaneamente non disponibile");
      }
      const text = await response.text();
      if (!text && response.status === 202) return { accepted: true };
      const data = text ? JSON.parse(text) : {};
      if (method === "POST" && data.finalstatus !== "Success" && !(response.status === 202 && !data.finalstatus)) throw new CallControlError(409, "Operazione non accettata da 3CX.");
      return data;
    } catch (error) {
      if (error instanceof CallControlError) throw error;
      throw new CallControlError(503, "3CX momentaneamente non disponibile");
    }
  }
  async execute(actor: Actor, action: string, input: Record<string, unknown> = {}, callId?: string) {
    const dn = validateThreeCxDn(actor.threeCxDn);
    if (!actor.userId || !dn) throw new CallControlError(403, "Interno 3CX non configurato");
    if (!this.config.enabled || !this.config.configured) throw new CallControlError(503, "3CX momentaneamente non disponibile");
    const key = JSON.stringify([actor.userId, dn, action, callId, input]);
    for (const [id, row] of this.recent) if (row.expires <= Date.now()) this.recent.delete(id);
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
        if (Object.keys(input).some(key => key !== "phone")) throw new CallControlError(400, "Parametri chiamata non ammessi.");
        const destination = normalizeCallPhone(input.phone);
        const result = await this.request(`/callcontrol/${actor.threeCxDn}/makecall`, "POST", { destination });
        const id = Number.isSafeInteger(result.result?.callid) && result.result.callid > 0 ? String(result.result.callid) : null;
        await record("success", id);
        return { accepted: true, ...(id ? { callId: id } : {}) };
      }
      if (!["answer", "hangup", "transfer"].includes(action)) throw new CallControlError(422, "Azione non supportata dall’API 3CX documentata.");
      if (!callId || !/^\d+$/.test(callId)) throw new CallControlError(400, "Identificativo chiamata non valido.");
      if (Object.keys(input).some(key => action !== "transfer" || key !== "target")) throw new CallControlError(400, "Parametri chiamata non ammessi.");
      const matches = this.live().filter(call => call.callId === callId && call.agentDn === actor.threeCxDn);
      if (matches.length !== 1) throw new CallControlError(403, "Chiamata non disponibile per il tuo interno.");
      const call = matches[0];
      // Verify the participant again immediately before signaling, using only a known native ID.
      const participant = await this.request(`/callcontrol/${actor.threeCxDn}/participants/${call.participantId}`, "GET");
      if (participant.dn !== actor.threeCxDn || String(participant.callid) !== callId || participant.id !== call.participantId) throw new CallControlError(409, "Chiamata non più disponibile.");
      const status = participant.status === "Ringing" ? "ringing" : participant.status === "Connected" ? "connected" : ["Hold", "Held"].includes(participant.status) ? "hold" : null;
      if (!status) throw new CallControlError(409, "Stato chiamata non controllabile.");
      const caps = capabilities({ ...call, status, directControl: participant.direct_control === true });
      if (!caps[action as "answer" | "hangup" | "transfer"]) throw new CallControlError(409, "Azione non supportata dal dispositivo o dallo stato chiamata.");
      if (action === "transfer" && (typeof input.target !== "string" || !transferDns.includes(input.target) || input.target === actor.threeCxDn)) throw new CallControlError(400, "Destinazione trasferimento non autorizzata.");
      const providerAction = action === "hangup" ? "drop" : action === "transfer" ? "transferto" : "answer";
      await this.request(`/callcontrol/${actor.threeCxDn}/participants/${call.participantId}/${providerAction}`, "POST", action === "transfer" ? { destination: input.target, reason: "None", timeout: 30 } : {});
      await record("success");
      return { accepted: true };
    } catch (error) {
      await record("failure");
      if (error instanceof CallControlError) throw error;
      throw new CallControlError(503, "3CX momentaneamente non disponibile");
    }
  }
}
