import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";

type Row = Record<string, any>;
const hour = 3600 * 1000;
const open = () => new Date(Date.now() + 5 * hour).toISOString();

// Stand-ins for lead-service and whatsapp-service; the claim is the same "only while free" write
// the store does, so the race goes through the real gateway rules.
const leads: Row[] = [];
const conversations: Row[] = [];
const whatsappCalls: Array<{ method: string; url: string; body: Row }> = [];
const leadPatches: Row[] = [];
const mailMessages: Row[] = [];
const tasks: Row[] = [{ id: "t-mine", leadId: "lead-mine", assignedTo: "marta" }, { id: "t-other", leadId: "lead-other", assignedTo: "luca" }];
const calls: Row[] = [{ id: "c-mine", leadId: "lead-mine", actor: "marta" }, { id: "c-other", leadId: "lead-other", actor: "luca" }, { id: "c-none", leadId: "", actor: "marta" }, { id: "c-none-other", leadId: "", actor: "luca" }];
const taskPosts: Row[] = [];
const mailPatches: Row[] = [];

function reply(res: http.ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}
function readBody(req: http.IncomingMessage): Promise<Row> {
  return new Promise((resolve) => {
    let text = "";
    req.on("data", (chunk) => { text += chunk; });
    req.on("end", () => resolve(text ? JSON.parse(text) : {}));
  });
}

const leadService = http.createServer(async (req, res) => {
  const body = await readBody(req);
  if (req.method === "GET" && req.url === "/internal/lead-owners") return reply(res, 200, Object.fromEntries(leads.map((lead) => [lead.id, lead.assignedTo || ""])));
  if (req.method === "GET" && req.url === "/leads") return reply(res, 200, leads);
  if (req.method === "GET" && String(req.url).startsWith("/leads/")) return reply(res, 200, { id: "ok" });
  if (req.method === "GET" && req.url?.startsWith("/tasks/board")) return reply(res, 200, { tasks, leads });
  if (req.method === "GET" && req.url?.startsWith("/tasks/")) { const task = tasks.find((row) => req.url?.endsWith(row.id)); return task ? reply(res, 200, task) : reply(res, 404, {}); }
  if (req.method === "PATCH" && req.url?.startsWith("/tasks/")) return reply(res, 200, { id: "t" });
  if (req.method === "POST" && req.url === "/tasks") { taskPosts.push(body); return reply(res, 200, { id: "t" }); }
  if (req.method === "GET" && req.url?.startsWith("/tasks")) return reply(res, 200, tasks);
  if (req.method === "GET" && req.url?.startsWith("/calls")) return reply(res, 200, calls);
  if (req.method === "GET" && req.url === "/customers/c1") return reply(res, 200, { customer: { id: "c1" }, leads: [{ id: "lead-mine" }, { id: "lead-other" }], purchases: [{ id: "p1", leadId: "lead-mine" }, { id: "p2", leadId: "lead-other" }], activeLead: { id: "lead-other" } });
  if (req.method === "GET" && req.url === "/customers/c2") return reply(res, 200, { customer: { id: "c2" }, leads: [{ id: "lead-other" }], purchases: [], activeLead: null });
  if (req.method === "GET" && req.url === "/mail/messages") return reply(res, 200, { configured: true, lastSyncAt: null, lastError: "Casella non raggiungibile.", messages: mailMessages });
  if (req.method === "PATCH" && String(req.url).startsWith("/mail/messages/")) { mailPatches.push({ url: req.url, ...body }); return reply(res, 200, {}); }
  const patch = String(req.url).match(/^\/leads\/([^/]+)$/);
  if (patch && req.method === "PATCH") {
    leadPatches.push({ id: patch[1], ...body });
    const lead = leads.find((row) => row.id === patch[1]);
    if (lead) lead.assignedTo = body.assignedTo;
    return reply(res, 200, lead || {});
  }
  reply(res, 404, {});
});

