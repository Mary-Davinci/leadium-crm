import { getCustomerById, listCustomersByEmail, listCustomersByPhone, CustomerRecord } from "./customerStore";
import { listLeads, listLeadsByContact, normalizeEmail } from "./leadStore";
import { maskPhone, phonesMatch, validateCorrectedPhone } from "./phoneIdentity";

export type ContactField = "fullName" | "phone" | "email";
export type ContactValues = Partial<Record<ContactField, string>>;
export type CustomerScope = "lead_only" | "lead_and_customer";
type Refusal = { ok: false; status: number; body: Record<string, unknown> };
export type ContactCorrectionPlan = Refusal | {
  ok: true; noop: boolean; changed: ContactField[]; previous: ContactValues; next: ContactValues;
  customer: CustomerRecord | null; updateCustomer: boolean;
};

export const CONTACT_FIELDS: ContactField[] = ["fullName", "phone", "email"];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const normalizeName = (value: unknown) => String(value || "").trim().replace(/\s+/g, " ").toLowerCase();

export function validateFullName(value: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const name = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!name) return { ok: false, error: "Nome e cognome sono obbligatori." };
  if (name.length > 120) return { ok: false, error: "Nome e cognome troppo lunghi (massimo 120 caratteri)." };
  if (!/\p{L}/u.test(name)) return { ok: false, error: "Nome e cognome devono contenere delle lettere." };
  return { ok: true, value: name };
}

/** An empty value clears the email; anything else must look like an address. */
export function validateEmail(value: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const email = typeof value === "string" ? value.trim() : "";
  if (!email) return { ok: true, value: "" };
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) return { ok: false, error: "Email non valida (es. nome@dominio.it)." };
  return { ok: true, value: email };
}

/**
 * Decides what a contact correction (name, phone, email) may touch, before any write.
 * - another person's lead or customer with the same phone or email: conflict, never a merge;
 * - lead linked unambiguously to its customer (only lead, same data): the customer follows;
 * - shared customer or customer with different data: explicit choice required.
 * leadId/customerId and history links never change.
 */
export async function planLeadContactCorrection(lead: any, input: Record<string, unknown>, scope: unknown): Promise<ContactCorrectionPlan> {
  const previous: ContactValues = {}, next: ContactValues = {}, changed: ContactField[] = [];
  for (const field of CONTACT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) continue;
    const current = String(lead[field] || "");
    const raw = input[field];
    let value: string;
    if (field === "phone") {
      // An untouched (possibly legacy, national) number is not re-validated.
      if (typeof raw === "string" && raw.trim() === current.trim()) continue;
      const valid = validateCorrectedPhone(raw);
      if (valid.ok === false) return { ok: false, status: 400, body: { error: valid.error, field } };
      value = valid.phone;
    } else {
      const valid = field === "fullName" ? validateFullName(raw) : validateEmail(raw);
      if (valid.ok === false) return { ok: false, status: 400, body: { error: valid.error, field } };
      value = valid.value;
    }
    if (value === current) continue;
    previous[field] = current; next[field] = value; changed.push(field);
  }
  if (!changed.length) return { ok: true, noop: true, changed, previous, next, customer: null, updateCustomer: false };

  if (next.phone !== undefined) {
    const otherLeads = (await listLeadsByContact(next.phone, "")).map(row => row.lead).filter(row => row.id !== lead.id);
    // Earlier opportunities of the same customer may legitimately share the number.
    const foreign = otherLeads.filter(row => !lead.customerId || row.customerId !== lead.customerId);
    if (foreign.length) {
      return { ok: false, status: 409, body: {
        code: "phone_conflict_lead", field: "phone",
        error: `Numero gia usato da ${foreign.length === 1 ? "un altro lead" : `${foreign.length} altri lead`} di un'altra persona. Nessuna modifica salvata e nessuna unione: verifica i record.`,
        conflictLeadIds: foreign.slice(0, 5).map(row => row.id)
      } };
    }
    if ((await listCustomersByPhone(next.phone)).some(row => row.id !== lead.customerId)) {
      return { ok: false, status: 409, body: { code: "phone_conflict_customer", field: "phone", error: "Numero gia associato a un'altra scheda cliente. Nessuna modifica salvata e nessuna unione: verifica i record." } };
    }
  }
  if (next.email && normalizeEmail(next.email) !== normalizeEmail(previous.email || "")) {
    const foreign = (await listLeadsByContact("", next.email)).map(row => row.lead)
      .filter(row => row.id !== lead.id && (!lead.customerId || row.customerId !== lead.customerId));
    if (foreign.length) {
      return { ok: false, status: 409, body: {
        code: "email_conflict_lead", field: "email",
        error: `Email gia usata da ${foreign.length === 1 ? "un altro lead" : `${foreign.length} altri lead`} di un'altra persona. Nessuna modifica salvata e nessuna unione: verifica i record.`,
        conflictLeadIds: foreign.slice(0, 5).map(row => row.id)
      } };
    }
    if ((await listCustomersByEmail(next.email)).some(row => row.id !== lead.customerId)) {
      return { ok: false, status: 409, body: { code: "email_conflict_customer", field: "email", error: "Email gia associata a un'altra scheda cliente. Nessuna modifica salvata e nessuna unione: verifica i record." } };
    }
  }

  const customer = lead.customerId ? await getCustomerById(String(lead.customerId)) : null;
  if (!customer) return { ok: true, noop: false, changed, previous, next, customer: null, updateCustomer: false };
  const siblings = (await listLeads({ customerId: customer.id })).filter((row: any) => row.id !== lead.id);
  // The customer card follows only if it still holds what the lead had (or nothing) for every changed field.
  const fieldAligned = (field: ContactField) => {
    const stored = String((customer as any)[field] || "");
    if (!stored) return true;
    if (field === "phone") return phonesMatch(stored, previous.phone || "");
    if (field === "email") return normalizeEmail(stored) === normalizeEmail(previous.email || "");
    return normalizeName(stored) === normalizeName(previous.fullName);
  };
  const aligned = changed.every(fieldAligned);
  if (!siblings.length && aligned) return { ok: true, noop: false, changed, previous, next, customer, updateCustomer: true };
  if (scope === "lead_only" || scope === "lead_and_customer") {
    return { ok: true, noop: false, changed, previous, next, customer, updateCustomer: scope === "lead_and_customer" };
  }
  return { ok: false, status: 409, body: {
    code: "customer_choice_required",
    error: siblings.length
      ? `La scheda cliente e condivisa con ${siblings.length === 1 ? "un'altra pratica" : `altre ${siblings.length} pratiche`}: scegli se aggiornare anche la scheda cliente.`
      : "I dati della scheda cliente sono diversi da quelli della pratica: scegli se aggiornare anche la scheda cliente.",
    impact: {
      otherLeadCount: siblings.length, customerDiffers: !aligned,
      customerPhoneDiffers: changed.includes("phone") && !fieldAligned("phone"),
      customerPhoneTail: changed.includes("phone") ? maskPhone(customer.phone) : ""
    }
  } };
}

