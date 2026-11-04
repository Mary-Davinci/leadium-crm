import { simpleParser } from "mailparser";
import { findLeadIdByMessageIds, InboxSyncState, mailRecordId, MailRecord, readInboxSync, saveMailIfNew, writeInboxSync } from "./mailStore";

/**
 * Reads the replies from the company mailbox (Aruba IMAP) into Leadium. The mailbox stays as it is:
 * it is opened read-only and nothing is moved, deleted or marked as read, so the webmail keeps
 * working. Same credentials as sending unless IMAP_USER/IMAP_PASSWORD say otherwise.
 */
export type InboxConfig = { host: string; port: number; user: string; password: string; address: string };

const FIRST_READ_DAYS = 14;
const MAX_TEXT = 20000;
export const MAX_MESSAGE_BYTES = 5 * 1024 * 1024;

export function inboxConfig(env: NodeJS.ProcessEnv = process.env): InboxConfig | null {
  const smtpHost = String(env.SMTP_HOST || "").trim().toLowerCase();
  const host = String(env.IMAP_HOST || "").trim() || (smtpHost.endsWith("aruba.it") ? "imaps.aruba.it" : "");
  const user = String(env.IMAP_USER || env.SMTP_USER || "").trim();
  const password = String(env.IMAP_PASSWORD || env.SMTP_PASSWORD || "");
  if (!host || !user || !password) return null;
  const port = Number(env.IMAP_PORT || 993);
  return { host, port: Number.isInteger(port) && port > 0 ? port : 993, user, password, address: String(env.MAIL_FROM || user).trim().toLowerCase() };
}

/** Text only: a customer's HTML never reaches the operators' browser. */
export async function parseRawMail(raw: Buffer | string) {
  const parsed = await simpleParser(raw, { skipHtmlToText: false, skipImageLinks: true });
  const sender = parsed.from?.value?.[0];
  const recipients = Array.isArray(parsed.to) ? parsed.to : parsed.to ? [parsed.to] : [];
  const inReplyTo = String(parsed.inReplyTo || "").trim();
  const references = (Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : []).map(String);
  return {
    messageId: String(parsed.messageId || "").trim(),
    from: String(sender?.address || "").trim().toLowerCase(),
    fromName: String(sender?.name || "").trim(),
    to: recipients.flatMap((group) => group.value.map((item) => item.address || "")).filter(Boolean).join(", "),
    subject: String(parsed.subject || "").trim(),
    text: String(parsed.text || "").slice(0, MAX_TEXT),
    receivedAt: (parsed.date || new Date()).toISOString(),
    inReplyTo,
    // Some mail clients send only In-Reply-To: the chain must still name the answered mail.
    references: inReplyTo && !references.includes(inReplyTo) ? [...references, inReplyTo] : references,
    attachments: parsed.attachments.filter((item) => !item.related).map((item) => ({ filename: String(item.filename || "allegato"), mimeType: String(item.contentType || ""), size: Number(item.size || 0) }))
  };
}

export type InboxDeps = {
  /** The practice with this customer email, when there is one. */
  findLeadIdByEmail(email: string): Promise<string | null>;
  /** Called once per new reply linked to a practice (timeline). */
  onReceived(record: MailRecord): Promise<void>;
};

/** Returns the stored record, or null for the mailbox's own copies and messages already stored. */
export async function ingestRawMail(raw: Buffer | string, ownAddress: string, deps: InboxDeps) {
  const mail = await parseRawMail(raw);
  // The BCC copy of what the CRM sends lands in this same mailbox.
  if (!mail.from || mail.from === ownAddress) return null;
  const threadIds = [mail.inReplyTo, ...mail.references];
  const leadId = (await findLeadIdByMessageIds(threadIds)) || (await deps.findLeadIdByEmail(mail.from));
  const messageId = mail.messageId || `${mail.from}|${mail.receivedAt}|${mail.subject}`;
  const record: MailRecord = { ...mail, messageId, id: mailRecordId(messageId), direction: "inbound", leadId, readAt: null, readBy: "", sentBy: "" };
  if (!(await saveMailIfNew(record))) return null;
  if (leadId) await deps.onReceived(record);
  return record;
}

