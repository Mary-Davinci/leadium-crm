import WebSocket from "ws";
import { MONITORED_DNS, emptyMonitorState, finalizeCalls, legKey, markCallIncomplete, MonitorState, observeParticipant, removeParticipant } from "./threecx-normalizer";
import { MonitorStore } from "./threecx-store";
import type { CallPhase, LiveCall } from "./threecx-controller";
import { classifyMonitoredDn } from "./threecx-normalizer";
import { ThreeCxDeviceDiagnostics } from "./threecx-device-diagnostics";
import { deviceLabel } from "./threecx-device-label";

/** Peer class of an agent leg: the makecall callback, an external number, an internal DN. */
function peerClass(p: any) {
  const party = String(p?.party_dn || "");
  return party === "MakeCall" ? "makecall_callback" : /^\+?[\d ()-]{7,}$/.test(party || String(p?.party_caller_id || "")) ? "external"
    : /^\d{2,6}$/.test(party) ? "internal" : party ? "other" : "none";
}

export type MonitorConfig = { enabled: boolean; baseUrl: string; clientId: string; configured: boolean; credential: () => string };
export function monitorConfig(env: NodeJS.ProcessEnv = process.env): MonitorConfig {
  const enabled = env.THREECX_ENABLED === "true";
  let baseUrl = "";
  try { const url = new URL(env.THREECX_BASE_URL || ""); if (url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash) baseUrl = url.origin; } catch { /* invalid config */ }
  const clientId = String(env.THREECX_CLIENT_ID || "").trim();
  return { enabled, baseUrl, clientId, configured: Boolean(baseUrl && clientId && Object.prototype.hasOwnProperty.call(env, "THREECX_API_KEY")),
    // No key value is read at all until the explicitly enabled listener authenticates.
    credential: () => enabled ? String(env.THREECX_API_KEY || "") : "" };
}
type Socket = Pick<WebSocket, "on" | "once" | "close" | "terminate" | "ping" | "readyState">;
type Dependencies = {
  store: MonitorStore;
  deliver: (event: any, signal: AbortSignal) => Promise<void>;
  fetch?: typeof fetch;
  socket?: (url: string, token: string) => Socket;
  now?: () => number;
  oauth?: { get(): Promise<{ token: string; expiresAt: number }> };
  retryMs?: number; tickMs?: number; timeoutMs?: number;
};
const allowed = new Set<string>(MONITORED_DNS);
// Only locally constructed messages can reach diagnostics; never a provider response body.
class MonitorReadError extends Error {}
const failureMessages = {
  checkpoint_claim_failed: "3CX checkpoint unavailable",
  authentication_failed: "3CX authentication failed",
  websocket_connect_failed: "3CX WebSocket connection failed",
  initial_reconcile_failed: "3CX initial reconcile failed",
  checkpoint_save_failed: "3CX checkpoint unavailable",
  monitor_transport_failed: "3CX monitoring transport failed"
} as const;
type FailureStage = keyof typeof failureMessages;
class MonitorStageError extends Error {
  constructor(stage: FailureStage) { super(`${failureMessages[stage]} [${stage}]`); }
}
async function atStage<T>(stage: FailureStage, work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) { throw error instanceof MonitorStageError ? error : new MonitorStageError(stage); }
}
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  if (signal.aborted) return resolve();
  const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
  const timer = setTimeout(done, ms); signal.addEventListener("abort", done, { once: true });
});

/** This transport has no API for PBX actions. Its only POST is OAuth authentication. */
export class ThreeCxMonitor {
  private state: MonitorState = emptyMonitorState();
  private abort = new AbortController();
  private socket: Socket | null = null;
  private task: Promise<void> | null = null;
  private queue = Promise.resolve();
  private lease = false;
  private token = "";
  private expiresAt = 0;
  private sequence: number | null = null;
  private dnTypes = new Map<string, string>();
  private deviceDiagnostics = new ThreeCxDeviceDiagnostics();
  // Raw device IDs stay server-side, separate from the sanitized admin projection.
  private controlDevices = new Map<string, { ids: string[]; agents: Map<string, string>; observedAt: number }>();
  private liveParticipants = new Map<string, { id: number; callid: number; dn: string; direct_control: boolean; peer?: string }>();
  private now: () => number;
  private http: typeof fetch;
  private deliveryRetryAt = 0;
  private deliveryFailures = 0;
  private status = { connected: false, lastConnectedAt: null as string | null, lastEventAt: null as string | null, lastCallId: null as string | null, lastError: null as string | null };

