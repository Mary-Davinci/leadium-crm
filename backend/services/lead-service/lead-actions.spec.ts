import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const BACKEND_ROOT = path.join(__dirname, "..", "..", "..");
const TEST_DB_FILE = path.join(BACKEND_ROOT, "data", "db.lead-actions.test.json");
const TEST_CHAT_DB_FILE = path.join(BACKEND_ROOT, "data", "whatsapp.lead-actions.test.json");
const TEST_MAIL_DB_FILE = path.join(BACKEND_ROOT, "data", "mail.lead-actions.test.json");

process.env.NODE_ENV = "test";
process.env.JSON_DB_FILE = TEST_DB_FILE;
process.env.WHATSAPP_DB_FILE = TEST_CHAT_DB_FILE;
process.env.MAIL_DB_FILE = TEST_MAIL_DB_FILE;
delete process.env.MONGO_URL;
delete process.env.MONGODB_URI;
for (const key of ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD", "MAIL_FROM", "MAIL_FROM_NAME", "MAIL_BCC"]) delete process.env[key];

const leadService = require("./server") as typeof import("./server");
const leadStore = require("../common/leadStore") as typeof import("../common/leadStore");
const taskStore = require("../common/taskStore") as typeof import("../common/taskStore");
const mailer = require("../common/mailer") as typeof import("../common/mailer");
const { importSentMail, ingestRawMail } = require("../common/mailInbox") as typeof import("../common/mailInbox");
const { internalIdentityHeaders } = require("../common/internalCapability") as typeof import("../common/internalCapability");

const ADMIN = { id: "u-admin", username: "admin.test", role: "admin" };
const OPERATOR = { id: "u-op", username: "marta", role: "operatore" };

function resetDb() {
  fs.mkdirSync(path.dirname(TEST_DB_FILE), { recursive: true });
  fs.writeFileSync(TEST_DB_FILE, JSON.stringify({ leads: [], activities: [], tasks: [], callLogs: [], customers: [], purchases: [] }), "utf8");
}

function cleanupDb() {
  for (const file of [TEST_DB_FILE, TEST_CHAT_DB_FILE, TEST_MAIL_DB_FILE]) if (fs.existsSync(file)) fs.unlinkSync(file);
}

async function request(baseUrl: string, method: string, route: string, body?: unknown, trusted = true) {
  const response = await fetch(baseUrl + route, {
    method,
    headers: { "Content-Type": "application/json", ...(trusted ? internalIdentityHeaders() : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, body: await response.json() as any };
}

async function withServer(fn: (baseUrl: string) => Promise<void>) {
  await new Promise<void>((resolve, reject) => leadService.server.listen(0, "127.0.0.1", (error?: Error) => (error ? reject(error) : resolve())));
  try {
    const address = leadService.server.address();
    if (!address || typeof address === "string") throw new Error("Server test non disponibile.");
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => leadService.server.close((error?: Error) => (error ? reject(error) : resolve())));
  }
}

async function seedLead(fields: Record<string, unknown>) {
  const now = new Date().toISOString();
  return leadStore.createLead({ id: leadStore.newId("lead"), fullName: "Seed", status: "Da contattare", closingOutcome: "open", notes: "",
    documents: { items: [] }, payments: { items: [] }, callAttempts: 0, createdAt: now, updatedAt: now, ...fields }, []);
}

async function openTask(leadId: string, kind = "next_action") {
  return taskStore.createTask({ leadId, assignedTo: "marta", kind, title: "Richiamo", description: "", source: "automation", status: "open", priority: 70, dueAt: new Date(Date.now() - 3600_000).toISOString(), meta: null } as any);
}

async function timelineTypes(leadId: string) {
  return ((await leadStore.getTimelineByLeadId(leadId)) as any[]).map((row) => row.type);
}

async function archiveChecks(baseUrl: string) {
  resetDb();
  const lead = await seedLead({ fullName: "Contatto inutile", phone: "+39 333 1000001", email: "inutile@example.test", assignedTo: "marta" });
  await openTask(lead.id);

  assert.equal((await request(baseUrl, "POST", `/leads/${lead.id}/archive`, { reason: "doppione", __actor: OPERATOR })).status, 403, "operators cannot archive");
  assert.equal((await request(baseUrl, "POST", `/leads/${lead.id}/archive`, { reason: "doppione", __actor: ADMIN }, false)).status, 403, "an anonymous caller cannot claim to be an admin");
  assert.equal((await request(baseUrl, "POST", `/leads/${lead.id}/archive`, { reason: "  ", __actor: ADMIN })).status, 400, "the reason is mandatory");

  const archived = await request(baseUrl, "POST", `/leads/${lead.id}/archive`, { reason: "Numero errato, contatto non piu necessario", __actor: ADMIN });
  assert.equal(archived.status, 200);
  assert.ok(archived.body.archivedAt); assert.equal(archived.body.archivedBy, "admin.test");
  assert.ok(await leadStore.getLeadById(lead.id), "the record stays in the database");
  assert.ok(!(await leadStore.listLeads()).some((row: any) => row.id === lead.id), "left out of every list");
  assert.ok((await leadStore.listLeads({ archived: "only" })).some((row: any) => row.id === lead.id), "listed in the archive view");
  assert.ok(!(await request(baseUrl, "GET", "/leads?view=summary")).body.some((row: any) => row.id === lead.id));
  assert.equal(await leadStore.findLeadByContact("+39 333 1000001", ""), null, "contact lookups ignore archived leads");
  assert.deepEqual((await taskStore.listTasks({ leadId: lead.id, status: "open" })).length, 0, "its open tasks are dismissed");
  assert.ok((await timelineTypes(lead.id)).includes("lead_archived"), "trace kept in the timeline");
  assert.equal((await request(baseUrl, "POST", `/leads/${lead.id}/worked`, { note: "x", __actor: OPERATOR })).status, 409, "no other action on an archived contact");

  // The same person writes again: a new opportunity, never merged into the archive.
  const back = await request(baseUrl, "POST", "/leads", { fullName: "Ritorno", phone: "+39 333 1000001", __creator: ADMIN });
  assert.equal(back.status, 201); assert.notEqual(back.body.id, lead.id);

  const restored = await request(baseUrl, "POST", `/leads/${lead.id}/restore`, { __actor: ADMIN });
  assert.equal(restored.status, 200); assert.equal(restored.body.archivedAt, null);
  assert.ok((await leadStore.listLeads()).some((row: any) => row.id === lead.id), "back in the lists after restore");
  assert.ok((await timelineTypes(lead.id)).includes("lead_restored"));
  console.log("PASS archive: admin only with reason, kept in the database, out of lists/lookups/tasks, traced, restorable");
}

async function workedChecks(baseUrl: string) {
  resetDb();
  const lead = await seedLead({ fullName: "Luciano Tantucci", phone: "+39 333 2000001", assignedTo: "marta", status: "Contatto interessato", nextActionAt: new Date(Date.now() - 3600_000).toISOString() });
  await openTask(lead.id);

  assert.equal((await request(baseUrl, "POST", `/leads/${lead.id}/worked`, { note: "", __actor: OPERATOR })).status, 400, "a note is required");
  const worked = await request(baseUrl, "POST", `/leads/${lead.id}/worked`, { note: "Preventivo inviato, il cliente decide a gennaio", __actor: OPERATOR });
  assert.equal(worked.status, 200);
  assert.ok(worked.body.workedAt); assert.equal(worked.body.workedBy, "marta"); assert.equal(worked.body.nextActionAt, null);
  assert.equal((await taskStore.listTasks({ leadId: lead.id, status: "open" })).length, 0, "no reminder left open");
  await leadService.ensureSlaTasks();
  assert.equal((await taskStore.listTasks({ leadId: lead.id, status: "open" })).length, 0, "the scheduler does not recreate reminders for a worked lead");
  assert.ok((await timelineTypes(lead.id)).includes("lead_worked"));
  assert.equal((await request(baseUrl, "POST", `/leads/${lead.id}/worked`, { note: "di nuovo", __actor: OPERATOR })).status, 409);

  const undone = await request(baseUrl, "POST", `/leads/${lead.id}/worked/undo`, { __actor: OPERATOR });
  assert.equal(undone.status, 200); assert.equal(undone.body.workedAt, null);
  assert.ok((await timelineTypes(lead.id)).includes("lead_worked_undone"));

  const lost = await seedLead({ fullName: "Gia persa", phone: "+39 333 2000002", status: "Contattato non interessato", closingOutcome: "disqualified" });
  assert.equal((await request(baseUrl, "POST", `/leads/${lost.id}/worked`, { note: "x", __actor: OPERATOR })).status, 409, "a final outcome is already among the worked ones");
  console.log("PASS worked: note required, reminders closed and not recreated, traced, undoable; final outcomes need no button");
}

async function emailChecks(baseUrl: string) {
  resetDb();
  const lead = await seedLead({ fullName: "Mirella Pugliese", phone: "+39 333 3000001", email: "mirella@example.test" });
  const noEmail = await seedLead({ fullName: "Senza email", phone: "+39 333 3000002" });

  const unconfigured = await request(baseUrl, "POST", `/leads/${lead.id}/email`, { subject: "Preventivo", text: "Buongiorno", __actor: OPERATOR });
  assert.equal(unconfigured.status, 503, "readable error until the mailbox is configured");

  const sent: any[] = [];
  mailer.setMailTransportFactory((config) => ({ sendMail: async (message) => { sent.push({ config, message }); return { messageId: "<m1@test>" }; } }));
  Object.assign(process.env, { SMTP_HOST: "smtps.example.test", SMTP_PORT: "465", SMTP_USER: "servizioclienti@crocieriamo.com", SMTP_PASSWORD: "secret-value" });
  try {
    assert.equal((await request(baseUrl, "POST", `/leads/${noEmail.id}/email`, { subject: "x", text: "y", __actor: OPERATOR })).status, 422, "no address on the practice");
    assert.equal((await request(baseUrl, "POST", `/leads/${lead.id}/email`, { subject: "", text: "y", __actor: OPERATOR })).status, 400);
    assert.equal((await request(baseUrl, "POST", `/leads/${lead.id}/email`, { subject: "x", text: "y" })).status, 403, "author required");

    const ok = await request(baseUrl, "POST", `/leads/${lead.id}/email`, { subject: "Il tuo preventivo\r\nBcc: altro@example.test", text: "Buongiorno Mirella,\nin allegato...", __actor: OPERATOR });
    assert.equal(ok.status, 200);
    assert.equal(sent.length, 1);
    const { message } = sent[0];
    assert.equal(message.to, "mirella@example.test", "always the practice address, never one from the request");
    assert.equal(message.subject, "Il tuo preventivo Bcc: altro@example.test", "no header injection through the subject");
    assert.equal(message.bcc, "servizioclienti@crocieriamo.com", "copy kept in the company mailbox");
    assert.deepEqual(message.from, { name: "Crocieriamo", address: "servizioclienti@crocieriamo.com" });
    const timeline = (await leadStore.getTimelineByLeadId(lead.id)) as any[];
    const row = timeline.find((item) => item.type === "email_sent");
    assert.ok(row && row.actor === "marta" && row.meta.text.includes("Buongiorno Mirella"), "sent email traced with its text");
    assert.ok(!JSON.stringify(timeline).includes("secret-value"), "credentials never stored");

    mailer.setMailTransportFactory(() => ({ sendMail: async () => { throw new Error("535 auth failed for secret-value"); } }));
    const failed = await request(baseUrl, "POST", `/leads/${lead.id}/email`, { subject: "x", text: "y", __actor: OPERATOR });
    assert.equal(failed.status, 502); assert.ok(!JSON.stringify(failed.body).includes("secret-value"), "SMTP text never forwarded");
  } finally {
    for (const key of ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD"]) delete process.env[key];
  }
  console.log("PASS email: practice address only, subject sanitized, Bcc to the mailbox, traced, SMTP errors and secrets never exposed");
}

async function replyChecks(baseUrl: string) {
  resetDb();
  fs.rmSync(TEST_MAIL_DB_FILE, { force: true });
  const lead = await seedLead({ fullName: "Luciano Tantucci", phone: "+39 333 4000001", email: "luciano@example.test", assignedTo: "marta" });
  const other = await seedLead({ fullName: "Altra pratica", phone: "+39 333 4000002", email: "altra@example.test" });
  const sent: any[] = [];
  mailer.setMailTransportFactory(() => ({ sendMail: async (message) => { sent.push(message); return { messageId: `<out${sent.length}@test>` }; } }));
  Object.assign(process.env, { SMTP_HOST: "smtps.example.test", SMTP_PORT: "465", SMTP_USER: "servizioclienti@crocieriamo.com", SMTP_PASSWORD: "secret-value" });
  try {
    assert.equal((await request(baseUrl, "POST", `/leads/${lead.id}/email`, { subject: "Preventivo", text: "Buongiorno", __actor: OPERATOR })).status, 200);
    const own = "servizioclienti@crocieriamo.com";
    const reply = ["From: Luciano <privato@altro.test>", `To: ${own}`, "Subject: Re: Preventivo", "Message-ID: <r1@test>", "In-Reply-To: <out1@test>", "Date: Wed, 04 Nov 2026 10:00:00 +0100", "", "Accetto il preventivo."].join("\r\n");
    const deps = { findLeadIdByEmail: async () => null, onReceived: async () => {} };
    assert.equal((await ingestRawMail(reply, own, deps))?.leadId, lead.id, "the reply follows the mail the CRM sent");

    const list = await request(baseUrl, "GET", "/mail/messages");
    assert.deepEqual(list.body.messages.map((row: any) => [row.direction, row.leadName]).sort(), [["inbound", "Luciano Tantucci"], ["outbound", "Luciano Tantucci"]]);
    const inbound = list.body.messages.find((row: any) => row.direction === "inbound");

    assert.equal((await request(baseUrl, "POST", `/leads/${other.id}/email`, { subject: "x", text: "y", replyToMailId: inbound.id, __actor: OPERATOR })).status, 409, "a reply cannot be attached to another practice");
    assert.equal(sent.length, 1, "nothing sent");

    assert.equal((await request(baseUrl, "POST", `/leads/${lead.id}/email`, { subject: "Re: Preventivo", text: "Grazie", replyToMailId: inbound.id, __actor: OPERATOR })).status, 200);
    assert.equal(sent[1].to, "luciano@example.test", "always the practice's address");
    assert.equal(sent[1].inReplyTo, "<r1@test>");
    assert.deepEqual(sent[1].references, ["<out1@test>", "<r1@test>"], "the customer's mail client keeps the conversation");
    const after = await request(baseUrl, "GET", "/mail/messages");
    assert.ok(after.body.messages.find((row: any) => row.id === inbound.id).readAt, "answering reads it");
    assert.equal(after.body.messages.length, 3);

    const unknown = await ingestRawMail(["From: ignoto@altro.test", `To: ${own}`, "Subject: Info", "Message-ID: <r2@test>", "", "Salve"].join("\r\n"), own, deps);
    assert.equal(unknown?.leadId, null);
    const linked = await request(baseUrl, "PATCH", `/mail/messages/${unknown?.id}`, { linkLeadId: lead.id, read: true, actor: "admin.test" });
    assert.deepEqual([linked.status, linked.body.leadId, Boolean(linked.body.readAt)], [200, lead.id, true]);
    const timeline = (await leadStore.getTimelineByLeadId(lead.id)) as any[];
    assert.ok(timeline.some((row: any) => row.type === "email_received" && row.text.includes("ignoto@altro.test")), "the linked email reaches the practice's history");
    assert.equal((await request(baseUrl, "PATCH", "/mail/messages/nope", { read: true })).status, 404);

    fs.rmSync(TEST_MAIL_DB_FILE, { force: true });
    const history = await leadStore.listActivitiesByType("email_sent");
    assert.equal(history.length, 2, "both mails of this practice are in its history");
    assert.equal(await importSentMail(history, own), 2);
    assert.equal(await importSentMail(history, own), 0, "every restart repeats it: nothing is duplicated");
    const imported = (await request(baseUrl, "GET", "/mail/messages")).body.messages;
    assert.deepEqual(imported.map((row: any) => [row.direction, row.sentBy, row.leadName, row.subject]).sort(), [["outbound", "marta", "Luciano Tantucci", "Preventivo"], ["outbound", "marta", "Luciano Tantucci", "Re: Preventivo"]]);
    assert.equal((await ingestRawMail(reply.replace("<r1@test>", "<r3@test>"), own, deps))?.leadId, lead.id, "a reply to an older mail finds its practice");
  } finally {
    for (const key of ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD"]) delete process.env[key];
  }
  console.log("PASS email replies: threaded on the CRM mail, answered in the conversation, linked senders reach the history");
}

async function main() {
  await withServer(async (baseUrl) => {
    await archiveChecks(baseUrl);
    await workedChecks(baseUrl);
    await emailChecks(baseUrl);
    await replyChecks(baseUrl);
  });
}

main()
  .then(() => { cleanupDb(); console.log("All lead-action checks passed."); })
  .catch((error) => { cleanupDb(); console.error(error); process.exitCode = 1; });
