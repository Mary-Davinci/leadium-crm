import nodemailer from "nodemailer";

/**
 * Customer email from the company mailbox (e.g. servizioclienti@crocieriamo.com on Aruba:
 * SMTP_HOST=smtps.aruba.it, SMTP_PORT=465). Credentials only come from the environment.
 * MAIL_BCC (default: the sender) keeps a copy in the mailbox, since SMTP does not file the
 * message under "Sent".
 */
export type MailConfig = { host: string; port: number; user: string; password: string; from: string; fromName: string; bcc: string };

export function mailConfig(env: NodeJS.ProcessEnv = process.env): MailConfig | null {
  const host = String(env.SMTP_HOST || "").trim();
  const user = String(env.SMTP_USER || "").trim();
  const password = String(env.SMTP_PASSWORD || "");
  if (!host || !user || !password) return null;
  const port = Number(env.SMTP_PORT || 465);
  const from = String(env.MAIL_FROM || user).trim();
  return {
    host, port: Number.isInteger(port) && port > 0 ? port : 465, user, password, from,
    fromName: String(env.MAIL_FROM_NAME || "Crocieriamo").trim(),
    bcc: String(env.MAIL_BCC ?? from).trim()
  };
}

export const MAX_EMAIL_SUBJECT = 200;
export const MAX_EMAIL_TEXT = 20000;
const EMAIL_PATTERN = /^[^\s@<>(),;:"\\[\]]+@[^\s@<>(),;:"\\[\]]+\.[^\s@<>(),;:"\\[\]]+$/;

export class MailError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** One plain recipient, a one-line subject and a text body: nothing the browser could turn into headers. */
export function validateCustomerEmail(input: { to: unknown; subject: unknown; text: unknown }) {
  const to = String(input.to || "").trim();
  const subject = String(input.subject || "").replace(/[\r\n]+/g, " ").trim();
  const text = String(input.text || "").replace(/\r\n/g, "\n").trim();
  if (!to || !EMAIL_PATTERN.test(to)) throw new MailError(422, "Il cliente non ha un indirizzo email valido: correggilo con \"Modifica dati\".");
  if (!subject) throw new MailError(400, "Scrivi l'oggetto della mail.");
  if (subject.length > MAX_EMAIL_SUBJECT) throw new MailError(400, `Oggetto troppo lungo (massimo ${MAX_EMAIL_SUBJECT} caratteri).`);
  if (!text) throw new MailError(400, "Scrivi il testo della mail.");
  if (text.length > MAX_EMAIL_TEXT) throw new MailError(400, "Testo troppo lungo.");
  return { to, subject, text };
}

type Transport = { sendMail(message: Record<string, unknown>): Promise<{ messageId?: string }> };
let transportFactory: (config: MailConfig) => Transport = (config) => nodemailer.createTransport({
  host: config.host, port: config.port, secure: config.port === 465,
  auth: { user: config.user, pass: config.password },
  connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000
});

/** Tests only: replaces the SMTP transport. */
export function setMailTransportFactory(factory: typeof transportFactory) { transportFactory = factory; }

/** inReplyTo and references keep an answer in the customer's conversation. */
export async function sendCustomerEmail(config: MailConfig, message: { to: string; subject: string; text: string; inReplyTo?: string; references?: string[] }) {
  try {
    const info = await transportFactory(config).sendMail({
      from: { name: config.fromName, address: config.from },
      to: message.to,
      ...(config.bcc ? { bcc: config.bcc } : {}),
      replyTo: config.from,
      subject: message.subject,
      text: message.text,
      ...(message.inReplyTo ? { inReplyTo: message.inReplyTo, references: message.references || [message.inReplyTo] } : {})
    });
    return { messageId: String(info?.messageId || "") };
  } catch {
    // Never forward SMTP server text (it can echo addresses or credentials hints).
    throw new MailError(502, "Invio non riuscito: il server di posta non ha accettato la mail. Riprova tra poco o avvisa un amministratore.");
  }
}
