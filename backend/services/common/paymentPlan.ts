export class PaymentError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export type PaymentActor = { id: string; username: string; role: string };
export const PAYMENT_IDS = ["payment_deposit", "payment_balance"];
const STATES = ["pending", "received", "verified"];
const own = (o: any, k: string) => Object.prototype.hasOwnProperty.call(o || {}, k);

export function money(value: unknown): number {
  if ((typeof value !== "number" && typeof value !== "string") ||
      (typeof value === "string" && !/^\d+(\.\d{1,2})?$/.test(value.trim()))) {
    throw new PaymentError(400, "Importo non numerico o con piu di due decimali.");
  }
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(Math.round(amount * 100)) || Math.abs(amount * 100 - Math.round(amount * 100)) > 0.000001) {
    throw new PaymentError(400, "Gli importi devono essere finiti, non negativi e in centesimi.");
  }
  return Math.round(amount * 100) / 100;
}

/** Additive read compatibility: explicit historical amounts and unknown legacy rows survive. */
export function normalizePaymentPlan(input: any, defaults: any[]) {
  const rows: any[] = Array.isArray(input?.items) ? input.items : [];
  const now = new Date();
  const items = defaults.map((base) => {
    const old = rows.find(item => item?.id === base.id) || {};
    const amount = Number(old.amount ?? base.amount);
    const status = String(old.status || "pending");
    const receivedAmount = Number(old.receivedAmount ?? (status === "received" || status === "verified" ? amount : 0));
    const verifiedAmount = Number(old.verifiedAmount ?? (status === "verified" ? receivedAmount : 0));
    const due = new Date(now); due.setDate(due.getDate() + base.dueAtOffsetDays); due.setHours(12, 0, 0, 0);
    return { ...old, id: base.id, label: String(old.label || base.label), amount, status,
      receivedAmount, verifiedAmount, dueAt: old.dueAt || due.toISOString(),
      method: String(old.method || ""), note: String(old.note || ""), required: amount > 0 && (old.required !== undefined ? Boolean(old.required) : true) };
  });
  for (const row of rows) if (!PAYMENT_IDS.includes(row?.id)) {
    const receivedAmount = Number(row.receivedAmount ?? (["received", "verified"].includes(row.status) ? row.amount : 0));
    items.push({ ...row, receivedAmount, verifiedAmount: Number(row.verifiedAmount ?? (row.status === "verified" ? receivedAmount : 0)) });
  }
  return { items, version: Number(input?.version || 0), audit: Array.isArray(input?.audit) ? input.audit : [] };
}

export function paymentTotals(plan: any) {
  const cents = (field: string) => plan.items.reduce((sum: number, row: any) => sum + Math.round(Number(row[field] || 0) * 100), 0);
  const total = cents("amount"), paid = cents("receivedAmount");
  return { total: total / 100, paid: paid / 100, remaining: Math.max(0, total - paid) / 100, verified: cents("verifiedAmount") / 100 };
}

