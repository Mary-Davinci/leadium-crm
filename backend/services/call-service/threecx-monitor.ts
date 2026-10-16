import WebSocket from "ws";
import { MONITORED_DNS, emptyMonitorState, finalizeCalls, legKey, markCallIncomplete, MonitorState, observeParticipant, removeParticipant } from "./threecx-normalizer";
import { MonitorStore } from "./threecx-store";

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
  retryMs?: number; tickMs?: number; timeoutMs?: number;
};
const allowed = new Set<string>(MONITORED_DNS);
// Only locally constructed messages can reach diagnostics; never a provider response body.
class MonitorReadError extends Error {}
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
  private now: () => number;
  private http: typeof fetch;
  private deliveryRetryAt = 0;
  private deliveryFailures = 0;
  private status = { connected: false, lastConnectedAt: null as string | null, lastEventAt: null as string | null, lastCallId: null as string | null, lastError: null as string | null };

  constructor(private config: MonitorConfig, private deps: Dependencies) { this.now = deps.now || Date.now; this.http = deps.fetch || fetch; }
  diagnostics() {
    return { enabled: this.config.enabled, configured: this.config.configured, ...this.status };
  }
  start() {
    if (this.task || !this.config.enabled) return;
    if (!this.config.configured) { this.status.lastError = "3CX configuration missing or invalid"; return; }
    this.task = this.run();
  }
  async stop() {
    this.abort.abort(); this.socket?.terminate();
    await this.task;
    await this.queue;
    if (this.lease) { try { await this.deps.store.release(); } catch { this.status.lastError = "3CX checkpoint release failed"; } }
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
      this.status.lastError = error instanceof MonitorReadError ? error.message : "3CX event processing failed";
      this.socket?.terminate();
    });
    return this.queue;
  }
  private async request(path: string, auth = false): Promise<any> {
    if (!this.config.enabled || this.abort.signal.aborted) throw new Error("Monitor disabled");
    const entity = path.match(/^\/callcontrol\/(\d+)(?:\/participants\/\d+)?$/);
    if (!auth && (!entity || !allowed.has(entity[1]))) throw new Error("Monitoring path rejected");
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
      for (const summary of info.participants) {
        if (!Number.isSafeInteger(summary.id)) continue;
        const participant = await this.request(`/callcontrol/${dn}/participants/${summary.id}`);
        if (participant && participant.dn === dn && !(await this.deps.store.hasFinal(String(participant.callid)))) {
          seen.add(legKey(dn, participant.id));
          observeParticipant(this.state, participant, this.iso(), recovery, info.type);
          this.rememberCallId(participant.callid);
        }
      }
    }
    for (const call of Object.values(this.state.calls)) for (const [key, leg] of Object.entries(call.legs)) {
      if (leg.active && !seen.has(key)) removeParticipant(this.state, leg.dn, Number(key.split("/")[1]), this.iso(), true);
    }
    await this.deps.store.save(this.state);
  }
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
      if (event.event_type === 1) removeParticipant(this.state, dn, Number(id), this.iso());
      else {
        const participant = await this.request(`/callcontrol/${dn}/participants/${id}`);
        if (participant && participant.dn === dn && participant.id === Number(id) && Number.isSafeInteger(participant.callid) && participant.callid > 0) {
          if (!(await this.deps.store.hasFinal(String(participant.callid)))) observeParticipant(this.state, participant, this.iso(), false, this.dnTypes.get(dn) || "Unknown");
          this.rememberCallId(participant.callid);
        } else removeParticipant(this.state, dn, Number(id), this.iso(), true);
      }
      await this.deps.store.save(this.state);
    });
  }
  private async flush() {
    if (this.deliveryRetryAt > this.now()) return;
    for (const [callId, final] of Object.entries(this.state.finals)) {
      if (final.delivered || !final.event || this.abort.signal.aborted) continue;
      try {
        // Durable outbox is saved before any effect in the existing business layer.
        await this.deps.store.save(this.state);
        await this.deps.deliver(final.event, this.abort.signal);
        final.delivered = true;
        await this.deps.store.save(this.state);
        delete this.state.finals[callId];
        if (this.status.lastError?.startsWith("3CX incomplete call observation;")) this.status.lastError = null;
        this.deliveryFailures = 0;
      } catch {
        this.status.lastError = "3CX internal event delivery failed";
        this.deliveryRetryAt = this.now() + Math.min(60000, (this.deps.retryMs || 1000) * 2 ** Math.min(this.deliveryFailures++, 6));
        return;
      }
    }
  }
  private async cycle() {
    await this.authenticate();
    if (this.abort.signal.aborted) return;
    this.sequence = null;
    const url = this.config.baseUrl.replace(/^https:/, "wss:") + "/callcontrol/ws";
    const socket = this.deps.socket ? this.deps.socket(url, this.token) : new WebSocket(url, {
      headers: { Authorization: "Bearer " + this.token }, handshakeTimeout: this.deps.timeoutMs || 10000,
      maxPayload: 1000000, followRedirects: false
    });
    this.socket = socket;
    let closed = false, alive = true;
    const ended = new Promise<void>(resolve => { socket.once("close", () => { closed = true; resolve(); }); });
    socket.on("error", () => { this.status.lastError = "3CX WebSocket connection failed"; socket.terminate(); });
    socket.on("pong", () => { alive = true; });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.terminate(); reject(new Error("3CX connect timeout")); }, this.deps.timeoutMs || 10000);
      socket.once("open", () => { clearTimeout(timer); resolve(); });
      socket.once("close", () => { clearTimeout(timer); reject(new Error("3CX socket closed")); });
    });
    if (this.abort.signal.aborted) { socket.terminate(); return; }
    this.status.connected = true; this.status.lastConnectedAt = this.iso(); this.status.lastError = null;
    // Queue initial snapshot before notifications, so queue types are known on first update.
    this.enqueue(() => this.reconcile(true));
    socket.on("message", data => this.message(data));
    let lastHeartbeat = this.now(), lastReconcile = this.now();
    while (!closed && !this.abort.signal.aborted) {
      await Promise.race([sleep(this.deps.tickMs || 1000, this.abort.signal), ended]);
      if (closed || this.abort.signal.aborted) break;
      if (this.now() >= this.expiresAt) { socket.terminate(); break; }
      if (this.now() - lastHeartbeat >= 15000) {
        if (!alive) { socket.terminate(); break; }
        alive = false; socket.ping(); lastHeartbeat = this.now();
      }
      await this.enqueue(async () => {
        const ready = Object.values(this.state.calls).some(call => call.readyAt && call.readyAt <= this.now());
        if (ready || this.now() - lastReconcile >= 10000) { await this.reconcile(false); lastReconcile = this.now(); }
        finalizeCalls(this.state, this.now());
        await this.deps.store.save(this.state);
        for (const [id, final] of Object.entries(this.state.finals)) if (final.delivered) {
          if (!final.event) this.status.lastError = "3CX incomplete call observation; final event withheld [" + (final.incompleteReasons || ["incomplete_observation"]).join(", ") + "]";
          delete this.state.finals[id];
        }
        await this.flush();
      });
    }
    socket.terminate(); await this.queue;
    this.status.connected = false;
    // Calls continuing through a stream outage have incomplete observation, never guess a miss.
    for (const call of Object.values(this.state.calls)) markCallIncomplete(call, "disconnected");
    await this.deps.store.save(this.state);
  }
  private async run() {
    let failures = 0;
    while (!this.abort.signal.aborted) {
      const connectedAt = this.now();
      try {
        if (!this.lease) {
          const state = await this.deps.store.claim();
          if (!state) throw new Error("Monitor lease unavailable");
          this.state = state; this.lease = true;
          for (const id of Object.keys(this.state.calls)) if (await this.deps.store.hasFinal(id)) delete this.state.calls[id];
          for (const call of Object.values(this.state.calls)) markCallIncomplete(call, "checkpoint_recovery");
        }
        await this.flush();
        await this.cycle();
      } catch (error: unknown) {
        if (!this.abort.signal.aborted) this.status.lastError = error instanceof MonitorReadError ? error.message : "3CX monitoring unavailable (configuration, authentication, transport or checkpoint)";
      } finally {
        this.status.connected = false; this.socket?.terminate(); this.socket = null; this.token = "";
        await this.queue;
        if (this.lease) {
          for (const call of Object.values(this.state.calls)) markCallIncomplete(call, "disconnected");
          try { await this.deps.store.save(this.state); await this.deps.store.release(); } catch { this.status.lastError = "3CX checkpoint unavailable"; }
          this.lease = false;
        }
      }
      if (this.now() - connectedAt > 60000) failures = 0;
      const backoff = Math.min(60000, (this.deps.retryMs || 1000) * 2 ** Math.min(failures++, 6));
      await sleep(backoff + Math.floor(Math.random() * backoff * 0.2), this.abort.signal);
    }
  }
}
