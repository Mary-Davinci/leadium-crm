/**
 * Dialing format for the PBX, applied only at the telephony boundary: the stored number, the
 * WhatsApp identity and duplicate matching are never changed by this module.
 *
 * Italian numbers identified with certainty are sent in national format, the form verified to
 * work with the Leadium 3CX outbound rules:
 * - "+39 …"  -> national;
 * - "0039 …" -> national;
 * - "39…" without "+" only when it is a WhatsApp identity (wa_id is E.164 without "+");
 * - an already national number is unchanged.
 * Everything else (foreign numbers, ambiguous digits) is sent exactly as before.
 */
const ITALIAN_NATIONAL = /^(3\d{8,9}|0\d{5,10})$/;

export type DialRule = "it_plus" | "it_00" | "it_whatsapp" | "unchanged";

export function composeDialNumber(stored: string, options: { whatsappIdentity?: boolean } = {}): { destination: string; rule: DialRule } {
  const raw = String(stored || "").trim();
  const digits = raw.replace(/\D+/g, "");
  if (raw.startsWith("+") && digits.startsWith("39") && ITALIAN_NATIONAL.test(digits.slice(2))) {
    return { destination: digits.slice(2), rule: "it_plus" };
  }
  if (/^[\s(]*00/.test(raw) && digits.startsWith("0039") && ITALIAN_NATIONAL.test(digits.slice(4))) {
    return { destination: digits.slice(4), rule: "it_00" };
  }
  if (options.whatsappIdentity && /^\d+$/.test(raw) && digits.startsWith("39") && ITALIAN_NATIONAL.test(digits.slice(2))) {
    return { destination: digits.slice(2), rule: "it_whatsapp" };
  }
  return { destination: raw, rule: "unchanged" };
}
