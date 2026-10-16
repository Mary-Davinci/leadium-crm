import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { handleThreeCxV2 } from "./threecx-routes";

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
class ResponseFixture extends EventEmitter {
  headersSent = false; destroyed = false; chunks: string[] = [];
  onCalls?: () => void;
  writeHead() { this.headersSent = true; }
  flushHeaders() {}
  write(data: string) { this.chunks.push(data); if (data.startsWith("event: calls")) this.onCalls?.(); return true; }
  end() {}
  disconnect() { this.destroyed = true; this.emit("close"); }
}
const user = { id: "fixture-user", username: "fixture", name: "Fixture", role: "operatore" as const };
const req = { method: "GET" } as any;
async function main() {
  {
    const res = new ResponseFixture(); let reads = 0, valid = true;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const pending = handleThreeCxV2(req, res as any, "/api/3cx/events", user, () => valid, {
      base: "http://fixture.invalid", tickMs: 5,
      resolveDn: async () => { await gate; return "901"; },
      http: (async () => { reads++; return Response.json({ available: true, calls: [] }); }) as typeof fetch
    });
    res.disconnect(); release();
    const guard = setTimeout(() => { valid = false; }, 30);
    await pending; clearTimeout(guard);
    assert.equal(reads, 0, "disconnect during identity lookup must not start internal polling");
    assert.equal(res.listenerCount("close"), 0); assert.equal(res.headersSent, false);
    console.log("PASS SSE early disconnect: zero downstream reads, no polling or close-listener leak");
  }
  {
    const res = new ResponseFixture(); let reads = 0;
    let first!: () => void; const received = new Promise<void>(resolve => { first = resolve; }); res.onCalls = first;
    const pending = handleThreeCxV2(req, res as any, "/api/3cx/events", user, () => true, {
      base: "http://fixture.invalid", tickMs: 5, resolveDn: async () => "901",
      http: (async () => { reads++; return Response.json({ available: true, calls: [] }); }) as typeof fetch
    });
    await received; res.disconnect(); await pending;
    const before = reads; await wait(25); assert.equal(reads, before); assert.equal(res.listenerCount("close"), 0);
    console.log("PASS SSE disconnect during active stream stops reads and removes close listener");
  }
  {
    const res = new ResponseFixture(); let aborted = 0;
    let started!: () => void; const reading = new Promise<void>(resolve => { started = resolve; });
    const pending = handleThreeCxV2(req, res as any, "/api/3cx/events", user, () => true, {
      base: "http://fixture.invalid", tickMs: 5, resolveDn: async () => "901",
      http: (async (_url: any, options: any) => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => { aborted++; reject(Error("synthetic-provider-secret")); }, { once: true }); started();
      })) as typeof fetch
    });
    await reading; res.disconnect(); await pending;
    assert.equal(aborted, 1); assert.equal(res.listenerCount("close"), 0); assert.deepEqual(res.chunks, []);
    console.log("PASS SSE disconnect aborts inflight read without exposing provider errors");
  }
  for (const revoke of ["session", "mapping"]) {
    const res = new ResponseFixture(); let valid = true, dn = "901", reads = 0;
    res.onCalls = () => { if (revoke === "session") valid = false; else dn = ""; };
    await handleThreeCxV2(req, res as any, "/api/3cx/events", user, () => valid, {
      base: "http://fixture.invalid", tickMs: 5, resolveDn: async () => dn,
      http: (async () => { reads++; return Response.json({ available: true, calls: [] }); }) as typeof fetch
    });
    assert.equal(reads, 1); assert.equal(res.listenerCount("close"), 0);
    if (revoke === "session") assert.ok(res.chunks.join("").includes("event: session_expired"));
    console.log("PASS SSE " + revoke + " revocation closes stream before further downstream reads");
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