export function changePaymentPlan(previous: any, incoming: any, actor: PaymentActor, reason = "", now = new Date().toISOString()) {
  if (!actor?.id || !actor?.username || !["admin", "super_admin", "operatore"].includes(actor.role)) throw new PaymentError(401, "Sessione pagamenti non disponibile.");
  if (!Number.isSafeInteger(previous.version) || previous.version < 0) throw new PaymentError(409, "Versione storica non valida: necessaria verifica amministrativa.");
  if (!incoming || !Array.isArray(incoming.items)) throw new PaymentError(400, "Piano pagamenti non valido.");
  if (previous.items.some((row: any) => !PAYMENT_IDS.includes(row.id))) throw new PaymentError(409, "Piano storico non standard: conservato, modifica importi non disponibile.");
  if (incoming.items.length !== 2 || new Set(incoming.items.map((row: any) => row?.id)).size !== 2 || incoming.items.some((row: any) => !PAYMENT_IDS.includes(row?.id))) throw new PaymentError(400, "Sono previste solo le voci acconto e saldo.");
  const changes: Array<{ field: string; before: unknown; after: unknown }> = [];
  const items = previous.items.map((old: any) => {
    const patch = incoming.items.find((row: any) => row.id === old.id);
    const amount = money(patch.amount);
    const status = String(patch.status || "");
    if (!STATES.includes(status)) throw new PaymentError(400, "Stato pagamento non ammesso.");
    const received = money(old.receivedAmount), verified = money(old.verifiedAmount);
    if (received > 0 || old.status !== "pending") {
      if (amount !== money(old.amount)) throw new PaymentError(409, "Importo bloccato: la rata e gia ricevuta o verificata.");
      if (STATES.indexOf(status) < STATES.indexOf(old.status)) throw new PaymentError(409, "Un incasso registrato richiede una rettifica esplicita; non puo essere riaperto.");
    }
    if (status !== "pending" && amount === 0 && status !== old.status) throw new PaymentError(400, "Una rata a zero non puo essere ricevuta o verificata.");
    // Receipt fields are server-owned. A legacy client may omit them, never supply new money.
    for (const field of ["receivedAmount", "verifiedAmount"]) {
      if (own(patch, field) && money(patch[field]) !== money(old[field]) && !(incoming.version < previous.version && money(patch[field]) <= money(old[field]))) throw new PaymentError(400, "Gli importi incassati sono gestiti dal server.");
    }
    const newlyReceived = old.status === "pending" && status !== "pending";
    const nextReceived = newlyReceived ? amount : received;
    const nextVerified = status === "verified" && old.status !== "verified" ? nextReceived : verified;
    if (nextReceived > amount || nextVerified > nextReceived) throw new PaymentError(409, "Importi storici incoerenti: necessaria verifica amministrativa.");
    if (patch.dueAt && !Number.isFinite(Date.parse(String(patch.dueAt)))) throw new PaymentError(400, "Scadenza non valida.");
    const next = { ...old, amount, status, required: amount > 0, receivedAmount: nextReceived, verifiedAmount: nextVerified,
      dueAt: patch.dueAt || old.dueAt, method: String(patch.method ?? old.method), note: String(patch.note ?? old.note),
      receivedAt: newlyReceived ? now : old.receivedAt,
      verifiedAt: status === "verified" && old.status !== "verified" ? now : old.verifiedAt };
    for (const field of ["amount", "status", "receivedAmount", "verifiedAmount", "dueAt", "method", "note"]) {
      if (next[field] !== old[field]) changes.push({ field: old.id + "." + field, before: old[field] ?? null, after: next[field] ?? null });
    }
    return { ...next, updatedAt: changes.some(change => change.field.startsWith(old.id + ".")) ? now : old.updatedAt };
  });
  const total = money(paymentTotals({ items }).total);
  if (own(incoming, "total") && money(incoming.total) !== total) throw new PaymentError(400, "Totale, acconto e saldo non coerenti.");
  if (total !== paymentTotals(previous).total) changes.unshift({ field: "total", before: paymentTotals(previous).total, after: total });
  if (changes.some(change => change.field.endsWith(".amount")) && !own(incoming, "version")) throw new PaymentError(409, "Ricarica la pratica prima di modificare gli importi.");
  if (own(incoming, "version") && incoming.version !== previous.version && changes.length) throw new PaymentError(409, "Pagamenti aggiornati da un altro operatore. Ricarica la pratica.");
  if (!changes.length) return { plan: previous, changes, changed: false };
  const audit = { at: now, userId: actor.id, username: actor.username, role: actor.role, reason: String(reason || "").trim().slice(0, 1000), changes };
  return { plan: { ...previous, items, version: previous.version + 1, audit: [...previous.audit, audit] }, changes, changed: true };
}

/** Creation cannot fabricate receipts or bypass the plan's numeric constraints. */
export function initializePaymentPlan(input: any, defaults: any[]) {
  const rows = input?.items || [];
  if (!Array.isArray(rows) || new Set(rows.map((row: any) => row?.id)).size !== rows.length) throw new PaymentError(400, "Piano iniziale non valido.");
  for (const row of rows) {
    if (!PAYMENT_IDS.includes(row?.id)) throw new PaymentError(400, "Sono previste solo acconto e saldo.");
    if (row.amount !== undefined) money(row.amount);
    if (row.status && row.status !== "pending") throw new PaymentError(400, "Registra gli incassi dopo la creazione della pratica.");
    if (Number(row.receivedAmount || 0) !== 0 || Number(row.verifiedAmount || 0) !== 0) throw new PaymentError(400, "Incassi iniziali non ammessi.");
  }
  const plan = normalizePaymentPlan({ items: rows.map((row: any) => ({ ...row, receivedAmount: 0, verifiedAmount: 0 })), version: 0, audit: [] }, defaults);
  money(paymentTotals(plan).total);
  if (Object.prototype.hasOwnProperty.call(input || {}, "total") && money(input.total) !== paymentTotals(plan).total) throw new PaymentError(400, "Totale iniziale non coerente.");
  return plan;
}
