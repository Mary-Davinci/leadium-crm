import { LEAD_STATUSES } from "./workflow";

// WhatsApp automation for the Booking lifecycle. Pure and deterministic: no I/O, no clock reads
// (callers pass `now`), so every rule is unit-testable and the same inputs always give the same
// decision. The commercial status stays the source of truth for the deal; this module only reads
// it. The automation state it needs is DERIVED from data that already exists:
//   - template history     -> outbound template messages (wa_messages)
//   - customerRepliedAt    -> conversation.lastInboundAt
// and only what cannot be derived is persisted on the lead:
//   - lead.doNotContact          explicit opt-out (never cleared by an inbound message)
//   - lead.whatsappAutomation    { paused, stoppedAt, stoppedReason }

export type AutomationMode = "manual_only" | "automatic_allowed";
export type SendTrigger = "manual" | "automation";

export type TemplateParameter = {
  name: string;
  label: string;
  // Where Meta expects the value: the numbered body variable ({{index}}) or the dynamic suffix
  // of a URL button (button index `buttonIndex`).
  component: "body" | "button_url";
  index: number;
  buttonIndex?: number;
  kind?: "text" | "url";
  required?: boolean;
  // Lead field used to prefill the value; the operator can always override it.
  source?: "productInterest" | "quoteUrl" | "fullName";
};

export type TemplateDefinition = {
  key: string;
  name: string;
  label: string;
  body: string;
  language?: string;
  metaCategory?: string;
  metaStatus?: string;
  parameters?: TemplateParameter[];
  automationMode?: AutomationMode;
  // Templates sharing a group can be sent at most once per lead (e.g. both the legacy
  // primo_contatto_cliente and lead_first_contact are the lead's single first contact).
  onceGroup?: string;
  // Sent after `after` (same lead, no customer reply since) once `afterHours` have passed.
  sequence?: { after: string; afterHours: number };
  // Sending this template ends the automatic sequence for the lead.
  endsSequence?: boolean;
  // A quote template needs a real quote: its url parameter must resolve to an http(s) URL.
  requiresQuote?: boolean;
  // Commercial statuses this template makes sense in (empty/missing = any open lead).
  eligibleStatuses?: string[];
};

export type SentTemplate = { key: string; sentAt: string; status?: string; trigger?: string };

export type AutomationLead = {
  id?: string;
  status?: string;
  closingOutcome?: string;
  productInterest?: string | null;
  quoteUrl?: string | null;
  fullName?: string | null;
  doNotContact?: { active?: boolean; reason?: string; setAt?: string; setBy?: string } | null;
  whatsappAutomation?: { paused?: boolean; stoppedAt?: string | null; stoppedReason?: string | null } | null;
};

export type AutomationContext = {
  lead: AutomationLead;
  conversation?: { lastInboundAt?: string | null } | null;
  sent: SentTemplate[];
  templates: TemplateDefinition[];
  now: Date;
  // Global kill switch (env WHATSAPP_AUTOMATION_ENABLED): false = nothing is ever sent automatically.
  automationEnabled: boolean;
};

export const SOLD_STATUSES = new Set<string>([
  LEAD_STATUSES.INSTALLMENT_SALE,
  LEAD_STATUSES.FIRST_DEPOSIT,
  LEAD_STATUSES.SECOND_DEPOSIT,
  LEAD_STATUSES.BALANCE_DUE,
  LEAD_STATUSES.ONE_SHOT_SALE,
  LEAD_STATUSES.SOLD,
  LEAD_STATUSES.GADGET_SENT,
  LEAD_STATUSES.TICKETS_SENT,
  LEAD_STATUSES.READY_TO_CLOSE,
  LEAD_STATUSES.CLOSED_FULL
]);

const CLOSED_LOST_STATUSES = new Set<string>([LEAD_STATUSES.NOT_INTERESTED, LEAD_STATUSES.LOST, LEAD_STATUSES.FLOW_CANCELLED]);

export const STOP_REASON_LABELS: Record<string, string> = {
  opt_out: "Il cliente ha chiesto di non essere contattato",
  paused: "Automazione in pausa",
  sold: "Prenotazione/vendita conclusa",
  not_interested: "Cliente non interessato o pratica chiusa",
  customer_replied: "Il cliente ha risposto: gestione manuale",
  sequence_closed: "Sequenza conclusa con il messaggio di chiusura",
  manual_stop: "Automazione fermata dall'operatore"
};

