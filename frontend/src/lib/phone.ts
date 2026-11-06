/** A value that can be a phone at all: a surname in the field is not one. */
export function isUsablePhone(phone?: string | null) {
  const digits = String(phone || "").replace(/\D+/g, "").length;
  return digits >= 8 && digits <= 15;
}

export const INVALID_PHONE_MESSAGE = "Il telefono deve essere un numero, ad esempio +39 333 1234567. Controlla di non aver scritto il cognome in questo campo.";