export type ContactWriter = {
  /** Conditional writes: return false when a stored value is no longer the `expected` one. */
  setLeadContact(leadId: string, expected: ContactValues, next: ContactValues, at: string): Promise<boolean>;
  setCustomerContact(customerId: string, expected: ContactValues, next: ContactValues, at: string): Promise<boolean>;
  appendActivity(activity: any): Promise<void>;
};

export class ContactCorrectionError extends Error {
  constructor(public status: number, message: string, public incoherent = false) { super(message); }
}

/**
 * No multi-document transaction is available on every deployment (Mongo may be standalone,
 * JSON in development): writes are conditional and compensated in reverse order, so a failure
 * never leaves the lead updated with a stale customer (or vice versa) without being reported.
 */
export async function applyLeadContactCorrection(plan: Extract<ContactCorrectionPlan, { ok: true }>, leadId: string, activity: any, writer: ContactWriter) {
  const at = new Date().toISOString();
  const customer = plan.updateCustomer ? plan.customer : null;
  const customerBefore: ContactValues = {};
  if (customer) for (const field of plan.changed) customerBefore[field] = String((customer as any)[field] || "");
  const undo: Array<() => Promise<boolean>> = [];
  const rollback = async (cause: string) => {
    for (const step of undo.reverse()) {
      let restored = false;
      try { restored = await step(); } catch { restored = false; }
      if (!restored) {
        console.error(`[lead] contact correction rollback failed lead=${leadId} customer=${customer?.id || "-"} cause=${cause}`);
        throw new ContactCorrectionError(500, `Correzione dati di contatto incompleta: verificare manualmente lead ${leadId}${customer ? ` e cliente ${customer.id}` : ""}.`, true);
      }
    }
  };
  if (customer) {
    if (!await writer.setCustomerContact(customer.id, customerBefore, plan.next, at)) throw new ContactCorrectionError(409, "La scheda cliente e stata modificata nel frattempo: ricarica e riprova.");
    undo.push(() => writer.setCustomerContact(customer.id, plan.next, customerBefore, at));
  }
  let leadUpdated = false;
  try { leadUpdated = await writer.setLeadContact(leadId, plan.previous, plan.next, at); }
  catch { await rollback("lead_write_failed"); throw new ContactCorrectionError(503, "Salvataggio non riuscito: nessuna modifica applicata. Riprova."); }
  if (!leadUpdated) { await rollback("lead_changed"); throw new ContactCorrectionError(409, "Il lead e stato modificato nel frattempo: ricarica e riprova."); }
  undo.push(() => writer.setLeadContact(leadId, plan.next, plan.previous, at));
  try { await writer.appendActivity(activity); }
  catch { await rollback("audit_failed"); throw new ContactCorrectionError(503, "Audit non disponibile: nessuna modifica applicata. Riprova."); }
  console.log(`[lead] contact corrected lead=${leadId} fields=${plan.changed.join(",")} customerUpdated=${Boolean(customer)}${plan.next.phone ? ` phone=${maskPhone(plan.next.phone)}` : ""}`);
}
