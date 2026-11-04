import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
delete process.env.MONGODB_URI;
process.env.MAIL_DB_FILE = path.join(os.tmpdir(), `leadium-mail-${process.pid}.json`);

const OWN = "servizioclienti@crocieriamo.com";
const raw = (headers: Record<string, string>, body = "Va bene, grazie.") => [
  "From: Mario Rossi <Mario.Rossi@example.test>", `To: ${OWN}`, "Subject: Re: Preventivo", "Date: Wed, 04 Nov 2026 10:00:00 +0100", "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8",
  ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`), "", body
].join("\r\n");

async function main() {
  const { inboxConfig, ingestRawMail, parseRawMail, syncInbox } = require("./mailInbox");
  const store = require("./mailStore");
  const received: any[] = [];
  const deps = { findLeadIdByEmail: async (email: string) => (email === "mario.rossi@example.test" ? "lead-mail" : null), onReceived: async (record: any) => { received.push(record); } };
  try {
    assert.equal(inboxConfig({ SMTP_HOST: "smtps.aruba.it", SMTP_USER: OWN, SMTP_PASSWORD: "x" }).host, "imaps.aruba.it", "Aruba needs no extra setting");
    assert.equal(inboxConfig({ SMTP_HOST: "smtp.other.test", SMTP_USER: OWN, SMTP_PASSWORD: "x" }), null, "another provider must be named");
    assert.equal(inboxConfig({ SMTP_HOST: "smtps.aruba.it", SMTP_USER: OWN, SMTP_PASSWORD: "x", MAIL_FROM: "Other@Crocieriamo.com" }).address, "other@crocieriamo.com");
    console.log("PASS inbox configuration");

    const html = await parseRawMail(["From: a@example.test", "Subject: x", "MIME-Version: 1.0", "Content-Type: text/html; charset=utf-8", "", "<p>Ciao <b>mondo</b></p><script>alert(1)</script>"].join("\r\n"));
    assert.ok(html.text.includes("Ciao"));
    assert.ok(!/<script|<b>/.test(html.text), "customer HTML never reaches the record");
    console.log("PASS an HTML mail is stored as text");

    const bySender = await ingestRawMail(raw({ "Message-ID": "<a@example.test>" }), OWN, deps);
    assert.deepEqual([bySender.leadId, bySender.from, bySender.direction, bySender.readAt], ["lead-mail", "mario.rossi@example.test", "inbound", null]);
    assert.equal(received.length, 1, "the timeline hears of it once");
    assert.equal(await ingestRawMail(raw({ "Message-ID": "<a@example.test>" }), OWN, deps), null, "a re-read stores nothing");
    assert.equal(received.length, 1);
    console.log("PASS reply matched by sender, stored once");

    await store.saveMailIfNew({ id: "out", messageId: "<sent@crocieriamo.com>", direction: "outbound", from: OWN, fromName: "", to: "x@other.test", subject: "s", text: "t", receivedAt: "2026-11-04T08:00:00.000Z", inReplyTo: "", references: [], leadId: "lead-thread", attachments: [], readAt: null, readBy: "", sentBy: "marta" });
    const threaded = await ingestRawMail(raw({ "Message-ID": "<b@example.test>", "In-Reply-To": "<sent@crocieriamo.com>", From: "x" }).replace("Mario.Rossi@example.test", "altro.indirizzo@example.test"), OWN, deps);
    assert.equal(threaded.leadId, "lead-thread", "the conversation beats the sender address");
    console.log("PASS reply from a different address follows the conversation");

    const unknown = await ingestRawMail(raw({ "Message-ID": "<c@example.test>" }).replace("Mario.Rossi@example.test", "nessuno@example.test"), OWN, deps);
    assert.equal(unknown.leadId, null);
    assert.equal(received.length, 2, "no timeline without a practice");
    assert.equal(await ingestRawMail(raw({ "Message-ID": "<d@example.test>" }).replace("Mario.Rossi@example.test", "Servizioclienti@crocieriamo.com"), OWN, deps), null, "the mailbox's own BCC copy is skipped");
    console.log("PASS unknown sender kept without practice, own copies skipped");

    const box = (uidValidity: string, list: Array<{ uid: number; source: string }>, calls: any[]) => async () => ({
      uidValidity,
      messages: async function* (fromUid: number | null) { calls.push(fromUid); yield* list; },
      close: async () => {}
    });
    fs.rmSync(process.env.MAIL_DB_FILE as string, { force: true });
    const calls: any[] = [];
    const first = [{ uid: 10, source: raw({ "Message-ID": "<u10@x>" }) }, { uid: 11, source: raw({ "Message-ID": "<u11@x>" }) }];
    assert.equal(await syncInbox(box("7", first, calls), OWN, deps), 2);
    assert.equal(calls[0], null, "first read goes by date");
    assert.equal(await syncInbox(box("7", [first[1]], calls), OWN, deps), 0, "the newest answered again by the server is skipped");
    assert.equal(calls[1], 12, "the next round resumes after the last message");
    assert.equal((await store.readInboxSync()).lastUid, 11);
    await syncInbox(box("8", [], calls), OWN, deps);
    assert.equal(calls[2], null, "a rebuilt mailbox restarts by date");
    console.log("PASS rounds resume from the last message");

    const secret = "password-del-server";
    const failed = await syncInbox(async () => { throw Object.assign(new Error(secret), { authenticationFailed: true }); }, OWN, deps);
    assert.equal(failed, 0);
    const state = await store.readInboxSync();
    assert.equal(state.lastError, "Accesso alla casella rifiutato: controlla utente e password.");
    assert.ok(!JSON.stringify(state).includes(secret));
    console.log("PASS a refused login is reported without server text");
  } finally {
    fs.rmSync(process.env.MAIL_DB_FILE as string, { force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
