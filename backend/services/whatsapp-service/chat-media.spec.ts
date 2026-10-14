import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { classifyMetaError, createMetaSendError } from "./meta-errors";
import { buildContentDisposition, isInlineSafeMime, normalizeAttachmentKind, resolveOutboundMediaType, sanitizeAttachmentFilename } from "./media-rules";

// Resolved from the compiled spec's location (backend/dist/services/whatsapp-service/), like the
// other specs, so the test DB lands in backend/data regardless of the runner's cwd.
const BACKEND_ROOT = path.join(__dirname, "..", "..", "..");
const TEST_DB_FILE = path.join(BACKEND_ROOT, "data", "db.chat-media.test.json");
const TEST_CHAT_DB_FILE = path.join(BACKEND_ROOT, "data", "whatsapp.chat-media.test.json");

process.env.NODE_ENV = "test";
process.env.JSON_DB_FILE = TEST_DB_FILE;
process.env.WHATSAPP_DB_FILE = TEST_CHAT_DB_FILE;
delete process.env.MONGO_URL;
delete process.env.MONGODB_URI;
delete process.env.WHATSAPP_ACCESS_TOKEN;
delete process.env.WHATSAPP_PHONE_NUMBER_ID;
delete process.env.WHATSAPP_APP_SECRET;
delete process.env.META_APP_SECRET;

const leadService = require("../lead-service/server") as typeof import("../lead-service/server");

function resetDb() {
  fs.mkdirSync(path.dirname(TEST_DB_FILE), { recursive: true });
  fs.writeFileSync(TEST_DB_FILE, JSON.stringify({ leads: [], activities: [], tasks: [], callLogs: [], customers: [], purchases: [] }), "utf8");
  fs.writeFileSync(TEST_CHAT_DB_FILE, JSON.stringify({ conversations: [], messages: [] }), "utf8");
}

function cleanupDb() {
  for (const file of [TEST_DB_FILE, TEST_CHAT_DB_FILE]) if (fs.existsSync(file)) fs.unlinkSync(file);
}

async function listenEphemeral(server: import("http").Server): Promise<number> {
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", (error?: Error) => (error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server test non disponibile.");
  return address.port;
}

function closeServer(server: import("http").Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error?: Error) => (error ? reject(error) : resolve())));
}

async function request(baseUrl: string, method: string, requestPath: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${requestPath}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const raw = await response.text();
  let parsed: any = raw;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // non-JSON body
  }
  return { status: response.status, body: parsed };
}

function inboundPayload(from: string, message: Record<string, unknown>) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { display_phone_number: "390000000000" },
              contacts: [{ wa_id: from, profile: { name: "Cliente Media" } }],
              messages: [{ from, id: `wamid.${Math.random().toString(36).slice(2)}`, timestamp: String(Math.floor(Date.now() / 1000)), ...message }]
            }
          }
        ]
      }
    ]
  };
}