function toMs(value?: string | null) {
  const ms = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

// A failed send never counts as "sent": Meta did not deliver it, so it may be retried.
function deliveredSends(sent: SentTemplate[]) {
  return sent.filter((item) => String(item.status || "sent") !== "failed");
}

export function findTemplate(templates: TemplateDefinition[], key: string) {
  return templates.find((item) => item.key === key) || templates.find((item) => item.name === key) || null;
}

function lastSendOf(sent: SentTemplate[], keys: string[]) {
  return deliveredSends(sent)
    .filter((item) => keys.includes(item.key))
    .sort((a, b) => toMs(b.sentAt) - toMs(a.sentAt))[0] || null;
}

function groupKeys(templates: TemplateDefinition[], group?: string) {
  return group ? templates.filter((item) => item.onceGroup === group).map((item) => item.key) : [];
}

export function isOptedOut(lead: AutomationLead) {
  return Boolean(lead.doNotContact && lead.doNotContact.active);
}

/** Commercial reason the lead is out of the WhatsApp flow, or null when it is open. */
export function getCommercialStopReason(lead: AutomationLead): string | null {
  const status = String(lead.status || "");
  const outcome = String(lead.closingOutcome || "open");
  if (outcome === "won" || SOLD_STATUSES.has(status)) return "sold";
  if (outcome === "lost" || outcome === "disqualified" || CLOSED_LOST_STATUSES.has(status)) return "not_interested";
  return null;
}

/**
 * Why automatic follow-ups must not run for this lead (first match wins), or null. Order is the
 * order of precedence shown to operators: an explicit opt-out outranks everything else.
 */
export function getSequenceStopReason(ctx: AutomationContext): string | null {
  const { lead, conversation, sent, templates } = ctx;
  if (isOptedOut(lead)) return "opt_out";
  if (lead.whatsappAutomation?.stoppedAt) return lead.whatsappAutomation.stoppedReason || "manual_stop";
  if (lead.whatsappAutomation?.paused) return "paused";
  const commercial = getCommercialStopReason(lead);
  if (commercial) return commercial;
  const closing = templates.filter((item) => item.endsSequence).map((item) => item.key);
  if (lastSendOf(sent, closing)) return "sequence_closed";
  const firstContact = lastSendOf(sent, groupKeys(templates, "first_contact"));
  const repliedAt = toMs(conversation?.lastInboundAt);
  if (firstContact && repliedAt && repliedAt > toMs(firstContact.sentAt)) return "customer_replied";
  return null;
}

/** The derived automation state exposed to the UI (nothing here is stored twice). */
export function deriveAutomationState(ctx: AutomationContext) {
  const delivered = deliveredSends(ctx.sent).sort((a, b) => toMs(a.sentAt) - toMs(b.sentAt));
  const firstContact = lastSendOf(ctx.sent, groupKeys(ctx.templates, "first_contact"));
  const sequenceKeys = new Set(ctx.templates.filter((item) => item.sequence).map((item) => item.key));
  const last = delivered[delivered.length - 1] || null;
  const stopReason = getSequenceStopReason(ctx);
  return {
    firstContactSentAt: firstContact ? firstContact.sentAt : null,
    lastTemplateKey: last ? last.key : null,
    lastTemplateSentAt: last ? last.sentAt : null,
    followupStep: delivered.filter((item) => sequenceKeys.has(item.key)).length,
    customerRepliedAt: ctx.conversation?.lastInboundAt || null,
    paused: Boolean(ctx.lead.whatsappAutomation?.paused),
    stoppedAt: ctx.lead.whatsappAutomation?.stoppedAt || null,
    stoppedReason: stopReason,
    stoppedReasonLabel: stopReason ? STOP_REASON_LABELS[stopReason] || stopReason : null,
    doNotContact: isOptedOut(ctx.lead) ? ctx.lead.doNotContact : null,
    automationEnabled: ctx.automationEnabled
  };
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** Resolves every template variable from operator overrides first, then the lead. */
export function resolveTemplateParameters(template: TemplateDefinition, lead: AutomationLead, overrides: Record<string, unknown> = {}) {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  const invalid: string[] = [];
  for (const param of template.parameters || []) {
    const override = overrides[param.name];
    const fromLead = param.source ? (lead as Record<string, unknown>)[param.source] : "";
    const value = String((override !== undefined && override !== null && String(override).trim() ? override : fromLead) ?? "").trim();
    if (!value) {
      if (param.required !== false) missing.push(param.name);
      continue;
    }
    if (param.kind === "url" && !isHttpUrl(value)) {
      invalid.push(param.name);
      continue;
    }
    values[param.name] = value;
  }
  return { values, missing, invalid };
}

/** Cloud API `template.components` for the resolved values (empty for templates without variables). */
export function buildTemplateComponents(template: TemplateDefinition, values: Record<string, string>) {
  const params = (template.parameters || []).filter((param) => values[param.name] !== undefined);
  const components: any[] = [];
  const bodyParams = params.filter((param) => param.component === "body").sort((a, b) => a.index - b.index);
  if (bodyParams.length) {
    components.push({ type: "body", parameters: bodyParams.map((param) => ({ type: "text", text: values[param.name] })) });
  }
  for (const param of params.filter((item) => item.component === "button_url")) {
    components.push({
      type: "button",
      sub_type: "url",
      index: String(param.buttonIndex ?? 0),
      parameters: [{ type: "text", text: values[param.name] }]
    });
  }
  return components;
}

/** Body text with {{n}} replaced, used as the message text stored in the CRM thread. */
export function renderTemplateBody(template: TemplateDefinition, values: Record<string, string>) {
  let text = String(template.body || "");
  for (const param of template.parameters || []) {
    if (param.component !== "body" || values[param.name] === undefined) continue;
    text = text.split(`{{${param.index}}}`).join(values[param.name]);
  }
  return text;
}

export type SendCheck = { allowed: boolean; code?: string; reason?: string };

/**
 * The single gate every template send goes through, manual or automatic. Manual sends are the
 * operator's call (only hard rules apply); automatic sends must also pass every sequence rule.
 */
export function checkTemplateSend(ctx: AutomationContext, templateKey: string, trigger: SendTrigger, overrides: Record<string, unknown> = {}): SendCheck & { values?: Record<string, string> } {
  const template = findTemplate(ctx.templates, templateKey);
  if (!template) return { allowed: false, code: "unknown_template", reason: "Template WhatsApp non configurato." };
  if (isOptedOut(ctx.lead)) {
    return { allowed: false, code: "opt_out", reason: "Il cliente ha chiesto di non essere contattato: nessun template puo essere inviato." };
  }
  const once = groupKeys(ctx.templates, template.onceGroup);
  if (once.length && lastSendOf(ctx.sent, once)) {
    return { allowed: false, code: "already_sent", reason: `"${template.label}" e gia stato inviato a questo cliente: si invia una sola volta.` };
  }
  const resolved = resolveTemplateParameters(template, ctx.lead, overrides);
  if (template.requiresQuote && (resolved.missing.length || resolved.invalid.length)) {
    return { allowed: false, code: "quote_missing", reason: "Serve il link del preventivo (http/https) per inviare questo template." };
  }
  if (resolved.missing.length) {
    return { allowed: false, code: "missing_parameters", reason: `Compila i campi del template: ${resolved.missing.join(", ")}.` };
  }
  if (resolved.invalid.length) {
    return { allowed: false, code: "invalid_parameters", reason: `Valore non valido per: ${resolved.invalid.join(", ")}.` };
  }
  if (trigger === "automation") {
    if (!ctx.automationEnabled) return { allowed: false, code: "automation_disabled", reason: "Automazioni WhatsApp disattivate." };
    if ((template.automationMode || "manual_only") !== "automatic_allowed") {
      return { allowed: false, code: "manual_only", reason: "Template abilitato solo per l'invio manuale." };
    }
    const stop = getSequenceStopReason(ctx);
    if (stop) return { allowed: false, code: stop, reason: STOP_REASON_LABELS[stop] || stop };
    if (template.eligibleStatuses?.length && !template.eligibleStatuses.includes(String(ctx.lead.status || ""))) {
      return { allowed: false, code: "status_not_eligible", reason: "Stato della pratica non compatibile con questo template." };
    }
  }
  return { allowed: true, values: resolved.values };
}

function hoursSince(from: string, now: Date) {
  return (now.getTime() - toMs(from)) / 3_600_000;
}

/**
 * Next template the automatic sequence would send now, or null. Deterministic: walks the
 * configured sequence (each step names its predecessor and delay) and returns the first step
 * whose predecessor was sent, that was not sent itself, whose delay elapsed and that passes
 * checkTemplateSend(automation). Never returns more than one template per evaluation.
 */
export function nextAutomaticTemplate(ctx: AutomationContext): { key: string } | null {
  if (!ctx.automationEnabled || getSequenceStopReason(ctx)) return null;
  const firstContactKeys = groupKeys(ctx.templates, "first_contact");
  const candidates: string[] = [];
  if (!lastSendOf(ctx.sent, firstContactKeys)) {
    const first = ctx.templates.find((item) => item.onceGroup === "first_contact" && item.automationMode === "automatic_allowed");
    if (first) candidates.push(first.key);
  }
  for (const template of ctx.templates) {
    if (!template.sequence) continue;
    if (lastSendOf(ctx.sent, [template.key])) continue;
    const predecessor = lastSendOf(ctx.sent, [template.sequence.after]);
    if (!predecessor || hoursSince(predecessor.sentAt, ctx.now) < template.sequence.afterHours) continue;
    // A reply after the predecessor means the customer is engaged: no automatic nudge.
    if (toMs(ctx.conversation?.lastInboundAt) > toMs(predecessor.sentAt)) continue;
    candidates.push(template.key);
  }
  for (const key of candidates) {
    if (checkTemplateSend(ctx, key, "automation").allowed) return { key };
  }
  return null;
}

/**
 * Operator suggestions: what makes sense to send now, most relevant first. Never aggressive:
 * nothing for an opted-out lead, no follow-ups once the customer replied or the deal is closed.
 */
export function suggestTemplates(ctx: AutomationContext, latestCallOutcome?: string | null): Array<{ key: string; reason: string }> {
  if (isOptedOut(ctx.lead)) return [];
  const suggestions: Array<{ key: string; reason: string }> = [];
  const add = (key: string, reason: string) => {
    if (!findTemplate(ctx.templates, key) || suggestions.some((item) => item.key === key)) return;
    const check = checkTemplateSend(ctx, key, "manual");
    if (check.allowed || check.code === "missing_parameters" || check.code === "quote_missing") suggestions.push({ key, reason });
  };
  const stop = getSequenceStopReason(ctx);
  const status = String(ctx.lead.status || "");
  if (stop === "sold" || stop === "not_interested") return suggestions;
  const firstContactSent = lastSendOf(ctx.sent, groupKeys(ctx.templates, "first_contact"));
  if (!firstContactSent) add("lead_first_contact", "Primo contatto non ancora inviato.");
  if (status === LEAD_STATUSES.NO_ANSWER || latestCallOutcome === "no_answer") add("call_no_answer", "Ultima chiamata senza risposta.");
  if (ctx.lead.quoteUrl && !lastSendOf(ctx.sent, ["quote_ready"])) add("quote_ready", "Preventivo pronto da inviare.");
  if (status === LEAD_STATUSES.OUT_OF_BUDGET) add("budget_alternative", "Cliente fuori budget: proporre un'alternativa.");
  if (stop === "customer_replied") {
    if (status === LEAD_STATUSES.TO_CONTACT || status === LEAD_STATUSES.INTERESTED) add("lead_qualification", "Il cliente ha risposto: raccogliere le preferenze.");
    return suggestions;
  }
  if (stop) return suggestions;
  if (status === LEAD_STATUSES.INTERESTED) add("interested_undecided", "Cliente interessato ma indeciso.");
  for (const template of ctx.templates) {
    if (!template.sequence || lastSendOf(ctx.sent, [template.key])) continue;
    const predecessor = lastSendOf(ctx.sent, [template.sequence.after]);
    if (predecessor && hoursSince(predecessor.sentAt, ctx.now) >= template.sequence.afterHours) {
      add(template.key, "Nessuna risposta dal cliente dopo il messaggio precedente.");
    }
  }
  return suggestions;
}
