import assert from "node:assert/strict";
import http from "node:http";
import { ThreeCxController, ThreeCxOAuth, LiveCall, capabilities } from "../call-service/threecx-controller";
import { monitorConfig } from "../call-service/threecx-monitor";
import { isCallControlInternal } from "../call-service/threecx-internal";

process.env.NODE_ENV = "test";
const listen = async (s: http.Server) => { await new Promise<void>(resolve => s.listen(0, "127.0.0.1", resolve)); return "http://127.0.0.1:" + (s.address() as any).port; };
async function main() {
  let rows: LiveCall[] = [
    { callId: "123", agentDn: "901", customerPhone: "+393331234567", direction: "inbound", status: "ringing", startedAt: new Date().toISOString(), participantId: 1, directControl: true },
    { callId: "456", agentDn: "913", customerPhone: "+393337654321", direction: "inbound", status: "connected", startedAt: new Date().toISOString(), participantId: 2, directControl: true }
  ];
  const pbxWrites: string[] = [];
  const observedDevices: Record<string, string[]> = { '901': ['private-device-901'], '913': ['private-device-913'] };
  const config = monitorConfig({ THREECX_ENABLED: "true", THREECX_BASE_URL: "https://pbx.invalid", THREECX_CLIENT_ID: "fixture", THREECX_API_KEY: "synthetic-only" });
  const pbx = (async (url: any, init: any) => {
    if (String(url).endsWith("/connect/token")) return Response.json({ access_token: "synthetic-token", expires_in: 3600 });
    if (init.method === "GET") {
      const pathname = new URL(url).pathname, dn = pathname.split('/')[2];
      if (!pathname.includes('/participants/')) return Response.json({ dn, participants: rows.filter(row => row.agentDn === dn).map(row => ({ id: row.participantId, dn, callid: Number(row.callId) })) });
      const parts = pathname.split('/');
      const row = rows.find(row => row.agentDn === dn && row.participantId === Number(parts[parts.length - 1]));
      return row ? Response.json({ id: row.participantId, dn, callid: Number(row.callId), status: 'Ringing', direct_control: true }) : new Response('', { status: 404 });
    }
    pbxWrites.push(new URL(url).pathname); return Response.json({ finalstatus: "Success", result: { callid: 789 }, secret: "must-not-reach-ui" });
  }) as typeof fetch;
  const pseudonym = (id: string) => "device-" + require("node:crypto").createHash("sha256").update(id).digest("hex").slice(0, 12);
  const controller = new ThreeCxController(config, new ThreeCxOAuth(config, pbx), () => rows, async () => {}, pbx, undefined, dn => observedDevices[dn] ?? null, pseudonym);
  const internal = http.createServer(async (req, res) => {
    if (!isCallControlInternal(req.headers["x-leadium-call-control"])) { res.writeHead(403); res.end(); return; }
    try {
      let result: any;
      if (req.url?.startsWith("/3cx/devices")) {
        const dn = new URL(req.url, "http://x").searchParams.get("dn") || "";
        result = { available: true, devices: observedDevices[dn]?.map(id => ({ device: pseudonym(id), label: "App 3CX Android", userAgent: "3CXAndroid", rawId: id })) ?? null };
      } else if (req.url?.startsWith("/3cx/live")) result = { available: true, calls: rows.map(({ participantId, directControl, ...call }) => ({ ...call, capabilities: capabilities({ ...call, participantId, directControl }) })) };
      else {
        let text = ""; for await (const chunk of req) text += chunk;
        const body = JSON.parse(text); result = await controller.execute(body.actor, body.action, body.input, body.callId);
      }
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(result));
    } catch (e: any) { res.writeHead(e.status || 503, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); }
  });
  process.env.CALL_SERVICE_URL = await listen(internal);
  const auth = require("./auth-store"), leads = require("../common/leadStore");
  const originalDn = auth.getUserThreeCxDn, originalLookup = leads.listLeads;
  let revoked = false;
  auth.getUserThreeCxDn = async (user: any) => revoked ? "" : user.id === "a" ? "901" : user.id === "b" ? "913" : "";
  leads.listLeads = async () => [{ id: "lead-901", fullName: "Cliente fixture", phone: "+393331234567" }];
  const gateway = require("./server");
  gateway.__setTestSession("operator-a", { id: "a", username: "alice", role: "operatore" });
  gateway.__setTestSession("operator-b", { id: "b", username: "bob", role: "operatore" });
  gateway.__setTestSession("unmapped", { id: "c", username: "admin", role: "admin" });
  gateway.__setTestSession("expired", { id: "a", username: "alice", role: "operatore" }, -1);
  const base = await listen(gateway.server);
  const post = (url: string, token: string, input: any = {}) => fetch(base + url, { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(input) });
  try {
    const { lookupThreeCxCaller } = require("./threecx-routes");
    assert.equal((await lookupThreeCxCaller(null, "3331234567")).id, "lead-901");
    leads.listLeads = async () => [{ id: "first", phone: "+393331234567" }, { id: "second", phone: "3331234567" }];
    assert.equal(await lookupThreeCxCaller(null, "+393331234567"), null, "ambiguous practices must not choose an arbitrary match");
    leads.listLeads = async () => [{ id: "lead-901", fullName: "Cliente fixture", phone: "+393331234567" }];
    for (const path of ["/api/3cx/call", "/api/3cx/events", "/api/3cx/session", "/api/3cx/calls/123/answer"]) assert.equal((await fetch(base + path)).status, 401);
    assert.equal((await post("/api/3cx/call", "expired", { phone: "+393331234567" })).status, 401);
    assert.equal((await post("/api/3cx/call", "unmapped", { phone: "+393331234567" })).status, 403);
    assert.equal((await post("/api/3cx/calls/123/answer", "operator-b")).status, 403);
    assert.equal((await post("/api/3cx/calls/456/hangup", "operator-a")).status, 403);
    assert.equal(pbxWrites.length, 0);
    console.log("PASS V2 real gateway: anonymous/expired rejected, admin without mapping rejected, operator 913 cannot act on 901");
    for (const key of ['deviceId', 'device_id', 'participantId', 'dn']) {
      const response = await post('/api/3cx/call', 'operator-a', { phone: '+393331234560', [key]: 'private-device-913' });
      assert.equal(response.status, 400);
    }
    observedDevices['901'] = [];
    let deviceResponse = await post('/api/3cx/call', 'operator-a', { phone: '+393331234561' });
    assert.equal(deviceResponse.status, 409); assert.equal((await deviceResponse.json()).error, 'Nessun dispositivo 3CX registrato per questo interno.');
    observedDevices['913'] = ['a', 'b'];
    deviceResponse = await post('/api/3cx/call', 'operator-b', { phone: '+393331234562' });
    assert.equal(deviceResponse.status, 409); assert.equal((await deviceResponse.json()).error, 'Più dispositivi 3CX disponibili. Selezione dispositivo necessaria.');
    assert.equal(pbxWrites.length, 0);
    observedDevices['913'] = ['private-device-913'];
    observedDevices['901'] = ['web-device-901', 'app-device-901'];
    const listed = await (await fetch(base + "/api/3cx/devices", { headers: { Authorization: "Bearer operator-a" } })).json() as any;
    assert.equal(listed.threeCxDn, "901");
    assert.deepEqual(listed.devices.map((row: any) => row.device), [pseudonym('web-device-901'), pseudonym('app-device-901')], "own DN devices only");
    assert.ok(!JSON.stringify(listed).includes('device-901"') && !JSON.stringify(listed).includes("rawId"), "raw IDs and unexpected fields are dropped by the gateway");
    assert.equal((await fetch(base + "/api/3cx/devices", { headers: { Authorization: "Bearer unmapped" } })).status, 403);
    assert.equal((await fetch(base + "/api/3cx/devices", { method: "POST", headers: { Authorization: "Bearer operator-a" } })).status, 405);
    const picked = await post('/api/3cx/call', 'operator-a', { phone: '+393331234563', device: pseudonym('app-device-901') });
    assert.equal(picked.status, 200);
    assert.equal(pbxWrites[pbxWrites.length - 1], '/callcontrol/901/devices/app-device-901/makecall');
    const stale = await post('/api/3cx/call', 'operator-a', { phone: '+393331234564', device: pseudonym('private-device-913') });
    assert.equal(stale.status, 409); assert.equal((await stale.json()).error, 'Il dispositivo scelto non e piu collegato al tuo interno. Scegli di nuovo.');
    observedDevices['901'] = ['private-device-901'];
    console.log('PASS V2 gateway device selection: client IDs rejected, zero/multiple errors preserved, own-DN device list, explicit pseudonym honoured, stale/foreign refused');
    const session = await fetch(base + "/api/3cx/session", { headers: { Authorization: "Bearer operator-a" } });
    assert.deepEqual(await session.json(), { threeCxDn: "901", available: true });
    const streamAbort = new AbortController();
    const stream = await fetch(base + "/api/3cx/events?dn=913", { headers: { Authorization: "Bearer operator-a" }, signal: streamAbort.signal });
    assert.equal(stream.status, 200); assert.ok(stream.headers.get("content-type")?.includes("text/event-stream"));
    const reader = stream.body!.getReader(), decoder = new TextDecoder();
    const nextEvent = async () => {
      let text = "";
      while (!text.includes("\n\n")) { const part = await reader.read(); assert.equal(part.done, false); text += decoder.decode(part.value); }
      return JSON.parse(text.split("data: ")[1].split("\n")[0]);
    };
    let payload = await nextEvent(); assert.equal(payload.calls.length, 1); assert.equal(payload.calls[0].agentDn, "901"); assert.equal(payload.calls[0].leadId, "lead-901"); assert.equal(payload.calls[0].customerName, "Cliente fixture");
    assert.ok(!JSON.stringify(payload).includes("participantId")); assert.ok(!JSON.stringify(payload).includes("synthetic-token"));
    rows = rows.filter(call => call.agentDn === "913"); payload = await nextEvent(); assert.deepEqual(payload.calls, []);
    streamAbort.abort(); await reader.cancel().catch(() => null);
    const unknownAbort = new AbortController();
    const unknown = await fetch(base + "/api/3cx/events", { headers: { Authorization: "Bearer operator-b" }, signal: unknownAbort.signal });
    const unknownChunk = await unknown.body!.getReader().read(); const unknownCall = JSON.parse(decoder.decode(unknownChunk.value).split("data: ")[1].split("\n")[0]).calls[0];
    assert.equal(unknownCall.customerName, undefined); assert.equal(unknownCall.customerPhone, "+393337654321"); unknownAbort.abort();
    console.log("PASS V2 SSE: Bearer auth, own-DN isolation despite spoofed query, customer/practice matching, unknown caller, end removes call, sanitized projection");
    const accepted = await post("/api/3cx/call", "operator-a", { phone: "+393331234567" }); assert.equal(accepted.status, 200); const acceptedBody = await accepted.json() as any; assert.match(acceptedBody.attemptId, /^[a-f0-9]{8}$/); assert.deepEqual(acceptedBody, { accepted: true, callId: "789", attemptId: acceptedBody.attemptId });
    assert.equal(pbxWrites[pbxWrites.length - 1], '/callcontrol/901/devices/private-device-901/makecall');
    const ended = await post('/api/3cx/calls/789/hangup', 'operator-a'); assert.equal(ended.status, 200);
    assert.deepEqual(await ended.json(), { accepted: true, alreadyEnded: true });
    revoked = true; assert.equal((await post("/api/3cx/call", "operator-a", { phone: "+393331234567" })).status, 403);
    console.log("PASS V2 fresh persisted mapping: revocation takes effect without relogin; makecall output sanitized");
  } finally {
    auth.getUserThreeCxDn = originalDn; leads.listLeads = originalLookup;
    gateway.server.closeAllConnections(); internal.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => gateway.server.close(() => resolve())), new Promise<void>(resolve => internal.close(() => resolve()))]);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
