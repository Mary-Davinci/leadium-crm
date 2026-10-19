/**
 * Phone equivalence used for duplicate detection (lead creation and admin phone correction).
 *
 * Stored values keep their original text; only the digits are indexed (phoneNormalized).
 * Two numbers match when their key sets intersect:
 * - "+CC..." and "00CC..." are the same international number;
 * - digits-only forms match by digits (e.g. WhatsApp wa_id "393331234567" = "+39 333 1234567");
 * - a prefix-less national number is equated to +CC ONLY when the deployment declares its default
 *   country with PHONE_DEFAULT_COUNTRY_CODE. The shape "3..."/"0..." alone does not identify a
 *   country, so without that setting national numbers are never merged with international ones.
 *   Supported value: "39" (Italian numbering plan: mobile 3xxxxxxxx(x), landline 0xxxxx...).
 * No existing data is rewritten by this module.
 */
const ITALIAN_NATIONAL = /^(3\d{8,9}|0\d{5,10})$/;

/** Explicit, documented default country; any other value disables national equivalence. */
export function defaultCountryCode() {
  return String(process.env.PHONE_DEFAULT_COUNTRY_CODE || "").trim() === "39" ? "39" : "";
}

export function phoneDigits(value: unknown) {
  return String(value ?? "").replace(/\D+/g, "");
}

export function isInternationalPhone(value: unknown) {
  const raw = String(value ?? "").trim();
  return raw.startsWith("+") || /^00[1-9]/.test(phoneDigits(raw));
}

export function phoneMatchKeys(value: unknown): string[] {
  const digits = phoneDigits(value);
  if (!digits) return [];
  const italianDefault = defaultCountryCode() === "39";
  const keys = new Set<string>();
  if (isInternationalPhone(value)) {
    const international = digits.startsWith("00") ? digits.slice(2) : digits;
    keys.add(international);
    keys.add("00" + international);
    if (italianDefault && international.startsWith("39") && ITALIAN_NATIONAL.test(international.slice(2))) keys.add(international.slice(2));
  } else {
    keys.add(digits);
    if (italianDefault && ITALIAN_NATIONAL.test(digits)) {
      keys.add("39" + digits);
      keys.add("0039" + digits);
    }
  }
  return [...keys];
}

export function phonesMatch(a: unknown, b: unknown) {
  const keys = new Set(phoneMatchKeys(a));
  return phoneMatchKeys(b).some(key => keys.has(key));
}

/** Validation for an admin correction: the stored value must be unambiguous (international). */
export function validateCorrectedPhone(value: unknown): { ok: true; phone: string } | { ok: false; error: string } {
  const phone = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  const digits = phoneDigits(phone);
  if (!phone || !/^\+?[\d .()/-]+$/.test(phone)) return { ok: false, error: "Numero di telefono non valido: usa solo cifre, spazi e il prefisso internazionale." };
  if (!isInternationalPhone(phone)) return { ok: false, error: "Indica il numero in formato internazionale (es. +39 333 1234567): senza prefisso il paese e ambiguo." };
  const international = digits.startsWith("00") ? digits.slice(2) : digits;
  if (international.length < 8 || international.length > 15) return { ok: false, error: "Numero di telefono non valido: lunghezza non compatibile con un numero internazionale." };
  return { ok: true, phone };
}

/** For technical logs only: never the full number. */
export function maskPhone(value: unknown) {
  const digits = phoneDigits(value);
  return digits ? `${digits.length}d..${digits.slice(-2)}` : "-";
}