  constructor(private config: MonitorConfig, private deps: Dependencies) { this.now = deps.now || Date.now; this.http = deps.fetch || fetch; }
  diagnostics() {
    // Temporary admin-only projection of already-read DN types. No extra PBX request,
    // classification/normalization, raw DN response or participant data is exposed.
    const observedDnTypes = Object.fromEntries(MONITORED_DNS
      .filter(dn => this.dnTypes.has(dn))
      .map(dn => [dn, this.dnTypes.get(dn)!]));
    return { enabled: this.config.enabled, configured: this.config.configured, ...this.status, observedDnTypes,
      ...this.deviceDiagnostics.diagnostics(this.config.enabled) };
  }
  start() {
    if (this.task || !this.config.enabled) return;
    if (!this.config.configured) { this.status.lastError = "3CX configuration missing or invalid"; return; }
    this.task = this.run();
  }
  devicesForDn(dn: string): readonly string[] | null {
    if (!this.config.enabled || !this.status.connected || this.socket?.readyState !== WebSocket.OPEN || !["901", "913"].includes(dn)) return null;
    const snapshot = this.controlDevices.get(dn);
    return snapshot && this.now() - snapshot.observedAt <= 30000 ? [...snapshot.ids] : null;
  }
  /**
   * Selectable devices for the operator: pseudonym (same HMAC as diagnostics), sanitized user
   * agent and a readable label. Same freshness rule as devicesForDn; null when unknown.
   */
  deviceOptionsForDn(dn: string): Array<{ device: string; label: string; userAgent: string }> | null {
    const ids = this.devicesForDn(dn);
    if (ids === null) return null;
    const agents = this.controlDevices.get(dn)?.agents || new Map<string, string>();
    return ids.map(id => {
      const userAgent = agents.get(id) || "";
      return { device: this.deviceDiagnostics.mask(id), label: deviceLabel(userAgent), userAgent };
    });
  }
  private observeControlDevices(dn: string, value: unknown) {
    this.controlDevices.delete(dn);
    if (!["901", "913"].includes(dn) || !Array.isArray(value)) return;
    const ids = new Set<string>();
    const agents = new Map<string, string>();
    for (const item of value) {
      if (!item || typeof item.device_id !== "string" || !item.device_id.trim()
        || (item.dn !== undefined && item.dn !== dn)) return;
      ids.add(item.device_id);
      agents.set(item.device_id, this.deviceDiagnostics.userAgent(item.user_agent, item.device_id));
    }
    this.controlDevices.set(dn, { ids: [...ids], agents, observedAt: this.now() });
  }
  /** Ephemeral projection only. No PBX request, token, provider payload or DB write. */
  liveCalls(): LiveCall[] {
    if (!this.config.enabled || !this.status.connected) return [];
    const calls: LiveCall[] = [];
    for (const call of Object.values(this.state.calls)) {
      if (call.uncertain || !call.direction) continue;
      for (const [key, leg] of Object.entries(call.legs)) {
        if (!leg.active || classifyMonitoredDn(leg.dn, this.dnTypes.get(leg.dn) || "Unknown") !== "Agent") continue;
        const participant = this.liveParticipants.get(key);
        if (!participant || String(participant.callid) !== call.callId) continue;
        // The makecall callback to the operator's own device has no customer yet: it is still
        // projected so the operator sees "answer in your 3CX client", nothing else is invented.
        const callback = participant.peer === "makecall_callback";
        if (!call.customer && !callback) continue;
        const status = leg.status === "Connected" ? "connected" : ["Hold", "Held"].includes(leg.status) ? "hold" : ["Ringing", "Dialing"].includes(leg.status) ? "ringing" : null;
        if (!status) continue;
        const phase: CallPhase = status === "hold" ? "hold"
          : callback ? (status === "connected" ? "callback_answered" : "callback_ringing")
          : status === "connected" ? (participant.peer === "external" ? "connected" : "other")
          : call.direction === "inbound" ? "incoming" : participant.peer === "external" ? "dialing_customer" : "other";
        const connectedAt = this.callTraces.get(call.callId)?.connectedAt;
        calls.push({ callId: call.callId, direction: call.direction, customerPhone: call.customer || "", agentDn: leg.dn,
          status, startedAt: call.startedAt, ...(call.answeredAt ? { answeredAt: call.answeredAt } : {}),
          participantId: participant.id, directControl: participant.direct_control, phase, ...(connectedAt ? { connectedAt } : {}) });
      }
    }
    return calls;
  }
  /**
   * Admin-only correlation for outbound attempts: per native callId, the sequence of
   * agent-leg status and peer class observed (e.g. makecall_callback:Ringing). No numbers,
   * names or provider payloads. Absence of a trace is not proof that 3CX placed no call.
   */
  private callTraces = new Map<string, { dn: string; firstSeenAt: string; lastSeenAt: string; steps: string[]; ended: boolean; connectedAt?: string }>();
  callTrace(callId: string) {
    const row = this.callTraces.get(callId);
    return row ? { ...row, steps: [...row.steps] } : null;
  }
  /** Traces first seen on a DN inside a time window: used only when 3CX returned no callid. */
  callTracesBetween(dn: string, fromMs: number, toMs: number) {
    return [...this.callTraces.entries()]
      .filter(([, row]) => row.dn === dn && Date.parse(row.firstSeenAt) >= fromMs && Date.parse(row.firstSeenAt) <= toMs)
      .map(([callId, row]) => ({ callId, ...row, steps: [...row.steps] }));
  }
  maskDeviceId(deviceId: string) { return this.deviceDiagnostics.mask(deviceId); }
  private traceParticipant(p: any, ended = false) {
    if (!Number.isSafeInteger(p?.callid) || p.callid <= 0 || !["901", "913"].includes(p.dn)) return;
    const id = String(p.callid), at = this.iso();
    const row: { dn: string; firstSeenAt: string; lastSeenAt: string; steps: string[]; ended: boolean; connectedAt?: string } = this.callTraces.get(id) || { dn: p.dn, firstSeenAt: at, lastSeenAt: at, steps: [], ended: false };
    const peer = peerClass(p);
    const status = typeof p.status === "string" && /^[A-Za-z]{1,20}$/.test(p.status) ? p.status : "Unrecognized";
    // A leg on another agent DN (e.g. after a transfer) is prefixed so it is never read as the initiator.
    const step = (p.dn !== row.dn ? `${p.dn}/` : "") + (ended ? "ended" : `${peer}:${status}`);
    if (row.steps[row.steps.length - 1] !== step && row.steps.length < 16) row.steps.push(step);
    row.lastSeenAt = at; row.ended = ended;
    if (!ended && !row.connectedAt && p.status === "Connected" && peer === "external") row.connectedAt = at;
    this.callTraces.delete(id); this.callTraces.set(id, row);
    while (this.callTraces.size > 50) this.callTraces.delete(this.callTraces.keys().next().value!);
  }
  private rememberParticipant(p: any) {
    try { this.traceParticipant(p); } catch { /* diagnostics never interrupt monitoring */ }
    if (Number.isSafeInteger(p.id) && Number.isSafeInteger(p.callid) && p.callid > 0) this.liveParticipants.set(legKey(p.dn, p.id), {
      id: p.id, callid: p.callid, dn: p.dn, direct_control: p.direct_control === true, peer: peerClass(p)
    });
  }
  async stop() {
    this.abort.abort(); this.socket?.terminate();
    await this.task;
    await this.queue;
    if (this.lease) { try { await this.deps.store.release(); } catch { this.status.lastError = new MonitorStageError("checkpoint_save_failed").message; } }
    this.status.connected = false; this.token = "";
  }
  private iso() { return new Date(this.now()).toISOString(); }
  private rememberCallId(id: number) {
    if (!Number.isSafeInteger(id) || id <= 0) return;
    const value = String(id);
    this.status.lastCallId = "***" + (value.length > 4 ? value.slice(-4) : value.length > 1 ? value.slice(-1) : "");
  }
  private enqueue(work: () => Promise<void>) {
    this.queue = this.queue.then(async () => { if (!this.abort.signal.aborted) await work(); }).catch((error: unknown) => {
      // Never interpolate provider messages, response bodies, URLs, tokens or errors.
      this.status.lastError = error instanceof MonitorStageError ? error.message : new MonitorStageError("monitor_transport_failed").message;
      this.socket?.terminate();
    });
    return this.queue;
  }
  private async request(path: string, auth = false): Promise<any> {
    if (!this.config.enabled || this.abort.signal.aborted) throw new Error("Monitor disabled");
    const entity = path.match(/^\/callcontrol\/(\d+)(?:\/participants\/\d+)?$/);
    if (!auth && (!entity || !allowed.has(entity[1]))) throw new Error("Monitoring path rejected");
    if (!auth) await atStage("checkpoint_save_failed", () => this.deps.store.renew());
    const controller = new AbortController();
    const cancel = () => controller.abort(); this.abort.signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, this.deps.timeoutMs || 10000);
    try {
      const credential = auth ? this.config.credential() : "";
      if (auth && !credential.trim()) throw new Error("3CX configuration missing or invalid");
      const response = await this.http(this.config.baseUrl + path, {
        method: auth ? "POST" : "GET", redirect: "error", signal: controller.signal,
        headers: auth ? { "Content-Type": "application/x-www-form-urlencoded" } : { Authorization: "Bearer " + this.token },
        ...(auth ? { body: new URLSearchParams({ grant_type: "client_credentials", client_id: this.config.clientId, client_secret: credential }) } : {})
      });
      if (!auth && response.status === 404) return null;
      if (!response.ok) {
        if (!auth) throw new MonitorReadError(`3CX monitoring read unavailable for DN ${entity[1]} (HTTP ${response.status})`);
        throw new Error("3CX authentication failed");
      }
      return await response.json();
    } finally { clearTimeout(timer); this.abort.signal.removeEventListener("abort", cancel); }
  }
  private async authenticate() {
    if (this.deps.oauth) {
      const auth = await this.deps.oauth.get(); this.token = auth.token; this.expiresAt = auth.expiresAt; return;
    }
    const token = await this.request("/connect/token", true);
    if (typeof token.access_token !== "string" || !token.access_token || !Number.isFinite(token.expires_in) || token.expires_in <= 0) throw new Error("3CX authentication failed");
    this.token = token.access_token;
    this.expiresAt = this.now() + Math.max(1, token.expires_in * 0.8) * 1000;
  }
  private async reconcile(recovery: boolean) {
    const seen = new Set<string>();
    // Never enumerate or read any DN outside the fixed allowlist, even if the SP sees more.
    for (const dn of MONITORED_DNS) {
      const info = await this.request("/callcontrol/" + dn);
      if (!info || info.dn !== dn || !Array.isArray(info.participants) || typeof info.type !== "string") throw new Error("Invalid DN snapshot");
      this.dnTypes.set(dn, info.type);
      // Diagnostic failures must never interrupt participant processing or startup.
      try { this.deviceDiagnostics.observe(dn, info.devices); }
      catch { this.deviceDiagnostics.forget(dn); }
      try { this.observeControlDevices(dn, info.devices); }
      catch { this.controlDevices.delete(dn); }
      for (const summary of info.participants) {
        if (!Number.isSafeInteger(summary.id)) continue;
        const participant = await this.request(`/callcontrol/${dn}/participants/${summary.id}`);
        if (participant && participant.dn === dn && !(await this.deps.store.hasFinal(String(participant.callid)))) {
          seen.add(legKey(dn, participant.id));
          this.rememberParticipant(participant);
          observeParticipant(this.state, participant, this.iso(), recovery, info.type);
          this.rememberCallId(participant.callid);
        }
      }
    }
    for (const call of Object.values(this.state.calls)) for (const [key, leg] of Object.entries(call.legs)) {
      if (leg.active && !seen.has(key)) removeParticipant(this.state, leg.dn, Number(key.split("/")[1]), this.iso(), true);
    }
    for (const [key, known] of this.liveParticipants) if (!seen.has(key)) {
      try { this.traceParticipant(known, true); } catch { /* diagnostics only */ }
      this.liveParticipants.delete(key);
    }
    await this.save();
  }
  private save() { return atStage("checkpoint_save_failed", () => this.deps.store.save(this.state)); }
  private message(raw: unknown) {
    const text = String(raw);
    if (text.length > 1000000) { this.socket?.terminate(); return; }
    let packet: any;
    try { packet = JSON.parse(text); } catch { this.status.lastError = "3CX invalid notification"; return; }
    const event = packet?.event;
    if (!event || !Number.isInteger(event.event_type)) return;
    const entity = String(event.entity || "");
    const match = entity.match(/^\/callcontrol\/(\d+)(?:\/participants(?:\/(\d+))?)?$/);
    // Consume sequence for ALL notifications (including other DNs / DTMF) without fetching them.
    const sequence = Number.isSafeInteger(packet.sequence) ? packet.sequence : null;
    if (sequence !== null && this.sequence !== null && sequence <= this.sequence) return;
    const gap = sequence !== null && this.sequence !== null && sequence !== this.sequence + 1;
    if (sequence !== null) this.sequence = sequence;
    if (gap) this.enqueue(async () => { for (const call of Object.values(this.state.calls)) markCallIncomplete(call, "stream_gap"); await this.reconcile(true); });
    if (entity === "/callcontrol" && [0, 1].includes(event.event_type)) { this.status.lastEventAt = this.iso(); this.enqueue(() => this.reconcile(false)); return; }
    if (!match || !allowed.has(match[1]) || ![0, 1].includes(event.event_type)) return;
    this.status.lastEventAt = this.iso();
    this.enqueue(async () => {
      const [, dn, id] = match;
      if (!id) { await this.reconcile(false); return; }
      if (event.event_type === 1) {
        const known = this.liveParticipants.get(legKey(dn, Number(id)));
        if (known) try { this.traceParticipant(known, true); } catch { /* diagnostics only */ }
        this.liveParticipants.delete(legKey(dn, Number(id))); removeParticipant(this.state, dn, Number(id), this.iso());
      }
      else {
        const participant = await this.request(`/callcontrol/${dn}/participants/${id}`);
        if (participant && participant.dn === dn && participant.id === Number(id) && Number.isSafeInteger(participant.callid) && participant.callid > 0) {
          this.rememberParticipant(participant);
          if (!(await this.deps.store.hasFinal(String(participant.callid)))) observeParticipant(this.state, participant, this.iso(), false, this.dnTypes.get(dn) || "Unknown");
          this.rememberCallId(participant.callid);
        } else removeParticipant(this.state, dn, Number(id), this.iso(), true);
      }
      await this.save();
    });
  }
  private async flush() {
    if (this.deliveryRetryAt > this.now()) return;
    for (const [callId, final] of Object.entries(this.state.finals)) {
      if (final.delivered || !final.event || this.abort.signal.aborted) continue;
      try {
        // Durable outbox is saved before any effect in the existing business layer.
        await this.save();
        await this.deps.deliver(final.event, this.abort.signal);
        final.delivered = true;
        await this.save();
        delete this.state.finals[callId];
        if (this.status.lastError?.startsWith("3CX incomplete call observation;")) this.status.lastError = null;
        this.deliveryFailures = 0;
      } catch (error) {
        if (error instanceof MonitorStageError) throw error;
        this.status.lastError = "3CX internal event delivery failed";
        this.deliveryRetryAt = this.now() + Math.min(60000, (this.deps.retryMs || 1000) * 2 ** Math.min(this.deliveryFailures++, 6));
        return;
      }
    }
  }
  private async cycle() {
    await atStage("authentication_failed", () => this.authenticate());
    if (this.abort.signal.aborted) return;
    await atStage("checkpoint_save_failed", () => this.deps.store.renew());
    this.sequence = null;
    const url = this.config.baseUrl.replace(/^https:/, "wss:") + "/callcontrol/ws";
    const socket = await atStage("websocket_connect_failed", async () => this.deps.socket ? this.deps.socket(url, this.token) : new WebSocket(url, {
      headers: { Authorization: "Bearer " + this.token }, handshakeTimeout: this.deps.timeoutMs || 10000,
      maxPayload: 1000000, followRedirects: false
    }));
    this.socket = socket;
    let closed = false, alive = true;
    const ended = new Promise<void>(resolve => { socket.once("close", () => { closed = true; resolve(); }); });
    let opened = false;
    socket.on("error", () => { this.status.lastError = new MonitorStageError(opened ? "monitor_transport_failed" : "websocket_connect_failed").message; socket.terminate(); });
    socket.on("pong", () => { alive = true; });
    await atStage("websocket_connect_failed", () => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.terminate(); reject(new Error("3CX connect timeout")); }, this.deps.timeoutMs || 10000);
      socket.once("open", () => { clearTimeout(timer); resolve(); });
      socket.once("close", () => { clearTimeout(timer); reject(new Error("3CX socket closed")); });
    }));
    opened = true;
    if (this.abort.signal.aborted) { socket.terminate(); return; }
    this.status.connected = true; this.status.lastConnectedAt = this.iso(); this.status.lastError = null;
    // Queue initial snapshot before notifications, so queue types are known on first update.
    const initial = this.enqueue(() => atStage("initial_reconcile_failed", () => this.reconcile(true)));
    socket.on("message", data => this.message(data));
    await initial;
    let lastHeartbeat = this.now(), lastReconcile = this.now();
    while (!closed && !this.abort.signal.aborted) {
      await Promise.race([sleep(this.deps.tickMs || 1000, this.abort.signal), ended]);
      if (closed || this.abort.signal.aborted) break;
      if (this.now() >= this.expiresAt) { socket.terminate(); break; }
      if (this.now() - lastHeartbeat >= 15000) {
        if (!alive) { this.status.lastError = new MonitorStageError("monitor_transport_failed").message; socket.terminate(); break; }
        alive = false; socket.ping(); lastHeartbeat = this.now();
      }
      await this.enqueue(async () => {
        const ready = Object.values(this.state.calls).some(call => call.readyAt && call.readyAt <= this.now());
        if (ready || this.now() - lastReconcile >= 10000) { await this.reconcile(false); lastReconcile = this.now(); }
        finalizeCalls(this.state, this.now());
        await this.save();
        for (const [id, final] of Object.entries(this.state.finals)) if (final.delivered) {
          if (!final.event) this.status.lastError = "3CX incomplete call observation; final event withheld [" + (final.incompleteReasons || ["incomplete_observation"]).join(", ") + "]";
          delete this.state.finals[id];
        }
        await this.flush();
      });
    }
    socket.terminate(); await this.queue;
    if (closed && !this.abort.signal.aborted && !this.status.lastError) this.status.lastError = new MonitorStageError("monitor_transport_failed").message;
    this.status.connected = false;
    // Calls continuing through a stream outage have incomplete observation, never guess a miss.
    for (const call of Object.values(this.state.calls)) markCallIncomplete(call, "disconnected");
    await this.save();
  }
  private async run() {
    let failures = 0;
    while (!this.abort.signal.aborted) {
      const connectedAt = this.now();
      try {
        if (!this.lease) {
          const state = await atStage("checkpoint_claim_failed", () => this.deps.store.claim());
          if (!state) throw new MonitorStageError("checkpoint_claim_failed");
          this.state = state; this.lease = true;
          for (const id of Object.keys(this.state.calls)) if (await atStage("checkpoint_claim_failed", () => this.deps.store.hasFinal(id))) delete this.state.calls[id];
          for (const call of Object.values(this.state.calls)) markCallIncomplete(call, "checkpoint_recovery");
        }
        await this.flush();
        await this.cycle();
      } catch (error: unknown) {
        if (!this.abort.signal.aborted) this.status.lastError = error instanceof MonitorStageError ? error.message : new MonitorStageError("monitor_transport_failed").message;
      } finally {
        this.status.connected = false; this.socket?.terminate(); this.socket = null; this.token = "";
        this.controlDevices.clear();
        await this.queue;
        if (this.lease) {
          for (const call of Object.values(this.state.calls)) markCallIncomplete(call, "disconnected");
          try { await this.save(); } catch { this.status.lastError = new MonitorStageError("checkpoint_save_failed").message; }
          // Release is independent of save: failed persistence must not strand the lease.
          try { await this.deps.store.release(); } catch { this.status.lastError = new MonitorStageError("checkpoint_save_failed").message; }
          this.lease = false;
        }
      }
      if (this.now() - connectedAt > 60000) failures = 0;
      const backoff = Math.min(60000, (this.deps.retryMs || 1000) * 2 ** Math.min(failures++, 6));
      await sleep(backoff + Math.floor(Math.random() * backoff * 0.2), this.abort.signal);
    }
  }
}
