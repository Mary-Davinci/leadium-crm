import assert from "node:assert/strict";
import http from "node:http";

process.env.NODE_ENV = "test";

type RecordedRequest = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };

// Stand-in for whatsapp-service: records what the gateway forwards so we can assert the webhook
// reaches it untouched (query string, raw body, Meta signature header) without a session.
const received: RecordedRequest[] = [];
const upstream = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    received.push({ method: req.method || "", url: req.url || "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("upstream-ok");
  });
});

function listenEphemeral(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", (error?: Error) => {
      if (error) return reject(error);
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Server test non disponibile."));
      resolve(address.port);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error?: Error) => (error ? reject(error) : resolve())));
}

async function runCase(name: string, fn: () => Promise<void>) {
  received.length = 0;
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function main() {
  const upstreamPort = await listenEphemeral(upstream);
  // Must be set before the gateway module loads: it reads service URLs at import time.
  process.env.WHATSAPP_SERVICE_URL = `http://127.0.0.1:${upstreamPort}`;
  const gateway = require("./server") as typeof import("./server");
  const gatewayPort = await listenEphemeral(gateway.server);
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;

  try {
    await runCase("GET /api/whatsapp/webhook senza sessione viene inoltrato (non 401)", async () => {
      const response = await fetch(`${gatewayUrl}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=fake&hub.challenge=123`);
      assert.notEqual(response.status, 401);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "upstream-ok");
      assert.equal(received.length, 1);
      assert.equal(received[0].method, "GET");
      assert.equal(received[0].url, "/webhook?hub.mode=subscribe&hub.verify_token=fake&hub.challenge=123");
    });

    await runCase("POST /api/whatsapp/webhook senza sessione viene inoltrato con body e firma (non 401)", async () => {
      const payload = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
      const response = await fetch(`${gatewayUrl}/api/whatsapp/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=deadbeef" },
        body: payload
      });
      assert.notEqual(response.status, 401);
      assert.equal(response.status, 200);
      assert.equal(received.length, 1);
      assert.equal(received[0].method, "POST");
      assert.equal(received[0].url, "/webhook");
      assert.equal(received[0].body, payload);
      assert.equal(received[0].headers["x-hub-signature-256"], "sha256=deadbeef");
    });

    await runCase("le altre route WhatsApp senza sessione restano 401 e non raggiungono il servizio", async () => {
      const checks: Array<[string, string]> = [
        ["GET", "/api/whatsapp/conversations"],
        ["GET", "/api/whatsapp/messages"],
        ["GET", "/api/whatsapp/templates"],
        ["POST", "/api/whatsapp/templates/test-send"],
        ["POST", "/api/whatsapp/webhook/extra"],
        ["GET", "/api/whatsapp/webhooks"]
      ];
      for (const [method, requestPath] of checks) {
        const response = await fetch(`${gatewayUrl}${requestPath}`, { method });
        assert.equal(response.status, 401, `${method} ${requestPath} dovrebbe essere 401`);
      }
      assert.equal(received.length, 0);
    });

    await runCase("route CRM protetta senza sessione resta 401", async () => {
      const response = await fetch(`${gatewayUrl}/api/leads`);
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: "Non autorizzato." });
    });
  } finally {
    await closeServer(gateway.server);
    await closeServer(upstream);
  }
}

main()
  .then(() => console.log("All whatsapp-webhook-gateway checks passed."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
