import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ThreeCxMonitor, monitorConfig } from "./threecx-monitor";
import { classifyMonitoredDn, emptyMonitorState, finalizeCalls, MonitorState, observeParticipant, removeParticipant } from "./threecx-normalizer";
import { monitoredDns } from "./threecx-topology";
import { createMonitorStore, MonitorStore } from "./threecx-store";
import { ThreeCxDeviceDiagnostics } from "./threecx-device-diagnostics";
import * as mongo from "../common/mongo";

process.env.NODE_ENV = "test";
const SECRET = "fixture-secret-never-log";
const TOKEN = "fixture-token-never-log";
// Exact GET /callcontrol/{dn} type values observed on the Crocieriamo tenant.
const TENANT_DN_TYPES: Record<string, string> = {
  "901": "Wextension", "913": "Wextension", "910": "Wqueue", "911": "Wqueue", "912": "Wqueue",
  "920": "Wivr", "921": "Wivr", "922": "Wivr"
};
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
let count = 0;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(test: () => boolean, label: string) {
  for (let i = 0; i < 400; i++) { if (test()) return; await wait(5); }
  throw new Error("Timeout: " + label);
}
async function test(name: string, run: () => Promise<void> | void) { await run(); count++; console.log("PASS " + name); }
class MemoryStore implements MonitorStore {
  state = emptyMonitorState(); owner = false; saves = 0; renewals = 0;
  async claim() { if (this.owner) return null; this.owner = true; return clone(this.state); }
  async renew() { assert.ok(this.owner); this.renewals++; }
  async save(state: MonitorState) { assert.ok(this.owner); this.state = clone({ ...state, finals: { ...this.state.finals, ...state.finals } }); this.saves++; }
  async release() { this.owner = false; }
  async hasFinal(id: string) { return Boolean(this.state.finals[id]); }
}
class FakeSocket extends EventEmitter {
  readyState = 1; terminated = false; pings = 0;
  close() { this.terminate(); }
  terminate() { if (!this.terminated) { this.terminated = true; this.readyState = 3; this.emit("close"); } }
  ping() { this.pings++; this.emit("pong"); }
}
function fixture(options: { socketFailure?: boolean; authStatus?: number; deniedDn?: string; reportedDnTypes?: Record<string, unknown>; reportedDevices?: Record<string, unknown>; enabled?: boolean; store?: MemoryStore; deliver?: (event: any) => Promise<void> } = {}) {
  let time = Date.parse("2026-10-16T10:00:00Z"), sequence = 0;
  const requests: Array<{ path: string; method: string }> = [];
  const sockets: FakeSocket[] = [], deliveries: any[] = [];
  const participants = new Map<string, any>();
  const store = options.store || new MemoryStore();
  const config = monitorConfig({ THREECX_ENABLED: String(options.enabled ?? true), THREECX_BASE_URL: "https://pbx.test:5001", THREECX_CLIENT_ID: "leadiumcrm", THREECX_API_KEY: SECRET });
  const monitor = new ThreeCxMonitor(config, {
    store, now: () => time, retryMs: 10, tickMs: 2, timeoutMs: 100,
    fetch: (async (url: any, init: any) => {
      const pathname = new URL(String(url)).pathname;
      requests.push({ path: pathname, method: init.method });
      assert.equal(init.redirect, "error");
      if (pathname === "/connect/token") {
        assert.equal(init.method, "POST");
        assert.equal(init.body.get("grant_type"), "client_credentials");
        assert.equal(init.body.get("client_id"), "leadiumcrm");
        assert.equal(init.body.get("client_secret"), SECRET);
        return new Response(JSON.stringify(options.authStatus ? { error: SECRET } : { access_token: TOKEN, expires_in: 3600 }), { status: options.authStatus || 200 });
      }
      assert.equal(init.method, "GET"); assert.equal(init.headers.Authorization, "Bearer " + TOKEN);
      const m = pathname.match(/^\/callcontrol\/(901|913|910|911|912|920|921|922)(?:\/participants\/(\d+))?$/);
      assert.ok(m, "Only allowlisted read endpoints may be requested");
      const [, dn, id] = m;
      if (dn === options.deniedDn) return new Response(JSON.stringify({ error: SECRET }), { status: 403 });
      if (id) return new Response(JSON.stringify(participants.get(dn + "/" + id) || null), { status: participants.has(dn + "/" + id) ? 200 : 404 });
      const type = options.reportedDnTypes?.[dn] ?? ({ "910": "Queue", "911": "Queue", "912": "Queue", "920": "RoutePoint", "921": "DigitalReceptionist", "922": "IVR" } as Record<string, string>)[dn] ?? "Extension";
      return new Response(JSON.stringify({ dn, type, devices: options.reportedDevices?.[dn], participants: [...participants.values()].filter(p => p.dn === dn), api_key: SECRET, access_token: TOKEN }));
    }) as typeof fetch,
    socket: (url, token) => {
      assert.equal(url, "wss://pbx.test:5001/callcontrol/ws"); assert.equal(token, TOKEN);
      const socket = new FakeSocket(); sockets.push(socket); setImmediate(() => options.socketFailure ? socket.emit("error", new Error(SECRET + TOKEN)) : socket.emit("open")); return socket as any;
    },
    deliver: async event => { deliveries.push(clone(event)); await options.deliver?.(event); }
  });
  const packet = (dn: string, id: number, type: number) => sockets[sockets.length - 1]!.emit("message", JSON.stringify({ sequence: ++sequence, event: { event_type: type, entity: `/callcontrol/${dn}/participants/${id}` } }));
  return { monitor, store, sockets, requests, deliveries, participants,
    advance: (ms: number) => { time += ms; },
    async start() { monitor.start(); if (options.enabled !== false && !options.authStatus) await until(() => requests.filter(r => /^\/callcontrol\/\d+$/.test(r.path)).length >= monitoredDns().length && store.saves > 0, "initial snapshots"); },
    async upsert(dn: string, id: number, callid: number, status: string, extra: any = {}) {
      participants.set(dn + "/" + id, { id, dn, callid, legid: id, status, party_dn: "+393339999999", party_caller_id: "+393331234567", party_dn_type: "Line", ...extra });
      packet(dn, id, 0); await until(() => store.state.calls[String(callid)]?.legs[dn + "/" + id]?.status === status || Boolean(store.state.finals[String(callid)]), "upsert persisted");
    },
    async remove(dn: string, id: number) { participants.delete(dn + "/" + id); packet(dn, id, 1); await until(() => !Object.values(store.state.calls).some(call => call.legs[dn + "/" + id]?.active), "remove persisted"); },
    async finish(expected = 1) { time += 4000; await until(() => deliveries.length >= expected, "final delivery"); await until(() => Object.values(store.state.finals).filter(row => row.delivered).length >= expected, "final acknowledged"); }
  };
}

