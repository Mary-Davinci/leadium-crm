import assert from "node:assert/strict";
import { ThreeCxController, ThreeCxOAuth, normalizeCallPhone, validateThreeCxDn, LiveCall, capabilities, auditThreeCxAction } from "./threecx-controller";
import { monitorConfig } from "./threecx-monitor";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SECRET = "fixture-provider-secret", TOKEN = "fixture-provider-token";
const config = monitorConfig({ THREECX_ENABLED: "true", THREECX_BASE_URL: "https://pbx.invalid", THREECX_CLIENT_ID: "fixture", THREECX_API_KEY: SECRET });
const actor = (dn = "901") => ({ userId: "user-" + dn, threeCxDn: dn });
const liveCall = (dn = "901"): LiveCall => ({ callId: "123", agentDn: dn, customerPhone: "+393331234567", direction: "inbound", status: "ringing", startedAt: new Date().toISOString(), participantId: 1, directControl: true });
function fixture(options: { devices?: readonly string[] | null; accepted?: number; noFinalStatus?: boolean; empty?: boolean; participantMissing?: boolean; dropMissing?: boolean; endOnMissing?: boolean; providerTimeout?: boolean; returnedParticipantId?: number; currentParticipantId?: number; participantStatus?: string; auth?: number; status?: number; finalstatus?: string; direct?: boolean; stale?: boolean; timeout?: boolean; auditFail?: boolean } = {}) {
  const requests: any[] = [], audits: any[] = [], makecalls: string[] = [];
  let rows = [liveCall()];
  const http = (async (url: any, init: any) => {
    const path = new URL(url).pathname; requests.push({ path, method: init.method, body: init.body });
    if (options.timeout) return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error(SECRET + TOKEN)), { once: true }));
    if (path === "/connect/token") return new Response(JSON.stringify(options.auth ? { error: SECRET } : { access_token: TOKEN, expires_in: 3600 }), { status: options.auth || 200 });
    if (options.providerTimeout) return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error(SECRET + TOKEN)), { once: true }));
    assert.equal(init.headers.Authorization, "Bearer " + TOKEN);
    if (options.status) return new Response(SECRET + TOKEN, { status: options.status });
    if ((options.participantMissing && init.method === "GET" && path.includes('/participants/')) || (options.dropMissing && path.endsWith('/drop'))) { if (options.endOnMissing) rows = []; return new Response(SECRET + TOKEN, { status: 404 }); }
    const dn = path.split('/')[2];
    if (init.method === "GET" && !path.includes('/participants/')) return Response.json({ dn, participants: rows.map(row => ({ id: row.participantId, dn: row.agentDn, callid: Number(row.callId) })) });
    if (init.method === "GET") return Response.json({ id: options.currentParticipantId ?? rows[0]?.participantId ?? 1, callid: options.stale ? 999 : 123, dn, status: options.participantStatus || (rows[0]?.status === "ringing" ? "Ringing" : "Connected"), direct_control: options.direct ?? true });
    return new Response(options.empty ? '' : JSON.stringify({ ...(!options.noFinalStatus ? { finalstatus: options.finalstatus || "Success" } : {}), result: { callid: 123, dn,
      ...(path.endsWith('/makecall') ? { device_id: decodeURIComponent(path.split('/')[4]) } : {}),
      ...(options.returnedParticipantId !== undefined ? { id: options.returnedParticipantId } : {}) }, secret: SECRET, access_token: TOKEN }), { status: options.accepted || 200 });
  }) as typeof fetch;
  const oauth = new ThreeCxOAuth(config, http, 20);
  const controller = new ThreeCxController(config, oauth, () => rows, async row => { if (options.auditFail) throw Error(SECRET); audits.push(row); }, http, 20, dn => options.devices === undefined ? [`private-device-${dn}`] : options.devices, undefined, id => makecalls.push(id));
  return { controller, makecalls, oauth, http, requests, audits, rows, setRows: (next: LiveCall[]) => { rows = next; } };
}
async function main() {
  process.env.NODE_ENV = "test";
  const auditBase = path.join(os.tmpdir(), "leadium-v2-audit-" + process.pid);
  const oldDbFile = process.env.JSON_DB_FILE; process.env.JSON_DB_FILE = auditBase;
  const audit = { ...actor(), action: "hangup", callId: "123", timestamp: new Date().toISOString(), result: "success" as const };
  try { await auditThreeCxAction(audit); assert.deepEqual(JSON.parse((await fs.readFile(auditBase + ".threecx-actions.ndjson", "utf8")).trim()), audit); }
  finally { await fs.unlink(auditBase + ".threecx-actions.ndjson").catch(() => null); if (oldDbFile === undefined) delete process.env.JSON_DB_FILE; else process.env.JSON_DB_FILE = oldDbFile; }
  console.log("PASS local persistent action audit stores only actor, DN, action, callId, server timestamp and result");
  for (const dn of ["901", "913"]) {
    const f = fixture(); const result = await f.controller.execute(actor(dn), "call", { phone: "+39 (333) 123-4567" });
    assert.match((result as any).attemptId, /^[a-f0-9]{8}$/);
    assert.deepEqual({ ...result, attemptId: undefined }, { accepted: true, callId: "123", attemptId: undefined });
    assert.equal(f.requests[f.requests.length - 1].path, `/callcontrol/${dn}/devices/private-device-${dn}/makecall`); assert.deepEqual(JSON.parse(f.requests[f.requests.length - 1].body), { destination: "+393331234567", timeout: 30 });
    assert.deepEqual(f.makecalls, ["123"], "the monitor learns the callid of a Leadium makecall");
    assert.equal(f.audits[0].userId, "user-" + dn); assert.equal(f.audits[1].result, "success"); assert.equal(f.audits[1].callId, "123"); assert.ok(f.audits[1].timestamp);
    assert.ok(!JSON.stringify([result, f.audits]).includes(SECRET)); assert.ok(!JSON.stringify([result, f.audits]).includes(TOKEN));
  }
  console.log("PASS makecall 901/913: normalized external number, shared OAuth, sanitized result and durable audit contract");
  for (const devices of [[], ['a', 'b'], null] as const) {
    const f = fixture({ devices });
    await assert.rejects(f.controller.execute(actor(), 'call', { phone: '+393331234567' }), (error: any) => {
      assert.equal(error.status, devices === null ? 503 : 409);
      assert.equal(error.message, devices === null ? 'Dispositivi 3CX non ancora disponibili. Riprova tra poco.' : devices.length === 0
        ? 'Nessun dispositivo 3CX registrato per questo interno.' : 'Più dispositivi 3CX disponibili. Selezione dispositivo necessaria.'); return true;
    });
    assert.equal(f.requests.length, 0, 'no auth or call when device selection is unavailable/ambiguous');
  }
  {
    // Explicit choice among several devices: only a current pseudonym of the caller's DN is dialed.
    const pseudonym = (id: string) => 'device-' + Buffer.from(id).toString('hex').padEnd(12, '0').slice(0, 12);
    const devices = ['web-client-device', 'android-app-device'];
    const f = fixture({ devices });
    (f.controller as any).maskDevice = pseudonym;
    const chosen = await f.controller.execute(actor(), 'call', { phone: '+393331234567', device: pseudonym('android-app-device') }) as any;
    assert.equal(chosen.accepted, true);
    assert.equal(f.requests[f.requests.length - 1].path, '/callcontrol/901/devices/android-app-device/makecall', 'the chosen device, not the first one');
    assert.equal((f.controller.recentAttempts()[0] as any).deviceSelection, 'explicit');
    const writes = f.requests.length;
    for (const [device, status] of [[pseudonym('gone-device'), 409], ['device-zzzzzzzzzzzz', 400], ['web-client-device', 400], [42, 400]] as const) {
      (f.controller as any).recent.clear();
      await assert.rejects(f.controller.execute(actor(), 'call', { phone: '+393331234567', device }), (error: any) => error.status === status);
    }
    assert.equal(f.requests.length, writes, 'unknown, foreign, malformed or raw device IDs never reach the PBX');
    assert.equal((f.controller.recentAttempts()[3] as any).code, 'device_unavailable');
    const other = fixture({ devices: ['device-of-913'] }); (other.controller as any).maskDevice = pseudonym;
    await assert.rejects(other.controller.execute(actor('901'), 'call', { phone: '+393331234567', device: pseudonym('android-app-device') }), (error: any) => error.status === 409);
    assert.equal(other.requests.length, 0, 'a pseudonym from another DN list is not available to this DN');
    const single = fixture({ devices: ['only-device'] }); (single.controller as any).maskDevice = pseudonym;
    await single.controller.execute(actor(), 'call', { phone: '+393331234567' });
    assert.equal((single.controller.recentAttempts()[0] as any).deviceSelection, 'only_device');
  }
  console.log("PASS device choice: single device used directly, explicit pseudonym validated against the DN's current devices, never the first by default");
  for (const id of ['', '..', 'private\ndevice']) {
    const f = fixture({ devices: [id] });
    await assert.rejects(f.controller.execute(actor(), 'call', { phone: '+393331234567' }), (error: any) => error.status === 503);
    assert.equal(f.requests.length, 0);
  }
  {
    const deviceId = 'sip:901@fixture.invalid;device/id?x=1'; const f = fixture({ devices: [deviceId] });
    const result = await f.controller.execute(actor(), 'call', { phone: '+393331234567' });
    assert.ok(f.requests.some(row => row.path === '/callcontrol/901/devices/' + encodeURIComponent(deviceId) + '/makecall'));
    assert.ok(!JSON.stringify(result).includes(deviceId)); assert.ok(!JSON.stringify(f.audits).includes(deviceId));
  }
  for (const accepted of [200, 202]) for (const noFinalStatus of [true, false]) {
    const f = fixture({ accepted, noFinalStatus });
    assert.deepEqual(await f.controller.execute(actor(), 'call', { phone: '+393331234567' }), { accepted: true, callId: '123', attemptId: (f.controller.recentAttempts()[0] as any).attemptId });
    assert.ok(!f.requests.some(row => /^\/callcontrol\/\d+\/makecall$/.test(row.path)), 'legacy DN endpoint is never used');
  }
  for (const accepted of [200, 202]) {
    const f = fixture({ accepted, empty: true });
    assert.deepEqual(await f.controller.execute(actor(), 'call', { phone: '+393331234567' }), { accepted: true, attemptId: (f.controller.recentAttempts()[0] as any).attemptId });
    const rejected = fixture({ accepted, finalstatus: 'Failed' });
    await assert.rejects(rejected.controller.execute(actor(), 'call', { phone: '+393331234567' }), (error: any) => error.status === 409);
  }
  console.log('PASS device selection 0/1/multiple/unknown, safe encoding, 200/202, finalstatus and no raw device ID in result/audit');
  for (const dn of ["", "910", "920", "999"]) await assert.rejects(fixture().controller.execute(actor(dn), "call", { phone: "+393331234567" }));
  for (const phone of ["901", "913", "*123#", "abc1234567", "12+33334444", "++393331234567", "123", 12345678, "1234567890123456", ""]) {
    assert.throws(() => normalizeCallPhone(phone)); const f = fixture(); await assert.rejects(f.controller.execute(actor(), "call", { phone })); assert.equal(f.requests.length, 0);
  }
  assert.equal(normalizeCallPhone("00393331234567"), "+393331234567");
  for (const dn of ["901", "913", ""]) assert.equal(validateThreeCxDn(dn), dn);
  for (const extra of [{ dn: "913" }, { threeCxDn: "913" }, { actor: actor("913") }, { deviceId: 'private-device-913' }, { device_id: 'private-device-913' }]) {
    const f = fixture(); await assert.rejects(f.controller.execute(actor(), "call", { phone: "+393331234567", ...extra })); assert.equal(f.requests.length, 0);
  }
  console.log("PASS missing/invalid DN, phone, short codes and client-supplied identities rejected without PBX calls");
  {
    const f = fixture(); const pending = Promise.all(Array.from({ length: 6 }, () => f.controller.execute(actor(), "call", { phone: "+393331234567" })));
    await assert.rejects(f.controller.execute(actor(), "call", { phone: "+393331234568" }), /Attendi/); await pending;
    await f.controller.execute(actor(), "call", { phone: "+393331234567" });
    assert.equal(f.requests.filter(row => row.path.endsWith("makecall")).length, 1);
    assert.equal(f.requests.filter(row => row.path === "/connect/token").length, 1);
    const cached = await Promise.all([f.oauth.get(), f.oauth.get()]); assert.equal(cached[0].token, cached[1].token);
  }
  console.log("PASS double-click/inflight dedup, retry suppression and OAuth caching");
  for (const options of [{ auth: 401 }, { timeout: true }, { providerTimeout: true }, { status: 403 }, { finalstatus: "Failed" }]) {
    const f = fixture(options); try { await f.controller.execute(actor(), "call", { phone: "+393331234567" }); assert.fail(); }
    catch (error: any) { assert.ok(!error.message.includes(SECRET)); assert.ok(!error.message.includes(TOKEN)); }
    assert.equal(f.audits[f.audits.length - 1].result, "failure");
  }
  {
    const f = fixture({ auditFail: true }); await assert.rejects(f.controller.execute(actor(), "call", { phone: "+393331234567" })); assert.equal(f.requests.length, 0);
    let accessed = 0; const env: any = { THREECX_ENABLED: "false" }; Object.defineProperty(env, "THREECX_API_KEY", { get() { accessed++; throw Error(); } });
    const disabled = monitorConfig(env), oauth = new ThreeCxOAuth(disabled, f.http);
    await assert.rejects(new ThreeCxController(disabled, oauth, () => [], async () => {}, f.http).execute(actor(), "call", { phone: "+393331234567" }));
    assert.equal(accessed, 0); assert.equal(f.requests.length, 0);
  }
  console.log("PASS auth failure, timeout, provider rejection, audit failure and enabled=false fail closed");
  {
    const f = fixture(); await assert.rejects(f.controller.execute(actor("913"), "answer", {}, "123"), /tuo interno/); assert.equal(f.requests.length, 0);
  }
  for (const direct of [true, false]) {
    const f = fixture({ direct });
    if (direct) { await f.controller.execute(actor(), "answer", {}, "123"); assert.ok(f.requests.some(row => row.path.endsWith("/answer"))); }
    else { await assert.rejects(f.controller.execute(actor(), "answer", {}, "123"), /non supportata/); assert.ok(!f.requests.some(row => row.method === "POST" && row.path !== "/connect/token")); }
  }
  for (const action of ["hangup", "transfer"]) for (const target of action === "transfer" ? ["913", "910", "911", "912"] : [undefined]) {
    const f = fixture(); f.setRows([{ ...liveCall(), status: "connected" }]);
    await f.controller.execute(actor(), action, action === "transfer" ? { target } : {}, "123");
    assert.ok(f.requests[f.requests.length - 1].path.endsWith(action === "transfer" ? "/transferto" : "/drop"));
  }
  for (const target of ["901", "999", "+393331234567", "920"]) {
    const f = fixture(); f.setRows([{ ...liveCall(), status: "connected" }]);
    await assert.rejects(f.controller.execute(actor(), "transfer", { target }, "123"), /non autorizzata/);
    assert.ok(!f.requests.some(row => row.path.endsWith("transferto")));
  }
  for (const action of ["hold", "resume"]) {
    const f = fixture(); await assert.rejects(f.controller.execute(actor(), action, {}, "123"), /non supportata/); assert.equal(f.requests.length, 0);
  }
  {
    const f = fixture({ stale: true }); await assert.rejects(f.controller.execute(actor(), "hangup", {}, "123"), /non più disponibile/);
    assert.equal(f.requests.filter(row => row.method === "POST" && row.path !== "/connect/token").length, 0);
    assert.deepEqual(capabilities(liveCall()), { answer: true, hangup: true, transfer: false, hold: false, resume: false });
  }
  console.log("PASS IDOR, fresh participant identity, direct_control, drop, transfer allowlist; undocumented hold/resume never requested");
  for (const dn of ['901', '913']) {
    const f = fixture({ returnedParticipantId: 1, participantStatus: 'Dialing' });
    await f.controller.execute(actor(dn), 'call', { phone: '+393331234567' });
    f.setRows([{ ...liveCall(dn), participantId: 7 }]);
    assert.deepEqual(await f.controller.execute(actor(dn), 'hangup', {}, '123'), { accepted: true });
    assert.ok(f.requests.some(row => row.path === `/callcontrol/${dn}/participants/7/drop`));
    assert.ok(!f.requests.some(row => row.path.endsWith('/participants/1/drop')), 'returned setup participant must not override current participant');
    f.setRows([]); (f.controller as any).recent.clear();
    assert.deepEqual(await f.controller.execute(actor(dn), 'hangup', {}, '123'), { accepted: true, alreadyEnded: true });
    const other = actor(dn === '901' ? '913' : '901');
    await assert.rejects(f.controller.execute(other, 'hangup', {}, '123'), (error: any) => error.status === 403);
  }
  {
    const f = fixture({ returnedParticipantId: 1 });
    await f.controller.execute(actor(), 'call', { phone: '+393331234567' }); f.setRows([]);
    assert.deepEqual(await f.controller.execute(actor(), 'hangup', {}, '123'), { accepted: true, alreadyEnded: true });
    assert.ok(!f.requests.some(row => row.path.endsWith('/drop')));
  }
  for (const options of [{ participantMissing: true }, { dropMissing: true }]) {
    const f = fixture({ ...options, endOnMissing: true });
    assert.deepEqual(await f.controller.execute(actor(), 'hangup', {}, '123'), { accepted: true, alreadyEnded: true });
    const handover = fixture(options);
    await assert.rejects(handover.controller.execute(actor(), 'hangup', {}, '123'), (error: any) => error.status === 409 && !error.message.includes(SECRET));
  }
  {
    const f = fixture({ currentParticipantId: 8 });
    await assert.rejects(f.controller.execute(actor(), 'hangup', {}, '123'), (error: any) => error.status === 409);
    assert.ok(!f.requests.some(row => row.path.endsWith('/drop')));
    await assert.rejects(f.controller.execute(actor(), 'hangup', { participantId: 8 }, '123'), (error: any) => error.status === 400);
  }
  console.log('PASS hangup fresh DN and participant, replaced initiator, Dialing, stale identity refusal, ended/race idempotency and 901/913 isolation');
  {
    const f = fixture();
    for (let i = 0; i < 12; i++) { (f.controller as any).recent.clear(); await f.controller.execute(actor(), "call", { phone: "+393331234567" }); }
    (f.controller as any).recent.clear(); await assert.rejects(f.controller.execute(actor(), "call", { phone: "+393331234567" }), /Troppi comandi/);
    assert.equal(f.requests.filter(row => row.path.endsWith("makecall")).length, 12);
  }
  console.log("PASS per-DN rate limit rejects the thirteenth command per minute without provider write");
  {
    const logged: string[] = [], originalLog = console.log;
    console.log = (...args: unknown[]) => { logged.push(args.join(" ")); };
    try {
      const ok = fixture(); const result: any = await ok.controller.execute(actor(), "call", { phone: "+39 333 123 4567" });
      const trace = (dn: string) => ({ dn, firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), steps: ["makecall_callback:Ringing", "ended"], ended: true });
      const [accepted] = ok.controller.recentAttempts({ trace: id => id === "123" ? trace("901") : null, between: () => [] }) as any[];
      assert.equal(accepted.correlation, "callid"); assert.match(accepted.deviceMasked, /^device-/);
      assert.equal((ok.controller.recentAttempts({ trace: () => trace("913"), between: () => [] })[0] as any).correlation, "callid_other_dn", "a trace on another DN is only uncertain");
      assert.equal((ok.controller.recentAttempts()[0] as any).correlation, "pending", "inside the window silence is pending, not failure");
      assert.equal((ok.controller.recentAttempts(undefined, Date.now() + 120000)[0] as any).correlation, "not_observed");
      assert.equal(accepted.attemptId, result.attemptId); assert.equal(accepted.outcome, "accepted"); assert.equal(accepted.code, "accepted_with_callid");
      assert.equal(accepted.httpStatus, 200); assert.equal(accepted.finalStatus, "Success"); assert.equal(accepted.deviceCount, 1);
      assert.deepEqual(accepted.destination, { format: "international", digits: 12, lastDigits: "67" }); assert.equal(accepted.callId, "***123");
      assert.deepEqual(accepted.observation.steps, ["makecall_callback:Ringing", "ended"]);
      const ack = fixture({ empty: true, accepted: 202 }); await ack.controller.execute(actor(), "call", { phone: "3331234567" });
      const one = [{ callId: "555", ...trace("901") }];
      assert.equal((ack.controller.recentAttempts({ trace: () => null, between: () => one })[0] as any).correlation, "probable_no_callid", "no callid: a single candidate is only probable");
      const two = ack.controller.recentAttempts({ trace: () => null, between: () => [...one, { callId: "556", ...trace("901") }] })[0] as any;
      assert.equal(two.correlation, "ambiguous_no_callid"); assert.equal(two.observation, undefined, "concurrent calls are never attributed");
      const [empty] = ack.controller.recentAttempts() as any[];
      assert.equal(empty.code, "accepted_without_callid", "an empty 202 is an acknowledgement, not an observed call"); assert.equal(empty.callId, undefined);
      assert.equal(empty.destination.format, "national");
      const many = fixture({ devices: ["a", "b"] }); await assert.rejects(many.controller.execute(actor(), "call", { phone: "+393331234567" }));
      assert.deepEqual((({ outcome, code, deviceCount }) => ({ outcome, code, deviceCount }))(many.controller.recentAttempts()[0] as any), { outcome: "rejected_before_pbx", code: "multiple_devices", deviceCount: 2 });
      const refused = fixture({ status: 500 }); await assert.rejects(refused.controller.execute(actor(), "call", { phone: "+393331234567" }));
      assert.deepEqual((({ outcome, code, httpStatus }) => ({ outcome, code, httpStatus }))(refused.controller.recentAttempts()[0] as any), { outcome: "rejected_by_pbx", code: "http_500", httpStatus: 500 });
      const failed = fixture({ finalstatus: "Failed" }); await assert.rejects(failed.controller.execute(actor(), "call", { phone: "+393331234567" }));
      assert.equal((failed.controller.recentAttempts()[0] as any).code, "final_status_not_success");
      const down = fixture({ providerTimeout: true }); await assert.rejects(down.controller.execute(actor(), "call", { phone: "+393331234567" }));
      assert.equal((down.controller.recentAttempts()[0] as any).outcome, "pbx_unreachable");
      const text = JSON.stringify([logged, ok.controller.recentAttempts(), refused.controller.recentAttempts()]);
      for (const secret of [SECRET, TOKEN, "3331234567", "private-device-901"]) assert.ok(!text.includes(secret), "diagnostics must not expose " + secret);
    } finally { console.log = originalLog; }
  }
  console.log("PASS makecall attempts distinguish acknowledgement, PBX rejection and pre-PBX failures without secrets or full numbers");
}
const keepAlive = setInterval(() => {}, 1000); // AbortSignal.timeout timers are unref'ed by Node.
main().catch(error => { console.error(String(error).split(SECRET).join("[redacted]").split(TOKEN).join("[redacted]")); process.exitCode = 1; }).finally(() => clearInterval(keepAlive));
