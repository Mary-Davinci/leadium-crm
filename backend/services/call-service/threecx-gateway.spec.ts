import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

process.env.NODE_ENV = "test";
process.env.THREECX_ENABLED = "false";
process.env.THREECX_CLIENT_ID = "leadiumcrm";
process.env.THREECX_BASE_URL = "https://pbx.test";
process.env.CALL_SERVICE_PORT = "0";
process.env.THREECX_WEBHOOK_SECRET = "fixture-webhook-secret";
const dbFile = path.join(os.tmpdir(), "leadium-3cx-gateway-" + process.pid + ".json");
process.env.JSON_DB_FILE = dbFile;
process.env.META_CRM_SYNC_ENABLED = "false";
const listen = async (server: any) => { await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); return "http://127.0.0.1:" + server.address().port; };
async function main() {
  const lead = require("../lead-service/server");
  const leadUrl = await listen(lead.server);
  process.env.LEAD_SERVICE_URL = leadUrl;
  const service = require("./server");
  if (!service.server.listening) await new Promise<void>(resolve => service.server.once("listening", resolve));
  process.env.CALL_SERVICE_URL = "http://127.0.0.1:" + service.server.address().port;
  const gateway = require("../api-gateway/server");
  gateway.__setTestSession("3cx-admin", { id: "a", username: "admin", role: "admin" });
  gateway.__setTestSession("3cx-op", { id: "o", username: "operatore", role: "operatore" });
  const base = await listen(gateway.server);
  try {
    const anon = await fetch(base + "/api/3cx/diagnostics"); assert.equal(anon.status, 401);
    const op = await fetch(base + "/api/3cx/diagnostics", { headers: { Authorization: "Bearer 3cx-op" } }); assert.equal(op.status, 403);
    const admin = await fetch(base + "/api/3cx/diagnostics", { headers: { Authorization: "Bearer 3cx-admin" } }); assert.equal(admin.status, 200);
    const body = await admin.json() as any;
    assert.equal(body.enabled, false); assert.equal(body.connected, false);
    assert.deepEqual(Object.keys(body).sort(), ["enabled", "configured", "connected", "lastConnectedAt", "lastEventAt", "lastCallId", "lastError"].sort());
    console.log("PASS 3CX diagnostics: anonymous 401, operator 403, admin 200; disabled listener");
    const created = await fetch(leadUrl + "/leads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fullName: "Fixture 3CX", phone: "+393331234567" }) });
    const customer = await created.json() as any;
    const event = { callId: "native-final-1", from: customer.phone, disposition: "answered", agent: "901" };
    const webhook = async (secret: string) => fetch(base + "/api/3cx/webhook", { method: "POST", headers: { "Content-Type": "application/json", "X-Leadium-3CX-Secret": secret }, body: JSON.stringify(event) });
    assert.equal((await webhook("wrong")).status, 401);
    const first = await webhook("fixture-webhook-secret"); assert.equal(first.status, 200); assert.equal((await first.json() as any).matched, true);
    const duplicate = await webhook("fixture-webhook-secret"); assert.equal((await duplicate.json() as any).duplicate, true);
    console.log("PASS legacy 3CX webhook: secret guard, forwarding through call-service, native-id retry dedup");
  } finally {
    await service.stopCallService();
    await new Promise<void>(resolve => gateway.server.close(() => resolve()));
    await new Promise<void>(resolve => lead.server.close(() => resolve()));
    if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
  }
}
main().catch(() => { console.error("3CX gateway integration checks failed"); process.exit(1); });