async function main() {
  await test("V2 live projection reuses existing monitor reads, tracks direct_control/status and vanishes at end or disconnect", async () => {
    const f = fixture({ reportedDnTypes: TENANT_DN_TYPES }); await f.start();
    try {
      await f.upsert("920", 20, 10101, "Ringing"); await f.upsert("920", 20, 10101, "Connected");
      assert.deepEqual(f.monitor.liveCalls(), []);
      await f.upsert("901", 1, 10101, "Ringing", { direct_control: true });
      let rows = f.monitor.liveCalls(); assert.equal(rows.length, 1); assert.equal(rows[0].agentDn, "901"); assert.equal(rows[0].customerPhone, "+393331234567");
      assert.equal(rows[0].status, "ringing"); assert.equal(rows[0].directControl, true);
      const requests = f.requests.length; f.monitor.liveCalls(); assert.equal(f.requests.length, requests, "live projection never adds PBX reads");
      await f.upsert("901", 1, 10101, "Connected", { direct_control: false }); rows = f.monitor.liveCalls(); assert.equal(rows[0].status, "connected"); assert.equal(rows[0].directControl, false);
      await f.upsert("901", 1, 10101, "Hold"); assert.equal(f.monitor.liveCalls()[0].status, "hold");
      await f.remove("901", 1); assert.deepEqual(f.monitor.liveCalls(), []);
      await f.remove("920", 20); await f.finish(); assert.equal(f.deliveries[0].disposition, "completed");
      await f.monitor.stop(); assert.deepEqual(f.monitor.liveCalls(), []);
    } finally { await f.monitor.stop(); }
  });
  await test("disabled by default: no credential value read, HTTP, socket or store access", async () => {
    let accesses = 0;
    const env: any = { THREECX_BASE_URL: "https://pbx.test", THREECX_CLIENT_ID: "leadiumcrm" };
    Object.defineProperty(env, "THREECX_API_KEY", { get() { accesses++; throw Error("Must not read disabled credential"); } });
    const monitor = new ThreeCxMonitor(monitorConfig(env), { store: {} as any, deliver: async () => { throw Error("unexpected"); }, fetch: async () => { throw Error("unexpected"); } });
    monitor.start(); await monitor.stop(); assert.equal(accesses, 0); assert.equal(monitor.diagnostics().enabled, false);
    assert.deepEqual(monitor.diagnostics().observedDnTypes, {});
    assert.deepEqual(monitor.diagnostics().observedDevices, {}); assert.deepEqual(monitor.diagnostics().deviceCount, {});
    const f = fixture({ enabled: false }); await f.start(); await wait(15); await f.monitor.stop(); assert.equal(f.requests.length, 0); assert.equal(f.sockets.length, 0);
    assert.deepEqual(f.monitor.diagnostics().observedDnTypes, {});
    assert.deepEqual(f.monitor.diagnostics().observedDevices, {}); assert.deepEqual(f.monitor.diagnostics().deviceCount, {});
    assert.equal(f.monitor.devicesForDn("901"), null); assert.equal(f.monitor.devicesForDn("913"), null);
  });
  await test("missing/invalid env fails closed without any connections", async () => {
    for (const env of [{}, { THREECX_ENABLED: "true" }, { THREECX_ENABLED: "true", THREECX_BASE_URL: "http://pbx.test", THREECX_CLIENT_ID: "leadiumcrm", THREECX_API_KEY: SECRET }]) {
      const monitor = new ThreeCxMonitor(monitorConfig(env), { store: {} as any, deliver: async () => {}, fetch: async () => { throw Error("unexpected"); } });
      monitor.start(); await monitor.stop(); assert.equal(monitor.diagnostics().configured, false);
    }
  });
  await test("auth failure has backoff, no socket and no credential/provider-body leakage", async () => {
    const f = fixture({ authStatus: 400 }); f.monitor.start();
    await until(() => f.requests.length >= 2, "auth retries");
    assert.match(f.monitor.diagnostics().lastError!, /\[authentication_failed\]/);
    await f.monitor.stop(); assert.equal(f.sockets.length, 0); assert.ok(f.requests.length < 10);
    assert.ok(!JSON.stringify(f.monitor.diagnostics()).includes(SECRET)); assert.ok(!JSON.stringify(f.monitor.diagnostics()).includes(TOKEN));
  });
  await test("WebSocket handshake failure is sanitized and reconnect succeeds after transient deploy failure", async () => {
    const options = { socketFailure: true }; const f = fixture(options); f.monitor.start();
    try {
      await until(() => !!f.monitor.diagnostics().lastError?.includes("websocket_connect_failed"), "websocket stage");
      assert.equal(f.monitor.diagnostics().lastConnectedAt, null);
      assert.ok(!JSON.stringify(f.monitor.diagnostics()).includes(SECRET));
      assert.ok(!JSON.stringify(f.monitor.diagnostics()).includes(TOKEN));
      options.socketFailure = false;
      await until(() => f.monitor.diagnostics().connected && f.store.saves > 1 && Object.keys(f.monitor.diagnostics().observedDnTypes).length === 8, "reconnected after deploy");
      assert.equal(f.monitor.diagnostics().lastError, null);
    } finally { await f.monitor.stop(); }
  });
  await test("checkpoint claim failure performs zero PBX requests then retries safely", async () => {
    const store = new MemoryStore(); const claim = store.claim.bind(store); let blocked = true;
    store.claim = async () => { if (blocked) throw new Error(SECRET + TOKEN); return claim(); };
    const f = fixture({ store }); f.monitor.start();
    try {
      await until(() => !!f.monitor.diagnostics().lastError?.includes("checkpoint_claim_failed"), "claim stage");
      assert.equal(f.requests.length, 0); assert.equal(f.sockets.length, 0);
      assert.ok(!JSON.stringify(f.monitor.diagnostics()).includes(SECRET));
      blocked = false; await until(() => f.monitor.diagnostics().connected && store.saves > 0, "claim recovered");
    } finally { await f.monitor.stop(); }
  });
  await test("checkpoint save failure still releases ownership and reconnects", async () => {
    const store = new MemoryStore(); const save = store.save.bind(store); let broken = true, releases = 0;
    store.save = async state => { if (broken) throw new Error(SECRET + TOKEN); await save(state); };
    store.release = async () => { releases++; store.owner = false; };
    const f = fixture({ store }); f.monitor.start();
    try {
      await until(() => releases > 0, "failed save still releases");
      assert.match(f.monitor.diagnostics().lastError!, /\[checkpoint_save_failed\]/);
      assert.ok(!JSON.stringify(f.monitor.diagnostics()).includes(SECRET));
      broken = false; await until(() => f.monitor.diagnostics().connected && store.saves > 0, "save recovered");
    } finally { await f.monitor.stop(); }
  });
  await test("lost lease cannot open a WebSocket or start snapshot reads", async () => {
    const store = new MemoryStore(); store.renew = async () => { throw new Error(SECRET + TOKEN); };
    const f = fixture({ store }); f.monitor.start();
    try {
      await until(() => !!f.monitor.diagnostics().lastError?.includes("checkpoint_save_failed"), "renew failure");
      assert.equal(f.sockets.length, 0); assert.ok(f.requests.every(row => row.path === "/connect/token"));
      assert.ok(!JSON.stringify(f.monitor.diagnostics()).includes(SECRET));
    } finally { await f.monitor.stop(); }
  });
  await test("initial reconcile parsing failure is distinct from auth and transport", async () => {
    const f = fixture({ reportedDnTypes: { "901": 123 } }); f.monitor.start();
    try {
      await until(() => !!f.monitor.diagnostics().lastError?.includes("initial_reconcile_failed"), "initial stage");
      assert.ok(f.monitor.diagnostics().lastConnectedAt); assert.equal(f.deliveries.length, 0);
    } finally { await f.monitor.stop(); }
  });
  await test("device sanitizer exceptions are best-effort and participants continue normally", async () => {
    const prototype = ThreeCxDeviceDiagnostics.prototype as any;
    const previous = prototype.userAgent;
    prototype.userAgent = () => { throw new Error(SECRET + TOKEN); };
    const f = fixture({ reportedDevices: { "901": [{ device_id: "private", user_agent: "Fixture" }] } });
    try {
      await f.start(); assert.equal(f.monitor.diagnostics().connected, true);
      assert.equal(f.monitor.diagnostics().observedDevices["901"], undefined);
      await f.upsert("901", 1, 12345, "Ringing");
      await f.upsert("901", 1, 12345, "Connected");
      assert.equal(f.monitor.liveCalls()[0].callId, "12345");
      assert.equal(f.monitor.diagnostics().lastError, null);
    } finally { await f.monitor.stop(); prototype.userAgent = previous; }
  });
  await test("undefined/non-array/unexpected devices never prevent initial reconcile or participant processing", async () => {
    for (const devices of [undefined, { malformed: true }, [{ device_id: 123 }]]) {
      const f = fixture({ reportedDevices: { "901": devices } });
      try {
        await f.start(); assert.equal(f.monitor.diagnostics().connected, true);
        assert.equal(f.monitor.diagnostics().observedDevices["901"], undefined);
        await f.upsert("901", 1, 12346, "Ringing");
        await f.upsert("901", 1, 12346, "Connected");
        assert.equal(f.monitor.liveCalls()[0].callId, "12346"); assert.equal(f.monitor.diagnostics().lastError, null);
        assert.ok(f.store.renewals >= f.requests.filter(row => row.method === "GET").length + 1, "renew/check ownership before socket and every PBX read during long snapshots");
      } finally { await f.monitor.stop(); }
    }
  });
  await test("post-connect transport failure has a sanitized category", async () => {
    const f = fixture(); await f.start();
    try {
      f.sockets[0].emit("error", new Error(SECRET + TOKEN));
      assert.match(f.monitor.diagnostics().lastError!, /\[monitor_transport_failed\]/);
      assert.ok(!JSON.stringify(f.monitor.diagnostics()).includes(SECRET));
    } finally { await f.monitor.stop(); }
  });
  await test("IVR outside Service Principal permissions fails closed with a safe initial reconcile error", async () => {
    const f = fixture({ deniedDn: "920" }); f.monitor.start();
    try {
      await until(() => Boolean(f.monitor.diagnostics().lastError?.includes("initial_reconcile_failed")), "permission diagnostic");
      assert.equal(f.deliveries.length, 0); assert.ok(!JSON.stringify(f.monitor.diagnostics()).includes(SECRET));
      assert.ok(f.requests.every(request => request.path === "/connect/token" || request.method === "GET"));
    } finally { await f.monitor.stop(); }
  });
  await test("OAuth success and exact read allowlist; diagnostics schema and graceful shutdown", async () => {
    const f = fixture(); await f.start(); assert.equal(f.monitor.diagnostics().connected, true);
    assert.deepEqual(Object.keys(f.monitor.diagnostics()).sort(), ["enabled", "configured", "connected", "lastConnectedAt", "lastEventAt", "lastCallId", "lastError", "observedDnTypes", "observedDevices", "deviceCount"].sort());
    assert.equal(new Set(f.requests.filter(r => r.method === "GET").map(r => r.path)).size, 8);
    const socket = f.sockets[0]; socket.emit("message", JSON.stringify({ sequence: 1, event: { event_type: 0, entity: "/callcontrol/999/participants/1" } }));
    await wait(10); assert.ok(f.requests.every(r => r.path === "/connect/token" || monitoredDns().some(dn => r.path.startsWith("/callcontrol/" + dn))));
    await f.monitor.stop(); const size = f.requests.length; await wait(20); assert.equal(f.requests.length, size); assert.ok(socket.terminated); assert.equal(f.store.owner, false);
  });
  await test("observedDnTypes projects exact returned types only, with no participant, phone or credential fields", async () => {
    // Deliberately synthetic, unfamiliar types: diagnostics must not infer or normalize enums.
    const types: Record<string, unknown> = Object.fromEntries(monitoredDns().map(dn => [dn, "Fixture type::" + dn]));
    const f = fixture({ reportedDnTypes: types });
    f.participants.set("901/1", { dn: "901", id: 1, callid: 54321, status: "Ringing", party_caller_id: "+393331234567", party_dn_type: "Line", api_key: SECRET, access_token: TOKEN });
    assert.deepEqual(f.monitor.diagnostics().observedDnTypes, {});
    await f.start();
    try {
      const before = f.requests.length;
      const diagnostics = f.monitor.diagnostics();
      assert.deepEqual(diagnostics.observedDnTypes, types);
      assert.deepEqual(Object.keys(diagnostics.observedDnTypes).sort(), monitoredDns().sort());
      for (const value of Object.values(diagnostics.observedDnTypes)) assert.equal(typeof value, "string");
      const serialized = JSON.stringify(diagnostics);
      for (const forbidden of [SECRET, TOKEN, "+393331234567", "participants", "party_caller_id", "api_key", "access_token"]) assert.ok(!serialized.includes(forbidden));
      diagnostics.observedDnTypes["901"] = "changed by consumer";
      assert.equal(f.monitor.diagnostics().observedDnTypes["901"], types["901"]);
      assert.equal(f.requests.length, before, "reading diagnostics must not issue any PBX requests");
      types["901"] = "Different fixture TYPE"; f.advance(10001);
      await until(() => f.monitor.diagnostics().observedDnTypes["901"] === types["901"], "type refreshed from existing reconciliation");
      // The new diagnostics must not loosen agent recognition for an unknown real type.
      await f.upsert("901", 1, 54321, "Connected");
      assert.ok(f.store.state.calls["54321"].incompleteReasons.includes("unverified_agent_type"));
      assert.equal(f.store.state.calls["54321"].answeredAt, undefined);
    } finally { await f.monitor.stop(); }
  });
  for (const size of [0, 1, 3]) await test("device diagnostics: " + size + " devices, only 901/913, detached projection and no extra PBX reads", async () => {
    const devices = Array.from({ length: size }, (_, id) => ({ dn: "901", device_id: "private-device-" + id, user_agent: "Fixture Desktop Client 20.0" }));
    const f = fixture({ reportedDevices: { "901": devices, "913": [], "910": [{ dn: "910", device_id: "queue-private", user_agent: SECRET }] } });
    await f.start();
    try {
      const before = f.requests.length, diagnostics = f.monitor.diagnostics();
      assert.deepEqual(f.monitor.devicesForDn("901"), devices.map(row => row.device_id));
      assert.deepEqual(f.monitor.devicesForDn("913"), []); assert.equal(f.monitor.devicesForDn("910"), null);
      const controlIds = f.monitor.devicesForDn("901") as string[]; controlIds.push("client-mutation");
      assert.deepEqual(f.monitor.devicesForDn("901"), devices.map(row => row.device_id));
      assert.deepEqual(diagnostics.deviceCount, { "901": size, "913": 0 });
      assert.equal(diagnostics.observedDevices["901"].length, size); assert.deepEqual(diagnostics.observedDevices["913"], []);
      assert.deepEqual(Object.keys(diagnostics.observedDevices).sort(), ["901", "913"]);
      for (const row of diagnostics.observedDevices["901"]) {
        assert.deepEqual(Object.keys(row).sort(), ["deviceIdMasked", "userAgent"]);
        assert.match(row.deviceIdMasked, /^device-[a-f0-9]{12}$/); assert.equal(row.userAgent, "Fixture Desktop Client 20.0");
      }
      if (size) {
        const masked = diagnostics.observedDevices["901"][0].deviceIdMasked;
        diagnostics.observedDevices["901"][0].userAgent = "mutated by consumer";
        assert.equal(f.monitor.diagnostics().observedDevices["901"][0].userAgent, "Fixture Desktop Client 20.0");
        assert.equal(f.monitor.diagnostics().observedDevices["901"][0].deviceIdMasked, masked);
      }
      assert.equal(f.requests.length, before, "diagnostics must reuse DN snapshots, not GET devices or participants");
      assert.ok(f.requests.every(row => row.path === "/connect/token" || row.method === "GET"));
      const serialized = JSON.stringify(f.monitor.diagnostics());
      for (const forbidden of ["private-device", "queue-private", SECRET, TOKEN]) assert.ok(!serialized.includes(forbidden));
    } finally { await f.monitor.stop(); }
  });
  await test("server-only device selection expires, refreshes, rejects malformed snapshots and is unavailable on socket close", async () => {
    const devices: Record<string, unknown> = { "901": [{ dn: "901", device_id: "private-control-device", user_agent: "Fixture" }] };
    const f = fixture({ reportedDevices: devices });
    assert.equal(f.monitor.devicesForDn("901"), null);
    try {
      await f.start(); assert.deepEqual(f.monitor.devicesForDn("901"), ["private-control-device"]);
      f.advance(30001); assert.equal(f.monitor.devicesForDn("901"), null, "expired snapshot must not select a device");
      await until(() => f.monitor.devicesForDn("901") !== null, "device snapshot refreshed");
      devices["901"] = [{ dn: "913", device_id: "other-dn-device" }]; f.advance(10001);
      await until(() => f.monitor.devicesForDn("901") === null, "wrong-DN devices excluded");
      devices["901"] = undefined; f.advance(10001);
      await until(() => !f.monitor.diagnostics().observedDevices["901"], "missing devices unavailable");
      assert.equal(f.monitor.devicesForDn("901"), null);
      f.sockets[0].terminate(); assert.equal(f.monitor.devicesForDn("901"), null);
      assert.ok(!JSON.stringify(f.monitor.diagnostics()).includes("private-control-device"));
    } finally { await f.monitor.stop(); }
  });
  await test("device diagnostics: sensitive IDs and unsafe user agents are not exposed", async () => {
    const sensitiveId = "sip:901@private.example;+393331234567";
    const agents = [SECRET, TOKEN, "Bearer " + TOKEN, "API_KEY=" + SECRET, "+39 333 12 34 567", "sip:901@private.example", "<script>bad</script>"];
    const f = fixture({ reportedDevices: { "901": [{ dn: "901", device_id: sensitiveId, user_agent: "Fixture Mobile Client 20.0", participants: [{ phone: "+393331234567" }], api_key: SECRET, access_token: TOKEN }],
      "913": agents.map((user_agent, id) => ({ dn: "913", device_id: "opaque-sensitive-id-" + id, user_agent })) } });
    await f.start();
    try {
      const diagnostics = f.monitor.diagnostics();
      assert.equal(diagnostics.deviceCount["913"], agents.length);
      assert.ok(diagnostics.observedDevices["913"].every(device => device.userAgent === "[redacted]"));
      const serialized = JSON.stringify(diagnostics);
      for (const forbidden of [sensitiveId, "private.example", "+393331234567", "+39 333 12 34 567", SECRET, TOKEN, "participants", "api_key", "access_token", "opaque-sensitive-id"]) assert.ok(!serialized.includes(forbidden));
    } finally { await f.monitor.stop(); }
  });
  await test("device diagnostics: refresh preserves pseudonyms, missing/malformed is unknown rather than zero", async () => {
    const devices: Record<string, unknown> = { "901": [{ dn: "901", device_id: "private-refresh-device", user_agent: "Fixture Desktop" }], "913": [] };
    const f = fixture({ reportedDevices: devices }); await f.start();
    try {
      const masked = f.monitor.diagnostics().observedDevices["901"][0].deviceIdMasked;
      devices["901"] = [{ dn: "901", device_id: "private-refresh-device", user_agent: "Fixture Updated" }]; f.advance(10001);
      await until(() => f.monitor.diagnostics().observedDevices["901"]?.[0]?.userAgent === "Fixture Updated", "device snapshot refreshed");
      assert.equal(f.monitor.diagnostics().observedDevices["901"][0].deviceIdMasked, masked);
      for (const invalid of [undefined, null, { devices: SECRET }, [{ dn: "913", device_id: "wrong-owner" }], [{ device_id: { secret: SECRET } }], [{ device_id: "valid", user_agent: { token: TOKEN } }]]) {
        const before = f.requests.filter(row => row.path === "/callcontrol/913").length;
        devices["901"] = invalid; f.advance(10001);
        await until(() => f.requests.filter(row => row.path === "/callcontrol/913").length > before && f.monitor.diagnostics().observedDevices["901"] === undefined, "invalid/missing devices omitted after reconciliation");
        assert.equal(f.monitor.diagnostics().deviceCount["901"], undefined);
        assert.equal(f.monitor.diagnostics().deviceCount["913"], 0);
        assert.equal(f.monitor.diagnostics().connected, true, "diagnostic-only malformed device field must not disrupt call monitoring");
      }
      devices["901"] = []; f.advance(10001);
      await until(() => f.monitor.diagnostics().deviceCount["901"] === 0, "explicit empty snapshot is zero devices");
    } finally { await f.monitor.stop(); }
  });
  await test("malformed type objects cannot expose nested provider credentials in diagnostics", async () => {
    const f = fixture({ reportedDnTypes: { "901": { access_token: TOKEN, api_key: SECRET } } });
    f.monitor.start();
    try {
      await until(() => Boolean(f.monitor.diagnostics().lastError), "invalid DN type rejected");
      assert.deepEqual(f.monitor.diagnostics().observedDnTypes, {});
      const serialized = JSON.stringify(f.monitor.diagnostics()); assert.ok(!serialized.includes(SECRET)); assert.ok(!serialized.includes(TOKEN));
      assert.equal(f.deliveries.length, 0);
    } finally { await f.monitor.stop(); }
  });
  for (const reportedDnTypes of [undefined, TENANT_DN_TYPES]) for (const dn of ["901", "913"]) await test("inbound answered with native callid and agent " + dn + (reportedDnTypes ? " Wextension" : " Extension"), async () => {
    const f = fixture({ reportedDnTypes }); await f.start();
    try {
      await f.upsert(dn, 1, 123456, "Ringing"); f.advance(2000);
      await f.upsert(dn, 1, 123456, "Connected"); f.advance(95000); await f.remove(dn, 1); await f.finish();
      const e = f.deliveries[0]; assert.equal(e.callId, "123456"); assert.equal(e.from, "+393331234567"); assert.equal(e.agent, dn);
      assert.equal(e.direction, "inbound"); assert.equal(e.disposition, "completed"); assert.equal(e.durationSeconds, 95); assert.ok(e.answeredAt); assert.ok(Date.parse(e.startedAt) < Date.parse(e.answeredAt));
      assert.equal(f.monitor.diagnostics().lastCallId, "***3456");
    } finally { await f.monitor.stop(); }
  });
  await test("outbound uses external dialed party, never the originating internal number", async () => {
    const f = fixture(); await f.start();
    try { await f.upsert("913", 2, 222, "Dialing", { party_caller_id: "913", originated_by_dn: "913" }); await f.remove("913", 2); await f.finish();
      assert.equal(f.deliveries[0].from, "+393339999999"); assert.equal(f.deliveries[0].direction, "outbound"); assert.equal(f.deliveries[0].disposition, "no_answer"); assert.equal(f.deliveries[0].durationSeconds, 0);
    } finally { await f.monitor.stop(); }
  });
  await test("queues 911/912 connected do not count as an operator answer; one final across legs", async () => {
    const f = fixture(); await f.start();
    try { await f.upsert("911", 11, 333, "Ringing"); await f.upsert("911", 11, 333, "Connected"); await f.upsert("912", 12, 333, "Connected");
      await f.upsert("901", 13, 333, "Ringing"); await f.remove("911", 11); await f.remove("912", 12); assert.equal(f.deliveries.length, 0);
      await f.remove("901", 13); await f.finish(); assert.equal(f.deliveries.length, 1); assert.equal(f.deliveries[0].disposition, "no_answer"); assert.equal(f.deliveries[0].agent, "901");
    } finally { await f.monitor.stop(); }
  });
  await test("queue handover after last removal is correlated before finalization", async () => {
    const f = fixture(); await f.start();
    try { await f.upsert("911", 1, 444, "Ringing"); await f.remove("911", 1); f.advance(1000); await f.upsert("913", 2, 444, "Ringing");
      await f.upsert("913", 2, 444, "Connected"); f.advance(2000); await f.remove("913", 2); await f.finish(); assert.equal(f.deliveries[0].agent, "913"); assert.equal(f.deliveries[0].disposition, "completed");
    } finally { await f.monitor.stop(); }
  });
  for (const reportedDnTypes of [undefined, TENANT_DN_TYPES]) await test("Crocieriamo inbound 920 -> 911 -> 910 -> 901: one completed call, original customer, final agent" + (reportedDnTypes ? " (real W types)" : " (legacy types)"), async () => {
    const f = fixture({ reportedDnTypes }); await f.start();
    if (reportedDnTypes) assert.deepEqual(f.monitor.diagnostics().observedDnTypes, TENANT_DN_TYPES);
    const internalPeer = (dn: string, type: string) => ({ party_dn: dn, party_caller_id: "", party_dn_type: type });
    try {
      await f.upsert("920", 20, 920901, "Ringing"); f.advance(1000);
      await f.upsert("920", 20, 920901, "Connected");
      assert.equal(f.store.state.calls["920901"].answeredAt, undefined);
      assert.equal(f.store.state.calls["920901"].agent, undefined);
      f.advance(2000); await f.upsert("911", 11, 920901, "Connected", internalPeer("920", reportedDnTypes?.["920"] || "RoutePoint")); await f.remove("920", 20);
      f.advance(3000); await f.upsert("910", 10, 920901, "Connected", internalPeer("911", reportedDnTypes?.["911"] || "Queue")); await f.remove("911", 11);
      assert.equal(f.store.state.calls["920901"].answeredAt, undefined);
      f.advance(4000); await f.upsert("901", 1, 920901, "Ringing", internalPeer("910", reportedDnTypes?.["910"] || "Queue")); await f.remove("910", 10);
      f.advance(5000);
      await f.upsert("901", 1, 920901, "Connected", { party_dn: "+3902111222333", party_caller_id: "+3902111222333", originated_by_dn: "901" });
      const answeredAt = f.store.state.calls["920901"].answeredAt;
      assert.equal(answeredAt, "2026-10-16T10:00:15.000Z");
      f.advance(65000); await f.remove("901", 1); await f.finish();
      assert.equal(f.deliveries.length, 1);
      const e = f.deliveries[0]; assert.equal(e.callId, "920901"); assert.equal(e.from, "+393331234567");
      assert.equal(e.direction, "inbound"); assert.equal(e.agent, "901"); assert.equal(e.disposition, "completed");
      assert.equal(e.startedAt, "2026-10-16T10:00:00.000Z"); assert.equal(e.answeredAt, answeredAt); assert.equal(e.durationSeconds, 65);
      assert.equal(f.monitor.diagnostics().lastError, null);
    } finally { await f.monitor.stop(); }
  });
  for (const reportedDnTypes of [undefined, TENANT_DN_TYPES]) for (const ivr of ["920", "921", "922"]) await test("inbound " + ivr + " -> 911 -> 910 without agent: no_answer, never IVR/queue answered" + (reportedDnTypes ? " (real W types)" : " (legacy types)"), async () => {
    const f = fixture({ reportedDnTypes }); await f.start();
    const callid = Number(ivr) * 1000;
    try {
      await f.upsert(ivr, 20, callid, "Ringing"); await f.upsert(ivr, 20, callid, "Connected");
      await f.upsert("911", 11, callid, "Connected", { party_dn: ivr, party_caller_id: "", party_dn_type: reportedDnTypes?.[ivr] || "DigitalReceptionist" });
      await f.remove(ivr, 20);
      await f.upsert("910", 10, callid, "Connected", { party_dn: "911", party_caller_id: "", party_dn_type: reportedDnTypes?.["911"] || "Queue" });
      await f.remove("911", 11); f.advance(10000); await f.remove("910", 10); await f.finish();
      const e = f.deliveries[0]; assert.equal(e.callId, String(callid)); assert.equal(e.from, "+393331234567");
      assert.equal(e.direction, "inbound"); assert.equal(e.disposition, "no_answer"); assert.equal(e.durationSeconds, 0);
      assert.equal(e.answeredAt, undefined); assert.equal(e.agent, undefined); assert.equal(f.deliveries.length, 1);
    } finally { await f.monitor.stop(); }
  });
  await test("topology classification: 920/921/922 receptionist, 910/911/912 queue, only 901/913 agents", () => {
    for (const dn of ["920", "921", "922"]) for (const type of ["RoutePoint", "DigitalReceptionist", "IVR", "Wivr"]) {
      assert.ok(["RoutePoint", "DigitalReceptionist"].includes(classifyMonitoredDn(dn, type)));
      const state = emptyMonitorState(); observeParticipant(state, { dn, id: 1, callid: 123, status: "Connected" }, new Date().toISOString(), false, type);
      assert.equal(state.calls["123"].answeredAt, undefined); assert.equal(state.calls["123"].agent, undefined);
    }
    for (const dn of ["910", "911", "912"]) {
      assert.equal(classifyMonitoredDn(dn, "Queue"), "Queue");
      const state = emptyMonitorState(); observeParticipant(state, { dn, id: 1, callid: 123, status: "Connected" }, new Date().toISOString(), false, "Extension");
      assert.equal(state.calls["123"].answeredAt, undefined);
    }
    for (const dn of ["901", "913"]) { assert.equal(classifyMonitoredDn(dn, "Extension"), "Agent"); assert.equal(classifyMonitoredDn(dn, "Unknown"), "Unknown"); }
    const state = emptyMonitorState(), at = "2026-10-16T10:00:00Z";
    observeParticipant(state, { dn: "901", id: 1, callid: 128, status: "Ringing", party_caller_id: "+393331234567" }, at, false, "Unknown");
    observeParticipant(state, { dn: "901", id: 1, callid: 128, status: "Connected" }, at, false, "Unknown");
    removeParticipant(state, "901", 1, at); finalizeCalls(state, Date.parse(at) + 4000);
    assert.equal(state.finals["128"].event, null, "unknown agent type must not be coerced into no_answer");
    assert.ok(state.finals["128"].incompleteReasons.includes("unverified_agent_type"));
  });
  await test("exact tenant type mapping stays DN-scoped; unknown and mismatched types never become agents", () => {
    for (const dn of monitoredDns()) {
      assert.equal(classifyMonitoredDn(dn, TENANT_DN_TYPES[dn]), ["901", "913"].includes(dn) ? "Agent" : ["910", "911", "912"].includes(dn) ? "Queue" : "DigitalReceptionist");
      for (const type of ["", "Unknown", "Wextension-extra", "SomeWextension", " Wextension", "Wextension "]) assert.equal(classifyMonitoredDn(dn, type), "Unknown");
      if (!["901", "913"].includes(dn)) for (const type of ["Wextension", "Extension"]) assert.equal(classifyMonitoredDn(dn, type), "Unknown");
    }
    assert.equal(classifyMonitoredDn("999", "Wextension"), "Unknown");
    const at = "2026-10-16T10:00:00Z";
    for (const dn of ["901", "913"]) for (const type of ["Wqueue", "Wivr", "Unknown", "Wextension-extra"]) {
      const state = emptyMonitorState();
      observeParticipant(state, { dn, id: 1, callid: 128, status: "Ringing", party_caller_id: "+393331234567", party_dn_type: "Line" }, at, false, type);
      observeParticipant(state, { dn, id: 1, callid: 128, status: "Connected" }, at, false, type);
      assert.equal(state.calls["128"].answeredAt, undefined); assert.equal(state.calls["128"].agent, undefined);
      removeParticipant(state, dn, 1, at); finalizeCalls(state, Date.parse(at) + 4000);
      assert.equal(state.finals["128"].event, null); assert.ok(state.finals["128"].incompleteReasons.includes("unverified_agent_type"));
    }
  });
  await test("real W peer types cannot supply an internal peer caller-id as the customer", () => {
    const at = "2026-10-16T10:00:00Z";
    for (const type of ["Wextension", "Wqueue", "Wivr"]) {
      const state = emptyMonitorState();
      observeParticipant(state, { dn: "901", id: 1, callid: 129, status: "Ringing", party_dn: "911", party_dn_type: type, party_caller_id: "+3902111222333" }, at, false, "Wextension");
      observeParticipant(state, { dn: "901", id: 1, callid: 129, status: "Connected" }, at, false, "Wextension");
      removeParticipant(state, "901", 1, at); finalizeCalls(state, Date.parse(at) + 4000);
      assert.equal(state.finals["129"].event, null); assert.ok(state.finals["129"].incompleteReasons.includes("missing_external_number"));
    }
  });
  await test("snapshot of a handover leg preserves a known IVR call; genuine unknown starts remain quarantined", () => {
    const at = "2026-10-16T10:00:00.000Z", later = "2026-10-16T10:00:01.000Z";
    const state = emptyMonitorState();
    observeParticipant(state, { dn: "920", id: 20, callid: 124, status: "Ringing", party_caller_id: "+393331234567", party_dn_type: "Line" }, at, false, "RoutePoint");
    observeParticipant(state, { dn: "901", id: 1, callid: 124, status: "Connected", party_dn: "910", party_dn_type: "Queue" }, later, true, "Extension");
    assert.equal(state.calls["124"].uncertain, undefined);
    removeParticipant(state, "920", 20, later); removeParticipant(state, "901", 1, later); finalizeCalls(state, Date.parse(later) + 4000);
    assert.equal(state.finals["124"].event?.disposition, "completed");
    const unknown = emptyMonitorState();
    observeParticipant(unknown, { dn: "901", id: 1, callid: 125, status: "Connected", party_caller_id: "+393331234567" }, at, true, "Extension");
    removeParticipant(unknown, "901", 1, later); finalizeCalls(unknown, Date.parse(later) + 4000);
    assert.equal(unknown.finals["125"].event, null); assert.ok(unknown.finals["125"].incompleteReasons.includes("unknown_start"));
  });
  await test("missing first external leg remains fail-safe and identifies missing_external_number", async () => {
    const f = fixture(); await f.start();
    try {
      await f.upsert("911", 11, 126, "Ringing", { party_dn: "920", party_dn_type: "RoutePoint", party_caller_id: "" });
      await f.upsert("901", 1, 126, "Connected", { party_dn: "910", party_dn_type: "Queue", party_caller_id: "" });
      await f.remove("911", 11); await f.remove("901", 1); f.advance(4000);
      await until(() => Boolean(f.store.state.finals["126"]), "quarantined missing external party");
      assert.equal(f.deliveries.length, 0); assert.ok(f.monitor.diagnostics().lastError.includes("missing_external_number"));
      await f.upsert("901", 2, 127, "Ringing"); await f.remove("901", 2); await f.finish();
      assert.equal(f.monitor.diagnostics().lastError, null, "a new successful final must not display an old incomplete-call error");
    } finally { await f.monitor.stop(); }
  });
  await test("native callid dedup survives repeated notifications, reconnect and restart", async () => {
    const f = fixture(); await f.start();
    await f.upsert("901", 1, 555, "Ringing"); await f.remove("901", 1); await f.finish();
    await f.upsert("901", 1, 555, "Ringing"); await f.remove("901", 1); f.advance(4000); await wait(20); assert.equal(f.deliveries.length, 1);
    f.sockets[0].terminate(); await until(() => f.sockets.length === 2, "socket reconnect"); await f.monitor.stop();
    const restarted = fixture({ store: f.store }); await restarted.start();
    try { await restarted.upsert("901", 1, 555, "Ringing"); await restarted.remove("901", 1); restarted.advance(4000); await wait(20); assert.equal(restarted.deliveries.length, 0); }
    finally { await restarted.monitor.stop(); }
  });
  await test("failed internal delivery retains outbox and retries same final payload", async () => {
    let attempts = 0;
    const f = fixture({ deliver: async () => { if (++attempts === 1) throw Error(SECRET); } }); await f.start();
    try { await f.upsert("901", 1, 666, "Ringing"); await f.remove("901", 1); f.advance(4000); await until(() => f.deliveries.length === 1, "failed delivery");
      assert.equal(f.store.state.finals["666"].delivered, false); f.advance(1000); await until(() => f.store.state.finals["666"].delivered, "retry ack");
      assert.equal(attempts, 2); assert.deepEqual(f.deliveries[0], f.deliveries[1]); assert.ok(!JSON.stringify(f.monitor.diagnostics()).includes(SECRET));
    } finally { await f.monitor.stop(); }
  });
  await test("stream gap and missing participant never fabricate an unanswered call", async () => {
    const f = fixture(); await f.start();
    try { await f.upsert("901", 1, 777, "Ringing"); f.sockets[0].terminate(); await until(() => f.sockets.length === 2, "reconnect");
      await until(() => f.requests.filter(r => r.path === "/callcontrol/912").length >= 2, "resync");
      await f.remove("901", 1); f.advance(4000); await until(() => Boolean(f.store.state.finals["777"]), "quarantine"); assert.equal(f.deliveries.length, 0);
    } finally { await f.monitor.stop(); }
  });
  await test("no synthetic callid; internal customers, busy and commercial outcomes are never invented", () => {
    for (const dn of monitoredDns()) {
      const state = emptyMonitorState();
      observeParticipant(state, { dn: "901", id: 1, callid: 888, status: "Ringing", party_caller_id: dn, party_dn: dn }, "2026-10-16T10:00:00Z");
      removeParticipant(state, "901", 1, "2026-10-16T10:00:01Z"); finalizeCalls(state, Date.parse("2026-10-16T10:00:05Z")); assert.equal(state.finals["888"].event, null);
    }
    for (const status of ["Busy", "interested", "callback"]) {
      const state = emptyMonitorState(); observeParticipant(state, { dn: "901", id: 1, callid: 889, status, party_caller_id: "+393331234567" }, "2026-10-16T10:00:00Z");
      removeParticipant(state, "901", 1, "2026-10-16T10:00:01Z"); finalizeCalls(state, Date.parse("2026-10-16T10:00:05Z")); assert.equal(state.finals["889"].event, null);
    }
    const state = emptyMonitorState(); observeParticipant(state, { dn: "901", id: 1, callid: undefined as any, status: "Ringing" }, new Date().toISOString()); assert.equal(Object.keys(state.calls).length, 0);
  });
  await test("durable local lease, outbox and restart dedup without destructive migration", async () => {
    const file = path.join(os.tmpdir(), "leadium-3cx-test-" + process.pid + ".json");
    const a = createMonitorStore("https://pbx.test", file), b = createMonitorStore("https://pbx.test", file);
    try { const state = await a.claim(); assert.ok(state); assert.equal(await b.claim(), null);
      state.finals["native-id"] = { event: null, delivered: true }; await a.save(state); await a.release();
      assert.ok(await b.claim()); assert.equal(await b.hasFinal("native-id"), true); await b.release();
    } finally { if (fs.existsSync(file)) fs.unlinkSync(file); }
  });
  await test("crashed owner's expired lease can be claimed but live lease cannot be stolen or renewed by old owner", async () => {
    const file = path.join(os.tmpdir(), "leadium-3cx-expired-" + process.pid + ".json");
    const a = createMonitorStore("https://pbx.test", file), b = createMonitorStore("https://pbx.test", file);
    try {
      assert.ok(await a.claim()); assert.equal(await b.claim(), null); await a.renew();
      const row = JSON.parse(fs.readFileSync(file, "utf8")); row.leaseUntil = Date.now() - 1;
      fs.writeFileSync(file, JSON.stringify(row));
      await assert.rejects(a.renew(), /lease lost/);
      assert.ok(await b.claim()); await b.renew();
      await assert.rejects(a.save(emptyMonitorState()), /lease lost/);
      await a.release(); assert.equal(await a.claim(), null, "old owner release cannot evict new owner");
      await b.release(); assert.ok(await a.claim(), "graceful restart can claim immediately"); await a.release();
    } finally { fs.rmSync(file, { force: true }); }
  });
  await test("Mongo contract: exclusive lease, durable pending outbox, acknowledgement and native-id uniqueness", async () => {
    const oldEnabled = mongo.isMongoEnabled, oldDb = mongo.getMongoDb;
    let checkpoint: any = null;
    const finals = new Map<string, any>();
    const checkpointCollection = {
      findOneAndUpdate: async (filter: any, update: any) => {
        if (checkpoint && checkpoint.owner !== filter.$or[0].owner && checkpoint.leaseUntil > Date.now()) throw Object.assign(new Error("duplicate"), { code: 11000 });
        checkpoint = { ...(checkpoint || update.$setOnInsert), _id: filter._id, ...update.$set }; return clone(checkpoint);
      },
      updateOne: async (filter: any, update: any) => {
        if (!checkpoint || checkpoint.owner !== filter.owner || (filter.leaseUntil && checkpoint.leaseUntil <= Date.now())) return { matchedCount: 0 };
        Object.assign(checkpoint, clone(update.$set || {})); if (update.$unset?.owner !== undefined) delete checkpoint.owner;
        return { matchedCount: 1 };
      }
    };
    const finalCollection = {
      updateOne: async (filter: any, update: any) => { finals.set(filter._id, { _id: filter._id, ...clone(update.$set) }); return { matchedCount: 1 }; },
      findOne: async (filter: any) => finals.get(filter._id) || null,
      find: (filter: any) => ({ toArray: async () => [...finals.values()].filter(item => item.pbx === filter.pbx && item.delivered === filter.delivered).map(clone) })
    };
    (mongo as any).isMongoEnabled = () => true;
    (mongo as any).getMongoDb = async () => ({ collection: (name: string) => { assert.ok(["threecxMonitor", "threecxFinalCalls"].includes(name)); return name === "threecxMonitor" ? checkpointCollection : finalCollection; } });
    try {
      const a = createMonitorStore("https://mongo-pbx.test"), b = createMonitorStore("https://mongo-pbx.test");
      const state = await a.claim(); assert.ok(state); assert.equal(await b.claim(), null);
      await a.renew();
      state.finals["123"] = { delivered: false, event: { callId: "123" } as any };
      await a.save(state); assert.deepEqual(checkpoint.state.finals, {}); assert.equal(finals.size, 1);
      await a.release(); const recovered = await b.claim(); assert.equal(recovered.finals["123"].delivered, false);
      assert.equal(await b.hasFinal("123"), true);
      recovered.finals["123"].delivered = true; await b.save(recovered); await b.release();
      const reloaded = await a.claim(); assert.deepEqual(reloaded.finals, {}); assert.equal(await a.hasFinal("123"), true); assert.equal(finals.size, 1);
      checkpoint.leaseUntil = Date.now() - 1;
      await assert.rejects(a.renew(), /lease lost/); assert.ok(await b.claim());
      await assert.rejects(a.save(reloaded), /lease lost/); await a.release(); assert.equal(await a.claim(), null);
      await b.release();
    } finally { (mongo as any).isMongoEnabled = oldEnabled; (mongo as any).getMongoDb = oldDb; }
  });
  await test("HTTP timeout and shutdown abort inflight auth; provider errors never reach logs", async () => {
    let aborted = 0, requests = 0; const logs: string[] = [];
    const oldLog = console.log, oldError = console.error;
    console.log = (...args: any[]) => { logs.push(args.join(" ")); }; console.error = (...args: any[]) => { logs.push(args.join(" ")); };
    const monitor = new ThreeCxMonitor(monitorConfig({ THREECX_ENABLED: "true", THREECX_BASE_URL: "https://pbx.test", THREECX_CLIENT_ID: "leadiumcrm", THREECX_API_KEY: SECRET }), {
      store: new MemoryStore(), timeoutMs: 15, retryMs: 1000, deliver: async () => {},
      fetch: (async (_url: any, init: any) => { requests++; return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => { aborted++; reject(new Error(SECRET + TOKEN)); })); }) as any
    });
    try { monitor.start(); await until(() => aborted === 1, "HTTP timeout"); await monitor.stop(); assert.equal(requests, 1); assert.equal(monitor.diagnostics().connected, false); assert.ok(!JSON.stringify([logs, monitor.diagnostics()]).includes(SECRET)); assert.ok(!JSON.stringify([logs, monitor.diagnostics()]).includes(TOKEN)); }
    finally { await monitor.stop(); console.log = oldLog; console.error = oldError; }
  });
  await test("sequence gap resynchronizes but does not invent a missed call", async () => {
    const f = fixture(); await f.start();
    try { await f.upsert("901", 1, 999, "Ringing"); f.participants.clear();
      f.sockets[0].emit("message", JSON.stringify({ sequence: 99, event: { event_type: 0, entity: "/callcontrol" } }));
      await until(() => Boolean(f.store.state.calls["999"]?.readyAt), "gap reconcile"); f.advance(4000);
      await until(() => Boolean(f.store.state.finals["999"]), "uncertain call checkpoint"); assert.equal(f.deliveries.length, 0);
    } finally { await f.monitor.stop(); }
  });
  await test("device options: readable labels, same pseudonym as diagnostics, own DN only, unknown stays null", async () => {
    const devices = [
      { dn: "901", device_id: "raw-web", user_agent: "3CX Web Client 20.0.1" },
      { dn: "901", device_id: "raw-android", user_agent: "3CXAndroid 20.1" },
      { dn: "901", device_id: "raw-desk", user_agent: "Yealink SIP-T46U 66.86" },
      { dn: "901", device_id: "raw-secret", user_agent: SECRET + " token=abc" }
    ];
    const f = fixture({ reportedDevices: { "901": devices, "913": [] } });
    await f.start();
    try {
      const options = f.monitor.deviceOptionsForDn("901")!;
      assert.deepEqual(options.map(row => row.label), ["Client web 3CX", "App 3CX Android", "Telefono fisso", "Dispositivo 3CX"]);
      assert.deepEqual(options.map(row => row.device), f.monitor.diagnostics().observedDevices["901"].map((row: any) => row.deviceIdMasked));
      assert.ok(!JSON.stringify(options).includes("raw-") && !JSON.stringify(options).includes(SECRET), "no raw ID or unsafe user agent");
      assert.deepEqual(f.monitor.deviceOptionsForDn("913"), []);
      assert.equal(f.monitor.deviceOptionsForDn("910"), null);
    } finally { await f.monitor.stop(); }
    assert.equal(f.monitor.deviceOptionsForDn("901"), null, "not ready / disconnected is unknown, not zero");
  });
  await test("outbound trace: MakeCall callback, external leg and end per callid, both agent DNs, other-DN legs marked", async () => {
    const f = fixture({ reportedDnTypes: TENANT_DN_TYPES }); await f.start();
    try {
      await f.upsert("913", 7, 4242, "Ringing", { party_dn: "MakeCall", party_caller_id: "" });
      let live = f.monitor.liveCalls().find(row => row.callId === "4242")!;
      assert.equal(live.phase, "callback_ringing", "the operator's own device is ringing: observed callback phase");
      assert.equal(live.customerPhone, "", "no customer is invented during the callback");
      assert.equal(live.connectedAt, undefined);
      await f.upsert("913", 7, 4242, "Connected", { party_dn: "MakeCall", party_caller_id: "" });
      assert.equal(f.monitor.liveCalls().find(row => row.callId === "4242")!.phase, "callback_answered");
      assert.equal(f.monitor.liveCalls().find(row => row.callId === "4242")!.connectedAt, undefined, "answering the callback is not a customer conversation");
      await f.upsert("913", 7, 4242, "Dialing", { party_dn: "+393331234567" });
      assert.equal(f.monitor.liveCalls().find(row => row.callId === "4242")!.phase, "dialing_customer");
      await f.upsert("913", 7, 4242, "Connected", { party_dn: "+393331234567" });
      live = f.monitor.liveCalls().find(row => row.callId === "4242")!;
      assert.equal(live.phase, "connected");
      assert.ok(live.connectedAt, "conversation start is the first observed connection with the external party");
      await f.upsert("901", 8, 4242, "Ringing");
      await f.remove("913", 7);
      const trace = f.monitor.callTrace("4242")!;
      assert.equal(trace.dn, "913", "913 is traced too, not only 901");
      assert.deepEqual(trace.steps, ["makecall_callback:Ringing", "makecall_callback:Connected", "external:Dialing", "external:Connected", "901/external:Ringing", "ended"]);
      assert.ok(!JSON.stringify(trace).includes("3331234567"), "no phone number in the trace");
      const seen = Date.parse(trace.firstSeenAt);
      assert.equal(f.monitor.callTracesBetween("913", seen - 1000, seen + 1000).length, 1);
      assert.equal(f.monitor.callTracesBetween("901", seen - 1000, seen + 1000).length, 0, "attributed to its initiating DN only");
      assert.equal(f.monitor.callTrace("999999"), null);
    } finally { await f.monitor.stop(); }
  });
  console.log("All " + count + " Call Control monitoring checks passed.");
}
main().catch(error => { console.error(String(error.stack).split(SECRET).join("[redacted]").split(TOKEN).join("[redacted]")); process.exit(1); });
