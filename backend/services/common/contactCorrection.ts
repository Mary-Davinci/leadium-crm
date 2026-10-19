import { getCustomerById, listCustomersByPhone, CustomerRecord } from "./customerStore";
import { listLeads, listLeadsByContact } from "./leadStore";
import { maskPhone, phonesMatch, validateCorrectedPhone } from "./phoneIdentity";

export type CustomerPhoneScope = "lead_only" | "lead_and_customer";
type Refusal = { ok: false; status: number; body: Record<string, unknown> };
export type PhoneCorrectionPlan = Refusal | {
  ok: true; noop: boolean; phone: string; previousPhone: string;
  customer: CustomerRecord | null; updateCustomer: boolean;
};

/**
 * Decides what an admin phone correction may touch, before any write.
 * - another lead of a different identity, or another customer, with the same number: conflict;
 * - lead linked unambiguously to its customer (only lead, same number): customer follows;
 * - shared customer or discordant customer number: explicit admin choice required.
 * leadId/customerId and history links never change.
 */
export async function planLeadPhoneCorrection(lead: any, value: unknown, scope: unknown): Promise<PhoneCorrectionPlan> {
  const valid = validateCorrectedPhone(value);
  if (valid.ok === false) return { ok: false, status: 400, body: { error: valid.error } };
  const previousPhone = String(lead.phone || "");
  if (valid.phone === previousPhone) return { ok: true, noop: true, phone: valid.phone, previousPhone, customer: null, updateCustomer: false };

  const otherLeads = (await listLeadsByContact(valid.phone, "")).map(row => row.lead).filter(row => row.id !== lead.id);
  // Earlier opportunities of the same customer may legitimately share the number.
  const foreign = otherLeads.filter(row => !lead.customerId || row.customerId !== lead.customerId);
  if (foreign.length) {
    return { ok: false, status: 409, body: {
      code: "phone_conflict_lead",
      error: `Numero gia usato da ${foreign.length === 1 ? "un altro lead" : `${foreign.length} altri lead`} di un'altra persona. Nessuna modifica salvata e nessuna unione: verifica i record.`,
      conflictLeadIds: foreign.slice(0, 5).map(row => row.id)
    } };
  }
  const otherCustomers = (await listCustomersByPhone(valid.phone)).filter(row => row.id !== lead.customerId);
  if (otherCustomers.length) {
    return { ok: false, status: 409, body: { code: "phone_conflict_customer", error: "Numero gia associato a un'altra scheda cliente. Nessuna modifica salvata e nessuna unione: verifica i record." } };
  }

  const customer = lead.customerId ? await getCustomerById(String(lead.customerId)) : null;
  if (!customer) return { ok: true, noop: false, phone: valid.phone, previousPhone, customer: null, updateCustomer: false };
  const siblings = (await listLeads({ customerId: customer.id })).filter((row: any) => row.id !== lead.id);
  const aligned = !customer.phone || phonesMatch(customer.phone, previousPhone);
  if (!siblings.length && aligned) return { ok: true, noop: false, phone: valid.phone, previousPhone, customer, updateCustomer: true };
  if (scope === "lead_only" || scope === "lead_and_customer") {
    return { ok: true, noop: false, phone: valid.phone, previousPhone, customer, updateCustomer: scope === "lead_and_customer" };
  }
  return { ok: false, status: 409, body: {
    code: "customer_choice_required",
    error: siblings.length
      ? `La scheda cliente e condivisa con ${siblings.length === 1 ? "un'altra pratica" : `altre ${siblings.length} pratiche`}: scegli se aggiornare anche il telefono del cliente.`
      : "Il telefono della scheda cliente e diverso da quello del lead: scegli se aggiornare anche il cliente.",
    impact: { otherLeadCount: siblings.length, customerPhoneDiffers: !aligned, customerPhoneTail: maskPhone(customer.phone) }
  } };
}

export type ContactWriter = {
  /** Conditional writes: return false when the stored value is no longer `expected`. */
  setLeadPhone(leadId: string, expected: string, phone: string, at: string): Promise<boolean>;
  setCustomerPhone(customerId: string, expected: string, phone: string, at: string): Promise<boolean>;
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
export async function applyLeadPhoneCorrection(plan: Extract<PhoneCorrectionPlan, { ok: true }>, leadId: string, activity: any, writer: ContactWriter) {
  const at = new Date().toISOString();
  const customer = plan.updateCustomer ? plan.customer : null;
  const undo: Array<() => Promise<boolean>> = [];
  const rollback = async (cause: string) => {
    for (const step of undo.reverse()) {
      let restored = false;
      try { restored = await step(); } catch { restored = false; }
      if (!restored) {
        console.error(`[lead] phone correction rollback failed lead=${leadId} customer=${customer?.id || "-"} cause=${cause}`);
        throw new ContactCorrectionError(500, `Correzione telefono incompleta: verificare manualmente lead ${leadId}${customer ? ` e cliente ${customer.id}` : ""}.`, true);
      }
    }
  };
  if (customer) {
    if (!await writer.setCustomerPhone(customer.id, customer.phone, plan.phone, at)) throw new ContactCorrectionError(409, "La scheda cliente e stata modificata nel frattempo: ricarica e riprova.");
    undo.push(() => writer.setCustomerPhone(customer.id, plan.phone, customer.phone, at));
  }
  let leadUpdated = false;
  try { leadUpdated = await writer.setLeadPhone(leadId, plan.previousPhone, plan.phone, at); }
  catch { await rollback("lead_write_failed"); throw new ContactCorrectionError(503, "Salvataggio non riuscito: nessuna modifica applicata. Riprova."); }
  if (!leadUpdated) { await rollback("lead_changed"); throw new ContactCorrectionError(409, "Il lead e stato modificato nel frattempo: ricarica e riprova."); }
  undo.push(() => writer.setLeadPhone(leadId, plan.phone, plan.previousPhone, at));
  try { await writer.appendActivity(activity); }
  catch { await rollback("audit_failed"); throw new ContactCorrectionError(503, "Audit non disponibile: nessuna modifica applicata. Riprova."); }
  console.log(`[lead] phone corrected lead=${leadId} customerUpdated=${Boolean(customer)} new=${maskPhone(plan.phone)}`);
}