/** Mails sent before the inbox existed live only in the practice history: they open the conversations. */
export async function importSentMail(activities: any[], fromAddress: string) {
  let imported = 0;
  for (const activity of activities) {
    const meta = activity.meta || {};
    const messageId = String(meta.messageId || activity.id);
    const saved = await saveMailIfNew({
      id: mailRecordId(messageId), messageId, direction: "outbound", from: String(meta.from || fromAddress).toLowerCase(), fromName: "", to: String(meta.to || ""),
      subject: String(meta.subject || ""), text: String(meta.text || ""), receivedAt: String(activity.createdAt), inReplyTo: "", references: [],
      leadId: String(activity.leadId), attachments: [], readAt: String(activity.createdAt), readBy: String(activity.actor || ""), sentBy: String(activity.actor || "")
    });
    if (saved) imported += 1;
  }
  return imported;
}

export type MailboxMessage = { uid: number; source: Buffer };
export type OpenMailbox = {
  uidValidity: string;
  /** UIDs from fromUid on, or from `since` the first time; ascending. */
  messages(fromUid: number | null, since: Date): AsyncIterable<MailboxMessage>;
  close(): Promise<void>;
};

export function imapMailbox(config: InboxConfig) {
  return async (): Promise<OpenMailbox> => {
    const { ImapFlow } = require("imapflow");
    const client = new ImapFlow({ host: config.host, port: config.port, secure: true, auth: { user: config.user, pass: config.password }, logger: false, socketTimeout: 60000 });
    await client.connect();
    const lock = await client.getMailboxLock("INBOX", { readOnly: true });
    return {
      uidValidity: String(client.mailbox.uidValidity),
      async *messages(fromUid, since) {
        const uids: number[] = fromUid ? [] : ((await client.search({ since }, { uid: true })) || []);
        if (!fromUid && !uids.length) return;
        const range = fromUid ? `${fromUid}:*` : uids.join(",");
        // maxLength keeps a mail with heavy attachments from filling the memory: the text comes first.
        for await (const message of client.fetch(range, { uid: true, source: { maxLength: MAX_MESSAGE_BYTES } }, { uid: true })) {
          yield { uid: Number(message.uid), source: message.source };
        }
      },
      async close() {
        lock.release();
        await client.logout().catch(() => client.close());
      }
    };
  };
}

let inboxReachedOnce = false;

/** One round. A failure stops here and the next round resumes from the last message saved. */
export async function syncInbox(open: () => Promise<OpenMailbox>, ownAddress: string, deps: InboxDeps, now = Date.now()) {
  let mailbox: OpenMailbox | null = null;
  let stored = 0;
  const state = await readInboxSync();
  try {
    mailbox = await open();
    const sameBox = state.uidValidity === mailbox.uidValidity && Number.isInteger(state.lastUid);
    const fromUid = sameBox ? Number(state.lastUid) + 1 : null;
    let lastUid = sameBox ? Number(state.lastUid) : 0;
    for await (const message of mailbox.messages(fromUid, new Date(now - FIRST_READ_DAYS * 24 * 3600 * 1000))) {
      // IMAP answers "n:*" with the newest message even when it is older than n.
      if (fromUid && message.uid < fromUid) continue;
      if (await ingestRawMail(message.source, ownAddress, deps)) stored += 1;
      lastUid = Math.max(lastUid, message.uid);
      await writeInboxSync({ uidValidity: mailbox.uidValidity, lastUid });
    }
    await writeInboxSync({ uidValidity: mailbox.uidValidity, lastUid, lastSyncAt: new Date(now).toISOString(), lastError: null });
    // Logged when something changes, not every minute: first success, new mail, a recovered error.
    if (stored || !inboxReachedOnce || state.lastError) console.log(`[mail] casella letta: ${stored} nuove email`);
    inboxReachedOnce = true;
    return stored;
  } catch (error: any) {
    // The stage only: server text can echo the account.
    const failure: InboxSyncState = { lastError: error?.authenticationFailed ? "Accesso alla casella rifiutato: controlla utente e password." : "Casella non raggiungibile." };
    await writeInboxSync(failure).catch(() => {});
    console.error(`[mail] lettura casella fallita: ${failure.lastError}`);
    return stored;
  } finally {
    await mailbox?.close().catch(() => {});
  }
}
