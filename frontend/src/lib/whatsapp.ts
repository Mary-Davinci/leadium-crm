export type WhatsAppTemplateKey = "generic" | "documents" | "payment" | "callback";

export const WHATSAPP_TEMPLATES: Record<WhatsAppTemplateKey, { label: string; message: string }> = {
  generic: {
    label: "Apri chat",
    message: ""
  },
  documents: {
    label: "Richiedi documenti",
    message: "Ciao, ti contatto da Crocieriamo. Quando puoi inviaci i documenti richiesti per completare la pratica. Grazie."
  },
  payment: {
    label: "Sollecito pagamento",
    message: "Ciao, ti contatto da Crocieriamo. Ti ricordiamo il pagamento da completare per proseguire con la pratica. Grazie."
  },
  callback: {
    label: "Richiesta richiamata",
    message: "Ciao, ti contatto da Crocieriamo. Quando sei disponibile per un rapido contatto telefonico? Grazie."
  }
};

export function sanitizeWhatsAppPhone(phone: string) {
  const normalized = String(phone || "").trim();
  if (!normalized) return "";
  const hasPlus = normalized.startsWith("+");
  const digitsOnly = normalized.replace(/[^\d]/g, "");
  if (!digitsOnly) return "";
  return hasPlus ? digitsOnly : digitsOnly;
}

export function buildWhatsAppUrl(phone: string, message = "") {
  const sanitized = sanitizeWhatsAppPhone(phone);
  if (!sanitized) return "";
  const url = new URL(`https://wa.me/${sanitized}`);
  const trimmedMessage = String(message || "").trim();
  if (trimmedMessage) {
    url.searchParams.set("text", trimmedMessage);
  }
  return url.toString();
}