async function runCase(name: string, fn: () => Promise<void>) {
  resetDb();
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function main() {
  // --- Pure rules -----------------------------------------------------------------------------

  await runCase("solo JPEG/PNG fino a 5 MB partono come immagine, il resto come documento", async () => {
    assert.equal(resolveOutboundMediaType("image/jpeg", 1024), "image");
    assert.equal(resolveOutboundMediaType("image/png", 5 * 1024 * 1024), "image");
    assert.equal(resolveOutboundMediaType("image/png", 5 * 1024 * 1024 + 1), "document");
    assert.equal(resolveOutboundMediaType("image/webp", 1024), "document");
    assert.equal(resolveOutboundMediaType("image/heic", 1024), "document");
    assert.equal(resolveOutboundMediaType("application/pdf", 1024), "document");
  });

  await runCase("nomi file ripuliti da path, virgolette e caratteri di controllo", async () => {
    assert.equal(sanitizeAttachmentFilename("../../etc/passwd"), "etc_passwd");
    assert.ok(!sanitizeAttachmentFilename('offerta"; x=1.pdf').includes('"'));
    assert.ok(!/[\\/\r\n]/.test(sanitizeAttachmentFilename("a\\b/c\r\nd.pdf")));
    assert.equal(sanitizeAttachmentFilename(""), "documento");
    assert.equal(normalizeAttachmentKind("quote"), "quote");
    assert.equal(normalizeAttachmentKind("<script>"), "file");
  });

  await runCase("nomi file Unicode/spazi producono un header Content-Disposition valido", async () => {
    const header = buildContentDisposition("attachment", "Passaporto Müller 文件 😊.pdf");
    assert.match(header, /^attachment; filename="Passaporto M_ller _+ _+\.pdf"; filename\*=UTF-8''/);
    assert.ok(/^[\x20-\x7e]*$/.test(header), "l'header deve essere solo ASCII");
    assert.equal(decodeURIComponent(header.split("UTF-8''")[1]), "Passaporto Müller 文件 😊.pdf");
    // Node would throw ERR_INVALID_CHAR on a non-Latin-1 header value: prove it accepts this one.
    const http = require("node:http");
    const res = new http.ServerResponse(new http.IncomingMessage(null));
    assert.doesNotThrow(() => res.setHeader("Content-Disposition", header));
  });

  await runCase("solo tipi sicuri vengono serviti inline (mai SVG/HTML)", async () => {
    assert.equal(isInlineSafeMime("application/pdf"), true);
    assert.equal(isInlineSafeMime("image/jpeg; charset=binary"), true);
    assert.equal(isInlineSafeMime("image/svg+xml"), false);
    assert.equal(isInlineSafeMime("text/html"), false);
    assert.equal(isInlineSafeMime("application/vnd.ms-excel"), false);
  });

  await runCase("errori Meta tradotti in codici e messaggi per l'operatore, senza payload grezzo", async () => {
    assert.equal(classifyMetaError(400, 131047), "window_closed");
    assert.equal(classifyMetaError(401, 190), "auth");
    assert.equal(classifyMetaError(400, 132001), "template");
    assert.equal(classifyMetaError(400, 131053), "media");
    assert.equal(classifyMetaError(429, 130429), "rate_limit");
    assert.equal(classifyMetaError(400, 131026), "undeliverable");
    assert.equal(classifyMetaError(500, null), "provider_error");
    const originalError = console.error;
    console.error = () => undefined;
    try {
      const error = createMetaSendError(400, JSON.stringify({ error: { code: 131047, message: "Re-engagement message" } }), "Invio testo");
      assert.equal(error.code, "window_closed");
      assert.ok(!error.message.includes("{") && !error.message.includes("Meta"), error.message);
    } finally {
      console.error = originalError;
    }
  });

  // --- Service behaviour (local JSON store, simulated Meta) -------------------------------------

  const leadPort = await listenEphemeral(leadService.server);
  process.env.LEAD_SERVICE_URL = `http://127.0.0.1:${leadPort}`;
  delete require.cache[require.resolve("./server")];
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const whatsappService = require("./server");
  const waUrl = `http://127.0.0.1:${await listenEphemeral(whatsappService.server)}`;

  try {
    await runCase("segna come non letta porta il contatore ad almeno 1 e non accetta valori arbitrari", async () => {
      await request(waUrl, "POST", "/webhook", inboundPayload("393331110001", { type: "text", text: { body: "Ciao" } }));
      const [conversation] = (await request(waUrl, "GET", "/conversations")).body;
      await request(waUrl, "GET", `/conversations/${conversation.id}/messages`);
      const forged = await request(waUrl, "PATCH", `/conversations/${conversation.id}`, { unreadCount: 50 });
      assert.equal(forged.body.unreadCount, 0, "unreadCount non deve essere impostabile dal client");
      const marked = await request(waUrl, "PATCH", `/conversations/${conversation.id}`, { markUnread: true });
      assert.equal(marked.status, 200);
      assert.equal(marked.body.unreadCount, 1);
    });

    await runCase("allegato in uscita: tipo, kind, nome e dimensione salvati sul messaggio", async () => {
      await request(waUrl, "POST", "/webhook", inboundPayload("393331110002", { type: "text", text: { body: "Mandami il preventivo" } }));
      const [conversation] = (await request(waUrl, "GET", "/conversations")).body;
      const sent = await request(waUrl, "POST", "/messages/send", {
        conversationId: conversation.id,
        mode: "attachment",
        attachment: {
          url: "https://storage.example/signed",
          storageKey: "lead-documents/lead_1/chat_quote/doc_1-preventivo.webp",
          filename: "../preventivo.webp",
          mimeType: "image/webp",
          size: 2048,
          kind: "quote",
          caption: "Ecco il preventivo"
        }
      });
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
      const attachment = sent.body.message.attachment;
      assert.equal(attachment.mediaType, "document", "WEBP non e un'immagine accettata da Meta");
      assert.equal(attachment.kind, "quote");
      assert.equal(attachment.size, 2048);
      assert.equal(attachment.filename, "preventivo.webp");
      assert.equal(attachment.documentStorageKey, "lead-documents/lead_1/chat_quote/doc_1-preventivo.webp");
      assert.equal(sent.body.message.text, "Ecco il preventivo");
    });

    await runCase("allegato bloccato a finestra 24h chiusa", async () => {
      const ensured = await request(waUrl, "POST", "/conversations/ensure", { phone: "393331110003", customerName: "Senza finestra" });
      const blocked = await request(waUrl, "POST", "/messages/send", {
        conversationId: ensured.body.id,
        mode: "attachment",
        attachment: { url: "https://storage.example/signed", filename: "a.pdf", mimeType: "application/pdf", size: 10 }
      });
      assert.equal(blocked.status, 400);
      assert.match(blocked.body.error, /finestra/i);
    });

    await runCase("media in arrivo: 404 senza media, 503 se il download WhatsApp non e configurato", async () => {
      await request(waUrl, "POST", "/webhook", inboundPayload("393331110004", { type: "text", text: { body: "Solo testo" } }));
      await request(waUrl, "POST", "/webhook", inboundPayload("393331110004", { type: "image", image: { id: "media_123", mime_type: "image/jpeg" } }));
      const [conversation] = (await request(waUrl, "GET", "/conversations")).body;
      const { messages } = (await request(waUrl, "GET", `/conversations/${conversation.id}/messages`)).body;
      const textMessage = messages.find((message: any) => !message.attachment);
      const imageMessage = messages.find((message: any) => message.attachment?.mediaId === "media_123");
      assert.ok(textMessage && imageMessage, "attesi un messaggio di testo e uno con immagine");
      assert.equal((await request(waUrl, "GET", `/messages/${textMessage.id}/media`)).status, 404);
      assert.equal((await request(waUrl, "GET", `/messages/does-not-exist/media`)).status, 404);
      const unavailable = await request(waUrl, "GET", `/messages/${imageMessage.id}/media`);
      assert.equal(unavailable.status, 503);
      assert.equal(unavailable.body.code, "media_unavailable");
    });
  } finally {
    await closeServer(whatsappService.server);
    await closeServer(leadService.server);
  }
}

main()
  .then(() => {
    cleanupDb();
    console.log("All chat-media checks passed.");
  })
  .catch((error) => {
    cleanupDb();
    console.error(error);
    process.exitCode = 1;
  });
