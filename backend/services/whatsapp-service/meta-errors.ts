// Maps a failed Meta Cloud API call to a stable code + an operator-facing Italian message.
// Operators used to see Meta's raw JSON ("Meta send failed (400): {...}") in the chat; the raw
// detail stays in the service log (it never contains our access token -- that only travels in
// the request header), the UI gets something actionable.

export type MetaErrorCode =
  | "window_closed"
  | "undeliverable"
  | "recipient_not_allowed"
  | "auth"
  | "media"
  | "template"
  | "rate_limit"
  | "unsupported"
  | "provider_error";

const FRIENDLY_MESSAGES: Record<MetaErrorCode, string> = {
  window_closed: "La finestra di 24 ore e chiusa: invia un template approvato per riaprire la conversazione.",
  undeliverable: "Messaggio non consegnabile: il numero potrebbe non avere WhatsApp attivo.",
  recipient_not_allowed: "Questo numero non e abilitato a ricevere messaggi dall'account WhatsApp in uso.",
  auth: "Connessione a WhatsApp non valida o scaduta. Avvisa un amministratore.",
  media: "WhatsApp non ha accettato l'allegato. Controlla formato e dimensione del file.",
  template: "Template non disponibile o non approvato su WhatsApp.",
  rate_limit: "Troppi messaggi in poco tempo. Riprova tra qualche minuto.",
  unsupported: "Tipo di messaggio non supportato da WhatsApp.",
  provider_error: "WhatsApp non ha accettato il messaggio. Riprova; se il problema continua avvisa un amministratore."
};

const RATE_LIMIT_CODES = new Set([4, 80007, 130429, 131048, 131056]);
const AUTH_CODES = new Set([0, 10, 190, 200]);

export function classifyMetaError(httpStatus: number, metaCode?: number | null): MetaErrorCode {
  // Number(null) is 0, which is a real Meta auth code: an unparseable error body must not count.
  const code = metaCode === null || metaCode === undefined ? NaN : Number(metaCode);
  if (code === 131047) return "window_closed";
  if (code === 131026) return "undeliverable";
  if (code === 131030) return "recipient_not_allowed";
  if (code === 131052 || code === 131053) return "media";
  if (code === 131051) return "unsupported";
  if (code >= 132000 && code < 133000) return "template";
  if (RATE_LIMIT_CODES.has(code)) return "rate_limit";
  if (AUTH_CODES.has(code) || httpStatus === 401) return "auth";
  if (httpStatus === 429) return "rate_limit";
  return "provider_error";
}

export class MetaSendError extends Error {
  readonly code: MetaErrorCode;
  readonly httpStatus: number;
  readonly metaCode: number | null;
  readonly isMetaSendError = true;

  constructor(httpStatus: number, metaCode: number | null, code: MetaErrorCode) {
    super(FRIENDLY_MESSAGES[code]);
    this.code = code;
    this.httpStatus = httpStatus;
    this.metaCode = metaCode;
  }
}

export function createMetaSendError(httpStatus: number, rawBody: string, context: string) {
  let metaCode: number | null = null;
  let metaMessage = "";
  try {
    const parsed = JSON.parse(rawBody);
    if (parsed?.error) {
      metaCode = Number.isFinite(Number(parsed.error.code)) ? Number(parsed.error.code) : null;
      metaMessage = String(parsed.error.error_data?.details || parsed.error.message || "");
    }
  } catch {
    metaMessage = String(rawBody || "").slice(0, 300);
  }
  const code = classifyMetaError(httpStatus, metaCode);
  // eslint-disable-next-line no-console
  console.error(`[whatsapp-service] ${context} fallito: http=${httpStatus} metaCode=${metaCode ?? "-"} code=${code} detail=${metaMessage.slice(0, 300)}`);
  return new MetaSendError(httpStatus, metaCode, code);
}

export function getFriendlyMetaMessage(code: MetaErrorCode) {
  return FRIENDLY_MESSAGES[code];
}
