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
function fixture(options: { auth?: number; status?: number; finalstatus?: string; direct?: boolean; stale?: boolean; timeout?: boolean; auditFail?: boolean } = {}) {
  const requests: any[] = [], audits: any[] = [];
  let rows = [liveCall()];
  const http = (async (url: any, init: any) => {
    const path = new URL(url).pathname; requests.push({ path, method: init.method, body: init.body });
    if (options.timeout) return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error(SECRET + TOKEN)), { once: true }));
    if (path === "/connect/token") return new Response(JSON.stringify(options.auth ? { error: SECRET } : { access_token: TOKEN, expires_in: 3600 }), { status: options.auth || 200 });
    assert.equal(init.headers.Authorization, "Bearer " + TOKEN);
    if (options.status) return new Response(SECRET + TOKEN, { status: options.status });
    if (init.method === "GET") return Response.json({ id: 1, callid: options.stale ? 999 : 123, dn: rows[0].agentDn, status: rows[0].status === "ringing" ? "Ringing" : "Connected", direct_control: options.direct ?? true });
    return Response.json({ finalstatus: options.finalstatus || "Success", result: { callid: 123 }, secret: SECRET, access_token: TOKEN });
  }) as typeof fetch;
  const oauth = new ThreeCxOAuth(config, http, 20);
  const controller = new ThreeCxController(config, oauth, () => rows, async row => { if (options.auditFail) throw Error(SECRET); audits.push(row); }, http, 20);
  return { controller, oauth, http, requests, audits, rows, setRows: (next: LiveCall[]) => { rows = next; } };
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
    assert.deepEqual(result, { accepted: true, callId: "123" });
    assert.equal(f.requests[f.requests.length - 1].path, `/callcontrol/${dn}/makecall`); assert.deepEqual(JSON.parse(f.requests[f.requests.length - 1].body), { destination: "+393331234567" });
    assert.equal(f.audits[0].userId, "user-" + dn); assert.equal(f.audits[1].result, "success"); assert.equal(f.audits[1].callId, "123"); assert.ok(f.audits[1].timestamp);
    assert.ok(!JSON.stringify([result, f.audits]).includes(SECRET)); assert.ok(!JSON.stringify([result, f.audits]).includes(TOKEN));
  }
  console.log("PASS makecall 901/913: normalized external number, shared OAuth, sanitized result and durable audit contract");
  for (const dn of ["", "910", "920", "999"]) await assert.rejects(fixture().controller.execute(actor(dn), "call", { phone: "+393331234567" }));
  for (const phone of ["901", "913", "*123#", "abc1234567", "12+33334444", "++393331234567", "123", 12345678, "1234567890123456", ""]) {
    assert.throws(() => normalizeCallPhone(phone)); const f = fixture(); await assert.rejects(f.controller.execute(actor(), "call", { phone })); assert.equal(f.requests.length, 0);
  }
  assert.equal(normalizeCallPhone("00393331234567"), "+393331234567");
  for (const dn of ["901", "913", ""]) assert.equal(validateThreeCxDn(dn), dn);
  for (const extra of [{ dn: "913" }, { threeCxDn: "913" }, { actor: actor("913") }]) {
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
  for (const options of [{ auth: 401 }, { timeout: true }, { status: 403 }, { finalstatus: "Failed" }]) {
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
  {
    const f = fixture();
    for (let i = 0; i < 12; i++) { (f.controller as any).recent.clear(); await f.controller.execute(actor(), "call", { phone: "+393331234567" }); }
    (f.controller as any).recent.clear(); await assert.rejects(f.controller.execute(actor(), "call", { phone: "+393331234567" }), /Troppi comandi/);
    assert.equal(f.requests.filter(row => row.path.endsWith("makecall")).length, 12);
  }
  console.log("PASS per-DN rate limit rejects the thirteenth command per minute without provider write");
}
const keepAlive = setInterval(() => {}, 1000); // AbortSignal.timeout timers are unref'ed by Node.
main().catch(error => { console.error(String(error).split(SECRET).join("[redacted]").split(TOKEN).join("[redacted]")); process.exitCode = 1; }).finally(() => clearInterval(keepAlive));