const whatsappService = http.createServer(async (req, res) => {
  const body = await readBody(req);
  const url = new URL(req.url || "/", "http://x");
  whatsappCalls.push({ method: req.method || "", url: url.pathname, body });
  if (url.pathname === "/conversations" && req.method === "GET") {
    const phone = url.searchParams.get("phone");
    return reply(res, 200, phone ? conversations.filter((row) => row.phone === phone) : conversations);
  }
  if (url.pathname === "/conversations/ensure") return reply(res, 200, conversations.find((row) => row.phone === body.phone));
  if (url.pathname === "/messages/send") return reply(res, 200, { ok: true });
  if (url.pathname === "/messages/m-other/conversation") return reply(res, 200, { conversationId: "other" });
  if (url.pathname === "/messages/m-mine/conversation") return reply(res, 200, { conversationId: "mine" });
  if (url.pathname.endsWith("/media")) return reply(res, 200, { media: true });
  const claim = url.pathname.match(/^\/conversations\/([^/]+)\/claim$/);
  if (claim) {
    const row = conversations.find((item) => item.id === claim[1]);
    if (!row) return reply(res, 404, {});
    if (row.assignedTo && row.assignedTo !== "automazione") return reply(res, 409, row);
    row.assignedTo = body.username;
    return reply(res, 200, row);
  }
  const messages = url.pathname.match(/^\/conversations\/([^/]+)\/messages$/);
  if (messages) return reply(res, 200, { conversation: conversations.find((row) => row.id === messages[1]), messages: [{ text: "riservato" }] });
  const single = url.pathname.match(/^\/conversations\/([^/]+)$/);
  if (single) {
    const row = conversations.find((item) => item.id === single[1]);
    if (!row) return reply(res, 404, {});
    if (req.method === "PATCH") Object.assign(row, body);
    return reply(res, 200, row);
  }
  reply(res, 404, {});
});

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as any).port}`)));
}

async function main() {
  process.env.JSON_DB_FILE = path.join(os.tmpdir(), `leadium-chat-access-${process.pid}.json`);
  process.env.LEAD_SERVICE_URL = await listen(leadService);
  process.env.WHATSAPP_SERVICE_URL = await listen(whatsappService);
  const gateway = require("./server");
  gateway.__setTestSession("marta", { id: "m", username: "marta", name: "Marta", role: "operatore" });
  gateway.__setTestSession("luca", { id: "l", username: "luca", name: "Luca", role: "operatore" });
  gateway.__setTestSession("admin", { id: "a", username: "maro", name: "Maro", role: "admin" });
  const base = await listen(gateway.server);
  const call = async (method: string, url: string, token: string, body?: Row) => {
    const res = await fetch(base + url, { method, headers: { Authorization: "Bearer " + token, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
  const reset = () => {
    leads.splice(0, leads.length, { id: "lead-mine", assignedTo: "marta" }, { id: "lead-other", assignedTo: "luca" }, { id: "lead-free", assignedTo: "" });
    conversations.splice(0, conversations.length,
      { id: "mine", phone: "391", leadId: "lead-mine", assignedTo: "", replyWindowExpiresAt: open() },
      { id: "other", phone: "392", leadId: "lead-other", assignedTo: "marta", replyWindowExpiresAt: open() },
      { id: "free", phone: "393", leadId: "lead-free", assignedTo: "", replyWindowExpiresAt: open(), lastMessagePreview: "riservato" },
      { id: "auto", phone: "394", leadId: null, assignedTo: "automazione", replyWindowExpiresAt: open() },
      { id: "old", phone: "395", leadId: null, assignedTo: "", replyWindowExpiresAt: new Date(Date.now() - hour).toISOString() }
    );
    leadPatches.length = 0; whatsappCalls.length = 0;
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5100));
  try {
    reset();
    const mine = await call("GET", "/api/whatsapp/conversations", "marta");
    assert.deepEqual(mine.body.map((row: Row) => row.id), ["mine"], "the practice's operator decides, not an old chat assignee");
    assert.equal(mine.body[0].assignedTo, "marta", "the list shows the real owner");
    assert.equal((await call("GET", "/api/whatsapp/conversations", "admin")).body.length, 5);
    console.log("PASS operator lists only own chats; admin sees all");

    for (const [method, url] of [["GET", "/api/whatsapp/conversations/other"], ["GET", "/api/whatsapp/conversations/other/messages"], ["GET", "/api/whatsapp/messages/m-other/media"]]) {
      assert.equal((await call(method, url, "marta")).status, 403, url);
    }
    assert.equal((await call("PATCH", "/api/whatsapp/conversations/other", "marta", { status: "resolved" })).status, 403);
    assert.equal((await call("POST", "/api/whatsapp/messages/send", "marta", { conversationId: "other", text: "x" })).status, 403);
    assert.equal((await call("POST", "/api/whatsapp/messages/send", "marta", { to: "392", text: "x" })).status, 403, "by phone too");
    assert.equal((await call("POST", "/api/whatsapp/conversations/ensure", "marta", { phone: "392" })).status, 403);
    assert.equal((await call("GET", "/api/whatsapp/conversations/free/messages", "marta")).status, 403, "a free chat is not readable before taking it");
    assert.equal((await call("GET", "/api/whatsapp/messages/m-mine/media", "marta")).status, 200);
    assert.equal((await call("GET", "/api/whatsapp/conversations/other/messages", "admin")).status, 200);
    assert.ok(!whatsappCalls.some((row) => row.url === "/messages/send" && row.body.conversationId === "other"));
    console.log("PASS a colleague's chat is closed on read, attachment, status, send and open-from-practice");

    const alerts = await call("GET", "/api/whatsapp/conversations/unclaimed", "luca");
    assert.deepEqual(alerts.body.map((row: Row) => row.id).sort(), ["auto", "free"], "assigned, expired and old chats raise no alert");
    assert.ok(!JSON.stringify(alerts.body).includes("riservato"), "the alert carries no message text");
    console.log("PASS alert lists free chats inside the 24h window, number only");

    const race = await Promise.all([call("POST", "/api/whatsapp/conversations/free/claim", "marta"), call("POST", "/api/whatsapp/conversations/free/claim", "luca")]);
    assert.deepEqual(race.map((row) => row.status).sort(), [200, 409], "exactly one operator wins");
    const winner = race[0].status === 200 ? "marta" : "luca", loser = winner === "marta" ? "luca" : "marta";
    assert.deepEqual(leadPatches.map((row) => [row.id, row.assignedTo]), [["lead-free", winner]], "the practice follows the winner");
    assert.equal((await call("GET", "/api/whatsapp/conversations/free/messages", winner)).status, 200);
    assert.equal((await call("GET", "/api/whatsapp/conversations/free/messages", loser)).status, 403);
    assert.equal((await call("POST", "/api/whatsapp/conversations/free/claim", loser)).body.error, "Un collega ha gia preso questa chat.");
    assert.ok(!(await call("GET", "/api/whatsapp/conversations/unclaimed", loser)).body.some((row: Row) => row.id === "free"), "the alert disappears for everyone");
    console.log("PASS two simultaneous clicks: one operator takes the chat and its practice");

    reset(); await settle();
    assert.equal((await call("POST", "/api/whatsapp/messages/send", "marta", { conversationId: "auto", text: "ciao" })).status, 200);
    assert.equal(conversations.find((row) => row.id === "auto")?.assignedTo, "marta", "answering a free chat takes it");
    console.log("PASS answering a free chat takes it");

    reset(); await settle();
    assert.equal((await call("PATCH", "/api/whatsapp/conversations/mine", "marta", { assignedTo: "luca" })).status, 403, "operators cannot pass chats on");
    assert.equal((await call("PATCH", "/api/whatsapp/conversations/mine", "marta", { assignedTo: "" })).status, 403);
    assert.equal((await call("PATCH", "/api/whatsapp/conversations/mine", "marta", { status: "resolved" })).status, 200);
    console.log("PASS only an admin assigns chats");

    reset(); await settle();
    mailMessages.splice(0, mailMessages.length,
      { id: "m1", leadId: "lead-mine", direction: "inbound", readAt: null },
      { id: "m2", leadId: "lead-other", direction: "inbound", readAt: null },
      { id: "m3", leadId: null, direction: "inbound", readAt: null, from: "ignoto@example.test" },
      { id: "m4", leadId: "lead-mine", direction: "outbound", readAt: "2026-11-04T08:00:00.000Z" }
    );
    const marta = await call("GET", "/api/mail/messages", "marta");
    assert.deepEqual(marta.body.messages.map((row: Row) => row.id), ["m1", "m4"], "own customers only, no unmatched senders");
    assert.equal(marta.body.lastError, null, "mailbox problems are an admin matter");
    assert.equal((await call("GET", "/api/mail/unread", "marta")).body.unread, 1);
    const admin = await call("GET", "/api/mail/messages", "admin");
    assert.equal(admin.body.messages.length, 4);
    assert.equal(admin.body.lastError, "Casella non raggiungibile.");
    assert.equal((await call("GET", "/api/mail/unread", "admin")).body.unread, 3);
    assert.equal((await call("PATCH", "/api/mail/messages/m2", "marta", { read: true })).status, 403);
    assert.equal((await call("PATCH", "/api/mail/messages/m3", "marta", { read: true })).status, 403);
    assert.equal((await call("PATCH", "/api/mail/messages/m1", "marta", { linkLeadId: "lead-other" })).status, 403, "linking is for admins");
    assert.equal(mailPatches.length, 0);
    assert.equal((await call("PATCH", "/api/mail/messages/m1", "marta", { read: true })).status, 200);
    assert.equal((await call("PATCH", "/api/mail/messages/m3", "admin", { linkLeadId: "lead-mine" })).status, 200);
    assert.deepEqual(mailPatches.map((row) => [row.url, row.actor]), [["/mail/messages/m1", "marta"], ["/mail/messages/m3", "maro"]]);
    console.log("PASS customer email follows the practice's operator; unmatched senders stay with admins");

    reset(); await settle();
    assert.deepEqual((await call("GET", "/api/leads", "marta")).body.map((row: Row) => row.id), ["lead-mine"], "colleagues' and unassigned practices stay out");
    assert.equal((await call("GET", "/api/leads", "admin")).body.length, 3);
    assert.equal((await call("GET", "/api/leads/lead-other", "marta")).status, 403);
    assert.equal((await call("GET", "/api/leads/lead-free", "marta")).status, 403, "the admin distributes unassigned practices");
    assert.equal((await call("GET", "/api/leads/lead-mine", "marta")).status, 200);
    assert.equal((await call("GET", "/api/leads/lead-other", "admin")).status, 200);
    for (const [method, url] of [["GET", "/api/leads/lead-other/activities"], ["PATCH", "/api/leads/lead-other"], ["POST", "/api/leads/lead-other/worked"], ["POST", "/api/leads/lead-other/close"], ["POST", "/api/leads/lead-other/email"], ["POST", "/api/leads/lead-other/assign"]]) {
      assert.equal((await call(method, url, "marta", method === "GET" ? undefined : {})).status, 403, url);
    }
    const board = await call("GET", "/api/tasks/board?status=open", "marta");
    assert.deepEqual([board.body.tasks.map((row: Row) => row.id), board.body.leads.map((row: Row) => row.id)], [["t-mine"], ["lead-mine"]], "dashboard, search and reminders read this");
    assert.deepEqual((await call("GET", "/api/tasks?status=open", "marta")).body.map((row: Row) => row.id), ["t-mine"]);
    assert.equal((await call("GET", "/api/tasks/board", "admin")).body.tasks.length, 2);
    assert.equal((await call("PATCH", "/api/tasks/t-other", "marta", { status: "done" })).status, 403);
    assert.equal((await call("PATCH", "/api/tasks/t-mine", "marta", { status: "done" })).status, 200);
    assert.equal((await call("POST", "/api/tasks", "marta", { leadId: "lead-other", title: "x" })).status, 403);
    assert.equal(taskPosts.length, 0);
    assert.equal((await call("POST", "/api/tasks", "marta", { leadId: "lead-mine", title: "x" })).status, 200);
    assert.deepEqual((await call("GET", "/api/calls?limit=250", "marta")).body.map((row: Row) => row.id), ["c-mine", "c-none"], "a call with no practice stays with who made it");
    const customer = await call("GET", "/api/customers/c1", "marta");
    assert.deepEqual([customer.body.leads.map((row: Row) => row.id), customer.body.purchases.map((row: Row) => row.id), customer.body.activeLead], [["lead-mine"], ["p1"], null], "a shared customer shows only own practices");
    assert.equal((await call("GET", "/api/customers/c2", "marta")).status, 403);
    assert.equal((await call("GET", "/api/customers/c1", "admin")).body.leads.length, 2);
    assert.equal((await call("GET", "/api/purchases/p2", "marta")).status, 403);
    assert.equal((await call("GET", "/api/whatsapp/automation/state?leadId=lead-other", "marta")).status, 403);
    console.log("PASS operators reach only their own practices, on every path; admins keep the whole view");
  } finally {
    for (const server of [gateway.server, leadService, whatsappService]) server.close();
    fs.rmSync(process.env.JSON_DB_FILE as string, { force: true });
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
