import "../../loadEnv";
import http from "http";
import { applyStatusAutomation, createActivity } from "../common/automation";
import { syncLeadToMetaCrm } from "../common/metaCrmSync";
import { LEAD_STATUSES, isValidTransition } from "../common/workflow";
import {
  appendActivities,
  createLead,
  findLeadByContact,
  findLeadByExternalOrPhone,
  getLeadById,
  getTimelineByLeadId,
  listLeads,
  newId,
  normalizeEmail,
  normalizePhone,
  saveLead
} from "../common/leadStore";
import { createCallLog, findCallLogByIdempotencyKey, getLatestCallMapByLeadIds, listCallLogs, listCallLogsByLeadId } from "../common/callStore";
import { createTask, findRecentManualDuplicate, getTaskById, listTasks, listTasksByLeadAndKind, saveTask, TaskRecord } from "../common/taskStore";

const HOST = "0.0.0.0";
const PORT = Number(process.env.LEAD_SERVICE_PORT || 4301);
const WORKFLOW_URL = process.env.WORKFLOW_SERVICE_URL || "http://localhost:4302";
const SLA_FIRST_CONTACT_MINUTES = Number(process.env.SLA_FIRST_CONTACT_MINUTES || 5);
const SLA_TASK_INTERVAL_MS = Number(process.env.SLA_TASK_INTERVAL_MS || 60_000);
const AUTOMATIC_TASK_KINDS = [
  "next_action",
  "sla_first_contact",
  "callback_overdue",
  "document_checklist",
  "payment_checklist",
  "post_sale_gadget",
  "post_sale_tickets"
] as const;
type AutomaticTaskKind = (typeof AUTOMATIC_TASK_KINDS)[number];

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function parseBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(new Error("Body too large"));
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function routeMatch(pathname: string, pattern: string) {
  const pathSegments = pathname.split("/").filter(Boolean);
  const patternSegments = pattern.split("/").filter(Boolean);
  if (pathSegments.length !== patternSegments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternSegments.length; i += 1) {
    const current = patternSegments[i];
    const value = pathSegments[i];
    if (current.startsWith(":")) params[current.slice(1)] = decodeURIComponent(value);
    else if (current !== value) return null;
  }
  return params;
}

const CONTACT_ACTIVITY_TYPES = new Set(["call", "whatsapp_opened", "whatsapp_received", "whatsapp_sent"]);

function cleanOptionalString(value: unknown) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function normalizeSourcePlatform(value: unknown, sourceHint = "") {
  const normalized = String(value || sourceHint || "")
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  if (normalized.includes("instagram")) return "instagram";
  if (normalized.includes("facebook")) return "facebook";
  if (normalized.includes("meta")) return "meta";
  return normalized;
}

function extractLeadSourceFields(body: any, sourceHint = "") {
  return {
    sourceLeadId: cleanOptionalString(body?.sourceLeadId),
    sourcePlatform: normalizeSourcePlatform(body?.sourcePlatform, sourceHint),
    sourceCampaignId: cleanOptionalString(body?.sourceCampaignId),
    sourceFormId: cleanOptionalString(body?.sourceFormId)
  };
}

function applyLeadSourceFields(lead: any, nextFields: ReturnType<typeof extractLeadSourceFields>, overwrite = false) {
  let changed = false;
  for (const [key, value] of Object.entries(nextFields)) {
    if (overwrite) {
      if ((lead[key] ?? null) !== value) {
        lead[key] = value;
        changed = true;
      }
      continue;
    }
    if (value !== null && !lead[key]) {
      lead[key] = value;
      changed = true;
    }
  }
  return changed;
}

function markLeadContacted(lead: any, at: string) {
  lead.lastContactAt = at;
  if (!lead.firstContactAt) lead.firstContactAt = at;
  syncLeadSlaState(lead);
}

function syncLeadAssignmentState(lead: any, previousAssignedTo: string, assignedAt: string) {
  const nextAssignedTo = String(lead.assignedTo || "").trim();
  if (!nextAssignedTo) return;
  if (!previousAssignedTo || previousAssignedTo !== nextAssignedTo || !lead.assignedAt) {
    lead.assignedAt = assignedAt;
  }
}

function getLeadSlaDueAt(lead: any) {
  if (lead?.firstContactAt) return null;
  if (!isToContactStatus(String(lead?.status || ""))) return null;
  const baseline = String(lead?.assignedAt || lead?.createdAt || "").trim();
  const baselineTs = baseline ? new Date(baseline).getTime() : 0;
  if (!Number.isFinite(baselineTs) || baselineTs <= 0) return null;
  return new Date(baselineTs + SLA_FIRST_CONTACT_MINUTES * 60_000).toISOString();
}

function syncLeadSlaState(lead: any) {
  lead.slaDueAt = getLeadSlaDueAt(lead);
}

function getFallbackLossReason(status: string) {
  switch (status) {
    case LEAD_STATUSES.NOT_INTERESTED:
      return "non_interessato";
    case LEAD_STATUSES.OUT_OF_BUDGET:
      return "fuori_budget";
    case LEAD_STATUSES.LOST:
      return "persa_generica";
    default:
      return null;
  }
}

function isDisqualifiedStatus(status: string) {
  return ([LEAD_STATUSES.NOT_INTERESTED, LEAD_STATUSES.OUT_OF_BUDGET] as string[]).includes(status);
}

function requiresExplicitLossReason(status: string) {
  return status === LEAD_STATUSES.LOST;
}

function deriveClosingOutcome(status: string) {
  if (([LEAD_STATUSES.SOLD, LEAD_STATUSES.GADGET_SENT, LEAD_STATUSES.TICKETS_SENT, LEAD_STATUSES.READY_TO_CLOSE, LEAD_STATUSES.CLOSED_FULL] as string[]).includes(status)) {
    return "won";
  }
  if (status === LEAD_STATUSES.LOST) return "lost";
  if (isDisqualifiedStatus(status)) return "disqualified";
  return "open";
}

function syncLeadClosureState(lead: any, lossReason?: unknown, lossDetail?: unknown) {
  lead.closingOutcome = deriveClosingOutcome(String(lead.status || ""));
  if (lead.closingOutcome === "lost" || lead.closingOutcome === "disqualified") {
    if (lossReason !== undefined) {
      lead.lossReason = cleanOptionalString(lossReason);
    } else if (!lead.lossReason) {
      lead.lossReason = getFallbackLossReason(String(lead.status || ""));
    }
    if (lossDetail !== undefined) {
      lead.lossDetail = cleanOptionalString(lossDetail);
    }
    return;
  }
  lead.lossReason = null;
  lead.lossDetail = null;
}

function assertLossReasonForStatus(status: string, lossReason?: unknown) {
  if (!requiresExplicitLossReason(status)) return null;
  if (cleanOptionalString(lossReason)) return null;
  return 'Motivo perdita obbligatorio per lo stato "Persa".';
}

function isPostSaleStatus(status: string) {
  return ([LEAD_STATUSES.SOLD, LEAD_STATUSES.GADGET_SENT, LEAD_STATUSES.TICKETS_SENT, LEAD_STATUSES.READY_TO_CLOSE, LEAD_STATUSES.CLOSED_FULL] as string[]).includes(
    status
  );
}

function hasReachedPostSaleStep(status: string, kind: "post_sale_gadget" | "post_sale_tickets") {
  if (kind === "post_sale_gadget") {
    return ([LEAD_STATUSES.GADGET_SENT, LEAD_STATUSES.TICKETS_SENT, LEAD_STATUSES.READY_TO_CLOSE, LEAD_STATUSES.CLOSED_FULL] as string[]).includes(status);
  }
  return ([LEAD_STATUSES.TICKETS_SENT, LEAD_STATUSES.READY_TO_CLOSE, LEAD_STATUSES.CLOSED_FULL] as string[]).includes(status);
}

async function syncPostSaleTask(
  lead: any,
  kind: "post_sale_gadget" | "post_sale_tickets",
  title: string,
  openDescription: string,
  doneDescription: string,
  dedupedBy: string
) {
  const tasks = await listTasksByLeadAndKind(lead.id, kind);
  const task = tasks[0] || null;
  const shouldTrack = isPostSaleStatus(String(lead.status || ""));
  const shouldBeDone = !shouldTrack || hasReachedPostSaleStep(String(lead.status || ""), kind);
  const expectedStatus: TaskRecord["status"] = shouldBeDone ? "done" : "open";
  const expectedDescription = shouldBeDone ? doneDescription : openDescription;
  const expectedDueAt = shouldBeDone ? task?.dueAt || getEndOfTodayIso() : getEndOfTodayIso();
  const expectedPriority = shouldBeDone ? 35 : 58;
  const expectedMeta = {
    ...(task?.meta || {}),
    status: lead.status,
    phone: lead.phone || "",
    step: kind === "post_sale_gadget" ? "gadget" : "tickets"
  };

  if (!task) {
    if (!shouldTrack && shouldBeDone) return;
    await createTask({
      leadId: lead.id,
      assignedTo: lead.assignedTo || "",
      kind,
      title,
      description: expectedDescription,
      source: "automation",
      status: expectedStatus,
      priority: expectedPriority,
      dueAt: expectedDueAt,
      meta: expectedMeta
    });
    return;
  }

  const hasChanged =
    task.assignedTo !== (lead.assignedTo || "") ||
    task.title !== title ||
    task.description !== expectedDescription ||
    task.source !== "automation" ||
    task.status !== expectedStatus ||
    task.priority !== expectedPriority ||
    task.dueAt !== expectedDueAt ||
    JSON.stringify(task.meta || {}) !== JSON.stringify(expectedMeta);

  if (hasChanged) {
    task.assignedTo = lead.assignedTo || "";
    task.title = title;
    task.description = expectedDescription;
    task.source = "automation";
    task.status = expectedStatus;
    task.priority = expectedPriority;
    task.dueAt = expectedDueAt;
    task.meta = expectedMeta;
    task.updatedAt = new Date().toISOString();
    await saveTask(task);
  }

  await dismissDuplicateTasks(tasks, kind, dedupedBy);
}

async function syncPostSaleTasks(lead: any, dedupedBy = "post_sale_sync") {
  await syncPostSaleTask(
    lead,
    "post_sale_gadget",
    `Invio gadget: ${lead.fullName || lead.phone || "lead"}`,
    "Inviare il gadget post-vendita al cliente.",
    "Task gadget completato o non piu richiesto nello stato attuale.",
    dedupedBy
  );
  await syncPostSaleTask(
    lead,
    "post_sale_tickets",
    `Invio biglietti: ${lead.fullName || lead.phone || "lead"}`,
    "Inviare i biglietti o i documenti finali di viaggio al cliente.",
    "Task biglietti completato o non piu richiesto nello stato attuale.",
    dedupedBy
  );
}

async function persistMetaSyncIfChanged(lead: any, result: { changed?: boolean } | null | undefined) {
  if (!lead || !result?.changed) return;
  lead.updatedAt = new Date().toISOString();
  await saveLead(lead);
}

const DETAIL_TIMELINE_LIMIT = 40;
const DETAIL_CALL_LOG_LIMIT = 20;

function compactLeadDocumentsForResponse(documents: any, options?: { stripAttachmentDataUrls?: boolean }) {
  if (!documents || !Array.isArray(documents.items)) return documents || { items: [] };
  if (!options?.stripAttachmentDataUrls) return documents;
  return {
    ...documents,
    items: documents.items.map((item: any) => ({
      ...item,
      attachments: Array.isArray(item?.attachments)
        ? item.attachments.map((attachment: any) => ({
            ...attachment,
            dataUrl: attachment?.storageKey ? "" : String(attachment?.dataUrl || "")
          }))
        : []
    }))
  };
}

function safeLead(lead: any, options?: { stripAttachmentDataUrls?: boolean }) {
  return {
    id: lead.id,
    fullName: lead.fullName,
    phone: lead.phone,
    email: lead.email,
    source: lead.source,
    budget: lead.budget,
    assignedTo: lead.assignedTo,
    status: lead.status,
    notes: lead.notes,
    sourceLeadId: lead.sourceLeadId || null,
    sourcePlatform: lead.sourcePlatform || null,
    sourceCampaignId: lead.sourceCampaignId || null,
    sourceFormId: lead.sourceFormId || null,
    assignedAt: lead.assignedAt || null,
    firstContactAt: lead.firstContactAt || null,
    lastContactAt: lead.lastContactAt || null,
    slaDueAt: lead.slaDueAt || null,
    closingOutcome: lead.closingOutcome || "open",
    lossReason: lead.lossReason || null,
    lossDetail: lead.lossDetail || null,
    metaEventSync: lead.metaEventSync || null,
    documents: compactLeadDocumentsForResponse(lead.documents, options),
    payments: lead.payments || { items: [] },
    latestCallOutcome: lead.latestCallOutcome || null,
    latestCallAt: lead.latestCallAt || null,
    callAttempts: lead.callAttempts || 0,
    nextActionAt: lead.nextActionAt || null,
    createdAt: lead.createdAt,
    updatedAt: lead.updatedAt
  };
}

const DEFAULT_DOCUMENT_ITEMS = [
  { key: "identity_document", label: "Documento identitÃ  / Passaporto" },
  { key: "passenger_data", label: "Dati passeggeri" },
  { key: "signed_contract", label: "Contratto firmato" },
  { key: "deposit_payment", label: "Conferma pagamento acconto" }
];

const DEFAULT_PAYMENT_ITEMS = [
  { id: "payment_deposit", label: "Acconto", amount: 300, dueAtOffsetDays: 0 },
  { id: "payment_balance", label: "Saldo", amount: 900, dueAtOffsetDays: 30 }
];

export function normalizePracticeDocuments(input: any) {
  const byKey = new Map<string, any>();
  const rows = Array.isArray(input?.items) ? input.items : [];
  rows.forEach((item: any) => {
    const key = String(item?.key || "").trim();
    if (!key) return;
    byKey.set(key, item);
  });

  return {
    items: DEFAULT_DOCUMENT_ITEMS.map((base) => {
      const existing = byKey.get(base.key) || {};
      return {
        key: base.key,
        label: String(existing.label || base.label),
        required: existing.required !== undefined ? Boolean(existing.required) : true,
        received: Boolean(existing.received),
        verified: Boolean(existing.verified),
        note: String(existing.note || ""),
        updatedAt: existing.updatedAt ? String(existing.updatedAt) : undefined,
        attachments: Array.isArray(existing.attachments)
          ? existing.attachments.map((attachment: any) => ({
              id: String(attachment?.id || newId("doc")),
              name: String(attachment?.name || "documento"),
              mimeType: String(attachment?.mimeType || ""),
              size: Number(attachment?.size || 0),
              dataUrl: String(attachment?.dataUrl || ""),
              storageKey: String(attachment?.storageKey || ""),
              storageProvider: String(attachment?.storageProvider || ""),
              uploadedAt: attachment?.uploadedAt ? String(attachment.uploadedAt) : new Date().toISOString()
            }))
          : []
      };
    })
  };
}

export function getMissingDocuments(lead: any) {
  const documents = normalizePracticeDocuments(lead?.documents);
  return documents.items.filter((item) => item.required && (!item.received || !item.verified));
}

export function normalizePracticePayments(input: any) {
  const byId = new Map<string, any>();
  const rows = Array.isArray(input?.items) ? input.items : [];
  rows.forEach((item: any) => {
    const id = String(item?.id || "").trim();
    if (!id) return;
    byId.set(id, item);
  });

  const now = new Date();

  return {
    items: DEFAULT_PAYMENT_ITEMS.map((base) => {
      const existing = byId.get(base.id) || {};
      const dueAtFallback = new Date(now);
      dueAtFallback.setDate(dueAtFallback.getDate() + base.dueAtOffsetDays);
      dueAtFallback.setHours(12, 0, 0, 0);
      return {
        id: base.id,
        label: String(existing.label || base.label),
        amount: Number(existing.amount ?? base.amount),
        status: String(existing.status || "pending"),
        dueAt: existing.dueAt ? String(existing.dueAt) : dueAtFallback.toISOString(),
        receivedAt: existing.receivedAt ? String(existing.receivedAt) : undefined,
        verifiedAt: existing.verifiedAt ? String(existing.verifiedAt) : undefined,
        method: String(existing.method || ""),
        note: String(existing.note || ""),
        required: existing.required !== undefined ? Boolean(existing.required) : true,
        updatedAt: existing.updatedAt ? String(existing.updatedAt) : undefined
      };
    })
  };
}

export function getPendingPayments(lead: any) {
  const payments = normalizePracticePayments(lead?.payments);
  return payments.items.filter((item) => item.required && item.status !== "verified");
}

export async function syncDocumentChecklistTask(lead: any) {
  const missingDocuments = getMissingDocuments(lead);
  const documentTasks = await listTasksByLeadAndKind(lead.id, "document_checklist");
  const documentTask = documentTasks[0] || null;

  if (missingDocuments.length) {
    const missingLabels = missingDocuments.map((item) => item.label).join(", ");
    const expectedMeta = {
      ...(documentTask?.meta || {}),
      missingKeys: missingDocuments.map((item) => item.key),
      missingCount: missingDocuments.length,
      status: lead.status,
      phone: lead.phone || ""
    };
    const expectedTitle = `Documenti mancanti: ${lead.fullName || lead.phone || "lead"}`;
    const expectedDescription = `Documenti da ricevere o verificare: ${missingLabels}.`;
    const expectedDueAt = getEndOfTodayIso();

    if (!documentTask) {
      await createTask({
        leadId: lead.id,
        assignedTo: lead.assignedTo || "",
        kind: "document_checklist",
        title: expectedTitle,
        description: expectedDescription,
        source: "automation",
        status: "open",
        priority: 85,
        dueAt: expectedDueAt,
        meta: expectedMeta
      });
    } else {
      const hasChanged =
        documentTask.assignedTo !== (lead.assignedTo || "") ||
        documentTask.dueAt !== expectedDueAt ||
        documentTask.priority !== 85 ||
        documentTask.title !== expectedTitle ||
        documentTask.description !== expectedDescription ||
        documentTask.source !== "automation" ||
        documentTask.status !== "open" ||
        JSON.stringify(documentTask.meta || {}) !== JSON.stringify(expectedMeta);
      if (hasChanged) {
        documentTask.assignedTo = lead.assignedTo || "";
        documentTask.dueAt = expectedDueAt;
        documentTask.priority = 85;
        documentTask.title = expectedTitle;
        documentTask.description = expectedDescription;
        documentTask.source = "automation";
        documentTask.status = "open";
        documentTask.meta = expectedMeta;
        documentTask.updatedAt = new Date().toISOString();
        await saveTask(documentTask);
      }
    }
  } else if (documentTask && documentTask.status !== "done") {
    documentTask.status = "done";
    documentTask.updatedAt = new Date().toISOString();
    await saveTask(documentTask);
  }

  await dismissDuplicateTasks(documentTasks, "document_checklist", "documents_sync");
}

export async function syncPaymentChecklistTask(lead: any) {
  const pendingPayments = getPendingPayments(lead);
  const paymentTasks = await listTasksByLeadAndKind(lead.id, "payment_checklist");
  const paymentTask = paymentTasks[0] || null;

  if (pendingPayments.length) {
    const totalPending = pendingPayments.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const pendingLabels = pendingPayments.map((item) => item.label).join(", ");
    const expectedMeta = {
      ...(paymentTask?.meta || {}),
      pendingIds: pendingPayments.map((item) => item.id),
      pendingCount: pendingPayments.length,
      pendingAmount: totalPending,
      status: lead.status,
      phone: lead.phone || ""
    };
    const expectedTitle = `Pagamenti in sospeso: ${lead.fullName || lead.phone || "lead"}`;
    const expectedDescription = `Pagamenti da ricevere o verificare: ${pendingLabels}. Totale residuo €${totalPending}.`;
    const expectedDueAtMs = pendingPayments
      .map((item) => (item.dueAt ? new Date(item.dueAt).getTime() : Number.MAX_SAFE_INTEGER))
      .sort((a, b) => a - b)[0];
    const expectedDueAt = Number.isFinite(expectedDueAtMs) ? new Date(expectedDueAtMs).toISOString() : getEndOfTodayIso();

    if (!paymentTask) {
      await createTask({
        leadId: lead.id,
        assignedTo: lead.assignedTo || "",
        kind: "payment_checklist",
        title: expectedTitle,
        description: expectedDescription,
        source: "automation",
        status: "open",
        priority: 88,
        dueAt: expectedDueAt,
        meta: expectedMeta
      });
    } else {
      const hasChanged =
        paymentTask.assignedTo !== (lead.assignedTo || "") ||
        paymentTask.dueAt !== expectedDueAt ||
        paymentTask.priority !== 88 ||
        paymentTask.title !== expectedTitle ||
        paymentTask.description !== expectedDescription ||
        paymentTask.source !== "automation" ||
        paymentTask.status !== "open" ||
        JSON.stringify(paymentTask.meta || {}) !== JSON.stringify(expectedMeta);
      if (hasChanged) {
        paymentTask.assignedTo = lead.assignedTo || "";
        paymentTask.dueAt = expectedDueAt;
        paymentTask.priority = 88;
        paymentTask.title = expectedTitle;
        paymentTask.description = expectedDescription;
        paymentTask.source = "automation";
        paymentTask.status = "open";
        paymentTask.meta = expectedMeta;
        paymentTask.updatedAt = new Date().toISOString();
        await saveTask(paymentTask);
      }
    }
  } else if (paymentTask && paymentTask.status !== "done") {
    paymentTask.status = "done";
    paymentTask.updatedAt = new Date().toISOString();
    await saveTask(paymentTask);
  }

  await dismissDuplicateTasks(paymentTasks, "payment_checklist", "payments_sync");
}
export function getEndOfTodayIso() {
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 18, 0, 0, 0);
  return end.toISOString();
}

function appendNote(existing: string, extra: string) {
  const base = String(existing || "").trim();
  const tail = String(extra || "").trim();
  if (!tail) return base;
  if (!base) return tail;
  return `${base}\n${tail}`;
}

function isMissing(value: any) {
  return value === undefined || value === null || String(value).trim() === "";
}

async function validateTransition(fromStatus: string, toStatus: string) {
  try {
    const res = await fetch(
      `${WORKFLOW_URL}/internal/validate-transition?from=${encodeURIComponent(fromStatus || "")}&to=${encodeURIComponent(
        toStatus || ""
      )}`
    );
    if (res.ok) return Boolean((await res.json()).valid);
  } catch {}
  return isValidTransition(fromStatus, toStatus);
}

function isToContactStatus(status: string) {
  return String(status || "").toLowerCase().includes("contattare");
}

export function getAutomaticTaskKey(leadId: string, kind: AutomaticTaskKind) {
  return `${leadId}::${kind}`;
}

export function buildAutomaticTaskGroups(tasks: TaskRecord[]) {
  const groups = new Map<string, TaskRecord[]>();
  tasks
    .filter((task) => task.leadId && AUTOMATIC_TASK_KINDS.includes(task.kind as AutomaticTaskKind))
    .forEach((task) => {
      const key = getAutomaticTaskKey(String(task.leadId), task.kind as AutomaticTaskKind);
      const current = groups.get(key) || [];
      current.push(task);
      groups.set(key, current);
    });
  groups.forEach((rows) =>
    rows.sort((a, b) => {
      const aTime = new Date(a.updatedAt || a.createdAt).getTime();
      const bTime = new Date(b.updatedAt || b.createdAt).getTime();
      return bTime - aTime;
    })
  );
  return groups;
}

export async function dismissDuplicateTasks(tasks: TaskRecord[], kind: AutomaticTaskKind, dedupedBy: string) {
  for (const duplicate of tasks.slice(1)) {
    if (duplicate.status !== "dismissed") {
      duplicate.status = "dismissed";
      duplicate.updatedAt = new Date().toISOString();
      duplicate.meta = { ...(duplicate.meta || {}), duplicateOfKind: kind, dedupedBy };
      await saveTask(duplicate);
    }
  }
}

function sortTasksByPriorityAndDate(a: TaskRecord, b: TaskRecord) {
  const statusWeight = (task: TaskRecord) => (task.status === "open" ? 0 : task.status === "done" ? 1 : 2);
  const statusDiff = statusWeight(a) - statusWeight(b);
  if (statusDiff !== 0) return statusDiff;
  if ((b.priority || 0) !== (a.priority || 0)) return (b.priority || 0) - (a.priority || 0);
  const aTime = new Date(a.dueAt || a.updatedAt || a.createdAt).getTime();
  const bTime = new Date(b.dueAt || b.updatedAt || b.createdAt).getTime();
  return aTime - bTime;
}

function getBoardTaskKey(task: TaskRecord) {
  const source = String(task.source || "").toLocaleLowerCase("it");
  const isAutomatic = source === "automation" || source === "scheduler" || AUTOMATIC_TASK_KINDS.includes(task.kind as AutomaticTaskKind);
  if (isAutomatic && task.leadId) return `automatic::${task.status}::${task.leadId}::${task.kind}`;

  const title = String(task.title || "").trim().toLocaleLowerCase("it");
  const assignedTo = String(task.assignedTo || "").trim().toLocaleLowerCase("it");
  if (task.status === "open" && task.leadId && title) return `open::${task.leadId}::${task.kind}::${title}::${assignedTo}`;
  return `id::${task.id}`;
}

function getCompactBoardTasks(tasks: TaskRecord[]) {
  const groups = new Map<string, TaskRecord[]>();
  tasks.forEach((task) => {
    const key = getBoardTaskKey(task);
    const bucket = groups.get(key) || [];
    bucket.push(task);
    groups.set(key, bucket);
  });

  return Array.from(groups.values())
    .map((items) => [...items].sort(sortTasksByPriorityAndDate)[0])
    .filter(Boolean)
    .sort(sortTasksByPriorityAndDate);
}

function getBoardLeadSummary(lead: any) {
  return {
    id: String(lead.id || ""),
    fullName: String(lead.fullName || ""),
    phone: String(lead.phone || ""),
    email: String(lead.email || ""),
    source: String(lead.source || ""),
    assignedTo: String(lead.assignedTo || ""),
    status: String(lead.status || ""),
    notes: String(lead.notes || ""),
    nextActionAt: lead.nextActionAt || null,
    assignedAt: lead.assignedAt || null,
    firstContactAt: lead.firstContactAt || null,
    lastContactAt: lead.lastContactAt || null,
    slaDueAt: lead.slaDueAt || null,
    closingOutcome: lead.closingOutcome || "open",
    lossReason: lead.lossReason || null,
    lossDetail: lead.lossDetail || null,
    documentsMissingCount: getMissingDocumentsSummaryCount(lead),
    updatedAt: String(lead.updatedAt || ""),
    createdAt: String(lead.createdAt || "")
  };
}

function getMissingDocumentsSummaryCount(lead: any) {
  const items = Array.isArray(lead?.documents?.items) ? lead.documents.items : [];
  return items.filter((item: any) => item?.required && (!item?.received || !item?.verified)).length;
}

function getPendingPaymentsSummaryCount(lead: any) {
  const items = Array.isArray(lead?.payments?.items) ? lead.payments.items : [];
  return items.filter((item: any) => item?.required && item?.status !== "verified").length;
}

function getLeadListSummary(lead: any) {
  return {
    id: lead.id,
    fullName: lead.fullName,
    phone: lead.phone,
    email: lead.email,
    source: lead.source,
    budget: lead.budget,
    assignedTo: lead.assignedTo,
    status: lead.status,
    notes: lead.notes,
    sourceLeadId: lead.sourceLeadId || null,
    sourcePlatform: lead.sourcePlatform || null,
    sourceCampaignId: lead.sourceCampaignId || null,
    sourceFormId: lead.sourceFormId || null,
    assignedAt: lead.assignedAt || null,
    firstContactAt: lead.firstContactAt || null,
    lastContactAt: lead.lastContactAt || null,
    slaDueAt: lead.slaDueAt || null,
    closingOutcome: lead.closingOutcome || "open",
    lossReason: lead.lossReason || null,
    lossDetail: lead.lossDetail || null,
    latestCallOutcome: lead.latestCallOutcome || null,
    latestCallAt: lead.latestCallAt || null,
    callAttempts: lead.callAttempts || 0,
    nextActionAt: lead.nextActionAt || null,
    documentsMissingCount: getMissingDocumentsSummaryCount(lead),
    pendingPaymentsCount: getPendingPaymentsSummaryCount(lead),
    createdAt: lead.createdAt,
    updatedAt: lead.updatedAt
  };
}

function getLeadContactKey(lead: any) {
  const phone = normalizePhone(String(lead?.phone || ""));
  if (phone) return `phone::${phone}`;
  const email = normalizeEmail(String(lead?.email || ""));
  if (email) return `email::${email}`;
  return `id::${String(lead?.id || "")}`;
}

function getLeadRank(lead: any) {
  let score = 0;
  if (lead?.status && !String(lead.status).toLowerCase().includes("pers")) score += 20;
  if (lead?.nextActionAt) score += 8;
  if (lead?.assignedTo) score += 4;
  if (String(lead?.notes || "").trim()) score += 2;
  const missingDocs = getMissingDocuments(lead).length;
  const pendingPayments = getPendingPayments(lead).length;
  score += missingDocs + pendingPayments;
  return score;
}

function compactLeadsByContact(leads: any[]) {
  const groups = new Map<string, any[]>();
  leads.forEach((lead) => {
    const key = getLeadContactKey(lead);
    const bucket = groups.get(key) || [];
    bucket.push(lead);
    groups.set(key, bucket);
  });

  return Array.from(groups.values())
    .map((items) =>
      [...items].sort((a, b) => {
        const rankDiff = getLeadRank(b) - getLeadRank(a);
        if (rankDiff !== 0) return rankDiff;
        return new Date(b.updatedAt || b.createdAt || 0).getTime() - new Date(a.updatedAt || a.createdAt || 0).getTime();
      })[0]
    )
    .filter(Boolean)
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0).getTime() - new Date(a.updatedAt || a.createdAt || 0).getTime());
}

function getStatusFromCallDisposition(disposition: string) {
  const normalized = String(disposition || "").toLowerCase();
  if (normalized === "no_answer") return LEAD_STATUSES.NO_ANSWER;
  if (normalized === "call_back") return LEAD_STATUSES.CALLBACK_AGREED;
  if (normalized === "interested") return LEAD_STATUSES.INTERESTED;
  if (normalized === "not_interested") return LEAD_STATUSES.NOT_INTERESTED;
  return "";
}

export async function ensureSlaTasks() {
  const [rows, allTasks] = await Promise.all([listLeads(), listTasks({ includeDismissed: true })]);
  const automaticTaskGroups = buildAutomaticTaskGroups(allTasks);
  const now = Date.now();
  for (const lead of rows) {
    const nextActionTasks = automaticTaskGroups.get(getAutomaticTaskKey(lead.id, "next_action")) || [];
    const nextActionTask = nextActionTasks[0] || null;
    if (lead.nextActionAt) {
      const nextActionPriority = new Date(lead.nextActionAt).getTime() < now ? 90 : 65;
      const nextActionTitle = `Prossima azione: ${lead.fullName || lead.phone || "lead"}`;
      const nextActionDescription = lead.notes
        ? `Task derivato dalla prossima azione della pratica. ${String(lead.notes).trim()}`
        : "Task derivato dalla prossima azione della pratica.";
      if (!nextActionTask) {
        await createTask({
          leadId: lead.id,
          assignedTo: lead.assignedTo || "",
          kind: "next_action",
          title: nextActionTitle,
          description: nextActionDescription,
          source: "automation",
          status: "open",
          priority: nextActionPriority,
          dueAt: lead.nextActionAt,
          meta: { status: lead.status, phone: lead.phone || "", derivedFrom: "nextActionAt" }
        });
      } else {
        const nextDueAt = lead.nextActionAt || null;
        const nextAssignedTo = lead.assignedTo || "";
        const nextMeta = { ...(nextActionTask.meta || {}), status: lead.status, phone: lead.phone || "", derivedFrom: "nextActionAt" };
        const hasChanged =
          nextActionTask.dueAt !== nextDueAt ||
          nextActionTask.assignedTo !== nextAssignedTo ||
          nextActionTask.priority !== nextActionPriority ||
          nextActionTask.title !== nextActionTitle ||
          nextActionTask.description !== nextActionDescription ||
          nextActionTask.source !== "automation" ||
          nextActionTask.status !== "open" ||
          JSON.stringify(nextActionTask.meta || {}) !== JSON.stringify(nextMeta);
        if (hasChanged) {
          nextActionTask.dueAt = nextDueAt;
          nextActionTask.assignedTo = nextAssignedTo;
          nextActionTask.priority = nextActionPriority;
          nextActionTask.title = nextActionTitle;
          nextActionTask.description = nextActionDescription;
          nextActionTask.source = "automation";
          nextActionTask.status = "open";
          nextActionTask.meta = nextMeta;
          nextActionTask.updatedAt = new Date().toISOString();
          await saveTask(nextActionTask);
        }
      }
      await dismissDuplicateTasks(nextActionTasks, "next_action", "scheduler");
    } else if (nextActionTask) {
      if (nextActionTask.status !== "done") {
        nextActionTask.status = "done";
        nextActionTask.updatedAt = new Date().toISOString();
        await saveTask(nextActionTask);
      }
    }

    const firstContactDeadline = lead.slaDueAt || getLeadSlaDueAt(lead);
    const createdAtTs = new Date(firstContactDeadline || "").getTime();
    const firstContactExpired =
      !lead.firstContactAt &&
      isToContactStatus(lead.status) &&
      Number.isFinite(createdAtTs) &&
      createdAtTs < now;
    const firstContactTasks = automaticTaskGroups.get(getAutomaticTaskKey(lead.id, "sla_first_contact")) || [];
    const firstContactTask = firstContactTasks[0] || null;
    if (firstContactExpired && !firstContactTask) {
      await createTask({
        leadId: lead.id,
        assignedTo: lead.assignedTo || "",
        kind: "sla_first_contact",
        title: `SLA superata: contattare ${lead.fullName || lead.phone || "lead"}`,
        description: `Lead oltre ${SLA_FIRST_CONTACT_MINUTES} minuti senza primo contatto.`,
        source: "scheduler",
        status: "open",
        priority: 95,
        dueAt: firstContactDeadline,
        meta: { status: lead.status, phone: lead.phone || "", assignedAt: lead.assignedAt || null }
      });
    } else if (firstContactExpired && firstContactTask) {
      const expectedDueAt = firstContactDeadline;
      const expectedMeta = { ...(firstContactTask.meta || {}), status: lead.status, phone: lead.phone || "", assignedAt: lead.assignedAt || null };
      const hasChanged =
        firstContactTask.assignedTo !== (lead.assignedTo || "") ||
        firstContactTask.dueAt !== expectedDueAt ||
        firstContactTask.priority !== 95 ||
        firstContactTask.title !== `SLA superata: contattare ${lead.fullName || lead.phone || "lead"}` ||
        firstContactTask.description !== `Lead oltre ${SLA_FIRST_CONTACT_MINUTES} minuti senza primo contatto.` ||
        firstContactTask.source !== "scheduler" ||
        firstContactTask.status !== "open" ||
        JSON.stringify(firstContactTask.meta || {}) !== JSON.stringify(expectedMeta);
      if (hasChanged) {
        firstContactTask.assignedTo = lead.assignedTo || "";
        firstContactTask.dueAt = expectedDueAt;
        firstContactTask.priority = 95;
        firstContactTask.title = `SLA superata: contattare ${lead.fullName || lead.phone || "lead"}`;
        firstContactTask.description = `Lead oltre ${SLA_FIRST_CONTACT_MINUTES} minuti senza primo contatto.`;
        firstContactTask.source = "scheduler";
        firstContactTask.status = "open";
        firstContactTask.meta = expectedMeta;
        firstContactTask.updatedAt = new Date().toISOString();
        await saveTask(firstContactTask);
      }
    }
    if (!firstContactExpired && firstContactTask) {
      if (firstContactTask.status !== "done") {
        firstContactTask.status = "done";
        firstContactTask.updatedAt = new Date().toISOString();
        await saveTask(firstContactTask);
      }
    }
    await dismissDuplicateTasks(firstContactTasks, "sla_first_contact", "scheduler");

    const callbackOverdue = lead.nextActionAt && new Date(lead.nextActionAt).getTime() < now;
    const callbackTasks = automaticTaskGroups.get(getAutomaticTaskKey(lead.id, "callback_overdue")) || [];
    const callbackTask = callbackTasks[0] || null;
    if (callbackOverdue && !callbackTask) {
      await createTask({
        leadId: lead.id,
        assignedTo: lead.assignedTo || "",
        kind: "callback_overdue",
        title: `Richiamo scaduto: ${lead.fullName || lead.phone || "lead"}`,
        description: "Richiamo pianificato oltre la scadenza.",
        source: "scheduler",
        status: "open",
        priority: 100,
        dueAt: lead.nextActionAt,
        meta: { status: lead.status, phone: lead.phone || "" }
      });
    } else if (callbackOverdue && callbackTask) {
      const expectedMeta = { ...(callbackTask.meta || {}), status: lead.status, phone: lead.phone || "" };
      const hasChanged =
        callbackTask.assignedTo !== (lead.assignedTo || "") ||
        callbackTask.dueAt !== (lead.nextActionAt || null) ||
        callbackTask.priority !== 100 ||
        callbackTask.title !== `Richiamo scaduto: ${lead.fullName || lead.phone || "lead"}` ||
        callbackTask.description !== "Richiamo pianificato oltre la scadenza." ||
        callbackTask.source !== "scheduler" ||
        callbackTask.status !== "open" ||
        JSON.stringify(callbackTask.meta || {}) !== JSON.stringify(expectedMeta);
      if (hasChanged) {
        callbackTask.assignedTo = lead.assignedTo || "";
        callbackTask.dueAt = lead.nextActionAt || null;
        callbackTask.priority = 100;
        callbackTask.title = `Richiamo scaduto: ${lead.fullName || lead.phone || "lead"}`;
        callbackTask.description = "Richiamo pianificato oltre la scadenza.";
        callbackTask.source = "scheduler";
        callbackTask.status = "open";
        callbackTask.meta = expectedMeta;
        callbackTask.updatedAt = new Date().toISOString();
        await saveTask(callbackTask);
      }
    }
    if (!callbackOverdue && callbackTask) {
      if (callbackTask.status !== "done") {
        callbackTask.status = "done";
        callbackTask.updatedAt = new Date().toISOString();
        await saveTask(callbackTask);
      }
    }
    await dismissDuplicateTasks(callbackTasks, "callback_overdue", "scheduler");

    const missingDocuments = getMissingDocuments(lead);
    const documentTasks = automaticTaskGroups.get(getAutomaticTaskKey(lead.id, "document_checklist")) || [];
    const documentTask = documentTasks[0] || null;
    if (missingDocuments.length) {
      const missingLabels = missingDocuments.map((item) => item.label).join(", ");
      const expectedMeta = {
        ...(documentTask?.meta || {}),
        missingKeys: missingDocuments.map((item) => item.key),
        missingCount: missingDocuments.length,
        status: lead.status,
        phone: lead.phone || ""
      };
      const expectedTitle = `Documenti mancanti: ${lead.fullName || lead.phone || "lead"}`;
      const expectedDescription = `Documenti da ricevere o verificare: ${missingLabels}.`;
      const expectedDueAt = getEndOfTodayIso();
      if (!documentTask) {
        await createTask({
          leadId: lead.id,
          assignedTo: lead.assignedTo || "",
          kind: "document_checklist",
          title: expectedTitle,
          description: expectedDescription,
          source: "automation",
          status: "open",
          priority: 85,
          dueAt: expectedDueAt,
          meta: expectedMeta
        });
      } else {
        const hasChanged =
          documentTask.assignedTo !== (lead.assignedTo || "") ||
          documentTask.dueAt !== expectedDueAt ||
          documentTask.priority !== 85 ||
          documentTask.title !== expectedTitle ||
          documentTask.description !== expectedDescription ||
          documentTask.source !== "automation" ||
          documentTask.status !== "open" ||
          JSON.stringify(documentTask.meta || {}) !== JSON.stringify(expectedMeta);
        if (hasChanged) {
          documentTask.assignedTo = lead.assignedTo || "";
          documentTask.dueAt = expectedDueAt;
          documentTask.priority = 85;
          documentTask.title = expectedTitle;
          documentTask.description = expectedDescription;
          documentTask.source = "automation";
          documentTask.status = "open";
          documentTask.meta = expectedMeta;
          documentTask.updatedAt = new Date().toISOString();
          await saveTask(documentTask);
        }
      }
    } else if (documentTask) {
      if (documentTask.status !== "done") {
        documentTask.status = "done";
        documentTask.updatedAt = new Date().toISOString();
        await saveTask(documentTask);
      }
    }
    await dismissDuplicateTasks(documentTasks, "document_checklist", "scheduler");

    const pendingPayments = getPendingPayments(lead);
    const paymentTasks = automaticTaskGroups.get(getAutomaticTaskKey(lead.id, "payment_checklist")) || [];
    const paymentTask = paymentTasks[0] || null;
    if (pendingPayments.length) {
      const totalPending = pendingPayments.reduce((sum, item) => sum + Number(item.amount || 0), 0);
      const pendingLabels = pendingPayments.map((item) => item.label).join(", ");
      const expectedMeta = {
        ...(paymentTask?.meta || {}),
        pendingIds: pendingPayments.map((item) => item.id),
        pendingCount: pendingPayments.length,
        pendingAmount: totalPending,
        status: lead.status,
        phone: lead.phone || ""
      };
      const expectedTitle = `Pagamenti in sospeso: ${lead.fullName || lead.phone || "lead"}`;
      const expectedDescription = `Pagamenti da ricevere o verificare: ${pendingLabels}. Totale residuo €${totalPending}.`;
      const expectedDueAtMs = pendingPayments
        .map((item) => (item.dueAt ? new Date(item.dueAt).getTime() : Number.MAX_SAFE_INTEGER))
        .sort((a, b) => a - b)[0];
      const expectedDueAt = Number.isFinite(expectedDueAtMs) ? new Date(expectedDueAtMs).toISOString() : getEndOfTodayIso();
      if (!paymentTask) {
        await createTask({
          leadId: lead.id,
          assignedTo: lead.assignedTo || "",
          kind: "payment_checklist",
          title: expectedTitle,
          description: expectedDescription,
          source: "automation",
          status: "open",
          priority: 88,
          dueAt: expectedDueAt,
          meta: expectedMeta
        });
      } else {
        const hasChanged =
          paymentTask.assignedTo !== (lead.assignedTo || "") ||
          paymentTask.dueAt !== expectedDueAt ||
          paymentTask.priority !== 88 ||
          paymentTask.title !== expectedTitle ||
          paymentTask.description !== expectedDescription ||
          paymentTask.source !== "automation" ||
          paymentTask.status !== "open" ||
          JSON.stringify(paymentTask.meta || {}) !== JSON.stringify(expectedMeta);
        if (hasChanged) {
          paymentTask.assignedTo = lead.assignedTo || "";
          paymentTask.dueAt = expectedDueAt;
          paymentTask.priority = 88;
          paymentTask.title = expectedTitle;
          paymentTask.description = expectedDescription;
          paymentTask.source = "automation";
          paymentTask.status = "open";
          paymentTask.meta = expectedMeta;
          paymentTask.updatedAt = new Date().toISOString();
          await saveTask(paymentTask);
        }
      }
    }
    if (!pendingPayments.length && paymentTask) {
      if (paymentTask.status !== "done") {
        paymentTask.status = "done";
        paymentTask.updatedAt = new Date().toISOString();
        await saveTask(paymentTask);
      }
    }
    await dismissDuplicateTasks(paymentTasks, "payment_checklist", "scheduler");
    await syncPostSaleTasks(lead, "scheduler");
  }
}

export async function cleanupLegacyAutomaticTaskDuplicates() {
  const allTasks = await listTasks({ includeDismissed: true });
  const automaticTaskGroups = buildAutomaticTaskGroups(allTasks);
  for (const kind of AUTOMATIC_TASK_KINDS) {
    for (const [key, tasks] of automaticTaskGroups.entries()) {
      if (key.endsWith(`::${kind}`)) {
        await dismissDuplicateTasks(tasks, kind, "startup_cleanup");
      }
    }
  }
}

async function handleCallEvent(body: any) {
  const externalId = body.externalLeadId ? String(body.externalLeadId) : null;
  const incomingNumber = body.from ? String(body.from) : "";
  const lead = await findLeadByExternalOrPhone(externalId, incomingNumber);
  if (!lead) return { ok: true, matched: false };

  const eventType = body.eventType || "call_event";
  const disposition = body.disposition || "completed";
  lead.updatedAt = new Date().toISOString();
  markLeadContacted(lead, lead.updatedAt);
  const activities = [
    createActivity({
      leadId: lead.id,
      type: "3cx_event",
      text: `Evento 3CX: ${eventType} (${disposition}).`,
      actor: "3cx",
      meta: { callId: body.callId || "", durationSeconds: body.durationSeconds || 0, from: body.from || "", to: body.to || "" }
    })
  ];
  if (disposition === "no_answer") {
    const valid = await validateTransition(lead.status, LEAD_STATUSES.NO_ANSWER);
    if (valid) {
      lead.status = LEAD_STATUSES.NO_ANSWER;
      activities.push(...applyStatusAutomation(lead, LEAD_STATUSES.NO_ANSWER, "3cx"));
    }
  }
  await saveLead(lead);
  await appendActivities(activities);
  return { ok: true, matched: true, leadId: lead.id };
}

export const server = http.createServer(async (req, res) => {
  try {
    const method = req.method || "GET";
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const pathname = decodeURIComponent(url.pathname);
    const query = Object.fromEntries(url.searchParams.entries()) as Record<string, string>;

    if (method === "GET" && pathname === "/health") return sendJson(res, 200, { ok: true, service: "lead-service" });
      if (method === "GET" && pathname === "/leads") {
        const rows = compactLeadsByContact(await listLeads(query));
        const callMap = await getLatestCallMapByLeadIds(rows.map((lead: any) => String(lead.id || "")));
        const isSummaryView = String(query.view || "").toLowerCase() === "summary";
        return sendJson(
          res,
          200,
          rows.map((lead: any) =>
            (isSummaryView ? getLeadListSummary : safeLead)({
              ...lead,
              latestCallOutcome: callMap.get(String(lead.id || ""))?.outcome || null,
              latestCallAt: callMap.get(String(lead.id || ""))?.startedAt || null
            })
          )
        );
      }
    if (method === "GET" && pathname === "/tasks/board") {
      const [tasksRows, leadsRows] = await Promise.all([listTasks({ status: query.status, leadId: query.leadId }), listLeads()]);
      return sendJson(res, 200, {
        tasks: getCompactBoardTasks(tasksRows),
        leads: compactLeadsByContact(leadsRows).map(getBoardLeadSummary)
      });
    }

    if (method === "GET" && pathname === "/calls") {
      const [callRows, leadsRows] = await Promise.all([listCallLogs(Number(query.limit || 200)), listLeads()]);
      const leadById = new Map(leadsRows.map((lead: any) => [String(lead.id || ""), lead]));
      return sendJson(
        res,
        200,
        callRows.map((call) => {
          const lead = leadById.get(String(call.leadId || "")) as any;
          return {
            ...call,
            lead: lead
              ? {
                  id: lead.id,
                  fullName: lead.fullName || "",
                  phone: lead.phone || "",
                  email: lead.email || "",
                  status: lead.status || "",
                  assignedTo: lead.assignedTo || "",
                  source: lead.source || ""
                }
              : null
          };
        })
      );
    }

    if (method === "GET" && pathname === "/tasks") {
      const rows = await listTasks({ status: query.status, leadId: query.leadId });
      return sendJson(res, 200, rows);
    }

    if (method === "POST" && pathname === "/leads") {
      const body = await parseBody(req);
      if (!body.fullName || !body.phone) return sendJson(res, 400, { error: "fullName e phone sono obbligatori." });
      const existing = await findLeadByContact(String(body.phone || ""), String(body.email || ""));
      if (existing) {
        const now = new Date().toISOString();
        let changed = false;
        if (!isMissing(body.fullName) && isMissing(existing.fullName)) {
          existing.fullName = String(body.fullName).trim();
          changed = true;
        }
        if (!isMissing(body.phone) && isMissing(existing.phone)) {
          existing.phone = String(body.phone).trim();
          changed = true;
        }
        if (!isMissing(body.email) && isMissing(existing.email)) {
          existing.email = String(body.email).trim();
          changed = true;
        }
        if (!isMissing(body.source) && isMissing(existing.source)) {
          existing.source = String(body.source).trim();
          changed = true;
        }
        if (!isMissing(body.assignedTo) && isMissing(existing.assignedTo)) {
          existing.assignedTo = String(body.assignedTo).trim();
          syncLeadAssignmentState(existing, "", now);
          syncLeadSlaState(existing);
          changed = true;
        }
        if (applyLeadSourceFields(existing, extractLeadSourceFields(body, body.source ? String(body.source) : ""), false)) {
          changed = true;
        }
        const mergedNotes = appendNote(existing.notes || "", String(body.notes || ""));
        if (mergedNotes !== (existing.notes || "")) {
          existing.notes = mergedNotes;
          changed = true;
        }
        existing.updatedAt = now;
        existing.lastContactAt = existing.lastContactAt || null;
        await saveLead(existing);
        const metaSync = await syncLeadToMetaCrm(existing, { stage: "initial", eventTime: existing.createdAt || now });
        await persistMetaSyncIfChanged(existing, metaSync);
        if (changed) {
          await appendActivities([
            createActivity({
              leadId: existing.id,
              type: "lead_deduplicated",
              text: "Nuovo inserimento unito a lead esistente (deduplica).",
              actor: body.actor || "system"
            })
          ]);
        }
        return sendJson(res, 200, { mode: "deduplicated", lead: safeLead(existing) });
      }
      const now = new Date().toISOString();
      const assignedTo = body.assignedTo ? String(body.assignedTo).trim() : "";
      const sourceFields = extractLeadSourceFields(body, body.source ? String(body.source) : "");
      const lead = {
        id: newId("lead"),
        fullName: String(body.fullName).trim(),
        phone: String(body.phone).trim(),
        email: body.email ? String(body.email).trim() : "",
        source: body.source ? String(body.source).trim() : "manuale",
        budget: body.budget || "",
        assignedTo,
        status: LEAD_STATUSES.TO_CONTACT,
        notes: body.notes || "",
        ...sourceFields,
        assignedAt: assignedTo ? now : null,
        firstContactAt: null,
        lastContactAt: null,
        slaDueAt: null,
        closingOutcome: "open",
        lossReason: null,
        lossDetail: null,
        documents: normalizePracticeDocuments(body.documents),
        payments: normalizePracticePayments(body.payments),
        callAttempts: 0,
        nextActionAt: null,
        createdAt: now,
        updatedAt: now
      };
      syncLeadSlaState(lead);
      await createLead(lead, [createActivity({ leadId: lead.id, type: "lead_created", text: "Lead creato.", actor: body.actor || "system" })]);
      await syncDocumentChecklistTask(lead);
      await syncPaymentChecklistTask(lead);
      const metaSync = await syncLeadToMetaCrm(lead, { stage: "initial", eventTime: lead.createdAt || now });
      await persistMetaSyncIfChanged(lead, metaSync);
      return sendJson(res, 201, safeLead(lead));
    }

    if (method === "POST" && pathname === "/internal/ingest") {
      const body = await parseBody(req);
      const source = String(body.source || "ingest").trim();
      const fullName = String(body.fullName || "").trim();
      const phone = String(body.phone || "").trim();
      const email = String(body.email || "").trim();
      if (!fullName && !phone && !email) return sendJson(res, 400, { error: "Payload ingest privo di identificativi utili." });
      const existing = await findLeadByContact(phone, email);
      const actor = source;
      const now = new Date().toISOString();
      const sourceFields = extractLeadSourceFields(body, source);
      if (existing) {
        if (fullName && !existing.fullName) existing.fullName = fullName;
        if (phone && !existing.phone) existing.phone = phone;
        if (email && !existing.email) existing.email = email;
        applyLeadSourceFields(existing, sourceFields, false);
        existing.notes = appendNote(existing.notes, body.notes);
        existing.updatedAt = now;
        await saveLead(existing);
        const metaSync = await syncLeadToMetaCrm(existing, { stage: "initial", eventTime: existing.createdAt || now });
        await persistMetaSyncIfChanged(existing, metaSync);
        await appendActivities([
          createActivity({
            leadId: existing.id,
            type: "lead_ingested",
            text: `Lead aggiornato da sorgente ${source}.`,
            actor,
            meta: { source, raw: body.raw || null }
          })
        ]);
        return sendJson(res, 200, { mode: "updated", lead: safeLead(existing) });
      }
      const lead = {
        id: newId("lead"),
        fullName: fullName || `Lead ${source}`,
        phone: phone || "",
        email: email || "",
        source,
        budget: body.budget || "",
        assignedTo: body.assignedTo || "",
        status: LEAD_STATUSES.TO_CONTACT,
        notes: body.notes || "",
        ...sourceFields,
        assignedAt: body.assignedTo ? now : null,
        firstContactAt: null,
        lastContactAt: null,
        slaDueAt: null,
        closingOutcome: "open",
        lossReason: null,
        lossDetail: null,
        documents: normalizePracticeDocuments(body.documents),
        payments: normalizePracticePayments(body.payments),
        callAttempts: 0,
        nextActionAt: null,
        createdAt: now,
        updatedAt: now
      };
      syncLeadSlaState(lead);
      await createLead(lead, [
        createActivity({ leadId: lead.id, type: "lead_created", text: "Lead creato.", actor }),
        createActivity({
          leadId: lead.id,
          type: "lead_ingested",
          text: `Lead acquisito da sorgente ${source}.`,
          actor,
          meta: { source, raw: body.raw || null }
        })
      ]);
      await syncDocumentChecklistTask(lead);
      await syncPaymentChecklistTask(lead);
      const metaSync = await syncLeadToMetaCrm(lead, { stage: "initial", eventTime: lead.createdAt || now });
      await persistMetaSyncIfChanged(lead, metaSync);
      return sendJson(res, 201, { mode: "created", lead: safeLead(lead) });
    }

    if (method === "POST" && pathname === "/tasks") {
      const body = await parseBody(req);
      if (!body.title || !body.kind) return sendJson(res, 400, { error: "title e kind sono obbligatori." });
      const taskInput = {
        leadId: body.leadId ? String(body.leadId) : undefined,
        assignedTo: body.assignedTo ? String(body.assignedTo) : "",
        kind: String(body.kind),
        title: String(body.title),
        description: body.description ? String(body.description) : "",
        source: body.source ? String(body.source) : "manual",
        status: body.status === "done" || body.status === "dismissed" ? body.status : "open",
        priority: Number(body.priority || 50),
        dueAt: body.dueAt ? String(body.dueAt) : null,
        meta: body.meta || null
      } as const;

      const isManualLikeSource = !["automation", "scheduler"].includes(String(taskInput.source || "").toLowerCase());
      if (isManualLikeSource) {
        const duplicate = await findRecentManualDuplicate({
          leadId: taskInput.leadId,
          kind: taskInput.kind,
          title: taskInput.title,
          dueAt: taskInput.dueAt,
          assignedTo: taskInput.assignedTo,
          windowMs: 30 * 24 * 60 * 60 * 1000,
          exactDueAt: false
        });
        if (duplicate) {
          let changed = false;
          if ((taskInput.priority || 0) > (duplicate.priority || 0)) {
            duplicate.priority = taskInput.priority;
            changed = true;
          }
          if (!duplicate.dueAt && taskInput.dueAt) {
            duplicate.dueAt = taskInput.dueAt;
            changed = true;
          }
          if (!duplicate.description && taskInput.description) {
            duplicate.description = taskInput.description;
            changed = true;
          }
          if (changed) {
            duplicate.updatedAt = new Date().toISOString();
            await saveTask(duplicate);
          }
          return sendJson(res, 200, duplicate);
        }
      }

      const task = await createTask(taskInput);
      return sendJson(res, 201, task);
    }

    const leadNoteParams = routeMatch(pathname, "/leads/:leadId/notes");
    if (leadNoteParams && method === "POST") {
      const body = await parseBody(req);
      const lead = await getLeadById(leadNoteParams.leadId);
      if (!lead) return sendJson(res, 404, { error: "Lead non trovato." });
      const noteText = String(body.text || body.note || "").trim();
      if (!noteText) return sendJson(res, 400, { error: "Testo nota obbligatorio." });
      lead.notes = appendNote(String(lead.notes || ""), noteText);
      lead.updatedAt = new Date().toISOString();
      await saveLead(lead);
      await appendActivities([
        createActivity({
          leadId: lead.id,
          type: "note_added",
          text: noteText,
          actor: body.actor || "system"
        })
      ]);
      return sendJson(res, 201, safeLead(lead));
    }

    const leadActivityParams = routeMatch(pathname, "/leads/:leadId/activities");
    if (leadActivityParams && method === "POST") {
      const body = await parseBody(req);
      const lead = await getLeadById(leadActivityParams.leadId);
      if (!lead) return sendJson(res, 404, { error: "Lead non trovato." });
      const type = String(body.type || "").trim();
      const text = String(body.text || "").trim();
      if (!type || !text) return sendJson(res, 400, { error: "type e text sono obbligatori." });
      if (CONTACT_ACTIVITY_TYPES.has(type)) {
        lead.updatedAt = new Date().toISOString();
        markLeadContacted(lead, lead.updatedAt);
        await saveLead(lead);
      }
      await appendActivities([
        createActivity({
          leadId: lead.id,
          type,
          text,
          actor: body.actor || "system",
          meta: body.meta && typeof body.meta === "object" ? body.meta : {}
        })
      ]);
      return sendJson(res, 201, { ok: true });
    }

    const leadByIdParams = routeMatch(pathname, "/leads/:leadId");
    if (leadByIdParams && method === "GET") {
      const lead = await getLeadById(leadByIdParams.leadId);
      if (!lead) return sendJson(res, 404, { error: "Lead non trovato." });
      const [timeline, callLogs] = await Promise.all([getTimelineByLeadId(lead.id), listCallLogsByLeadId(lead.id)]);
      const compactTimeline = Array.isArray(timeline) ? timeline.slice(-DETAIL_TIMELINE_LIMIT) : [];
      const compactCallLogs = Array.isArray(callLogs) ? callLogs.slice(0, DETAIL_CALL_LOG_LIMIT) : [];
      return sendJson(res, 200, {
        lead: safeLead({
          ...lead,
          latestCallOutcome: compactCallLogs[0]?.outcome || null,
          latestCallAt: compactCallLogs[0]?.startedAt || null
        }, { stripAttachmentDataUrls: true }),
        timeline: compactTimeline,
        callLogs: compactCallLogs
      });
    }

    if (leadByIdParams && method === "PATCH") {
      const body = await parseBody(req);
      const lead = await getLeadById(leadByIdParams.leadId);
      if (!lead) return sendJson(res, 404, { error: "Lead non trovato." });
      const previousAssignedTo = String(lead.assignedTo || "").trim();
      const previousNotes = String(lead.notes || "");
      for (const key of ["fullName", "phone", "email", "source", "budget", "assignedTo", "notes"]) {
        if (Object.prototype.hasOwnProperty.call(body, key)) lead[key] = body[key];
      }
      if (Object.prototype.hasOwnProperty.call(body, "sourceLeadId")) lead.sourceLeadId = cleanOptionalString(body.sourceLeadId);
      if (Object.prototype.hasOwnProperty.call(body, "sourcePlatform")) lead.sourcePlatform = normalizeSourcePlatform(body.sourcePlatform);
      if (Object.prototype.hasOwnProperty.call(body, "sourceCampaignId")) lead.sourceCampaignId = cleanOptionalString(body.sourceCampaignId);
      if (Object.prototype.hasOwnProperty.call(body, "sourceFormId")) lead.sourceFormId = cleanOptionalString(body.sourceFormId);
      if (Object.prototype.hasOwnProperty.call(body, "assignedAt")) lead.assignedAt = cleanOptionalString(body.assignedAt);
      if (Object.prototype.hasOwnProperty.call(body, "firstContactAt")) lead.firstContactAt = cleanOptionalString(body.firstContactAt);
      if (Object.prototype.hasOwnProperty.call(body, "lastContactAt")) lead.lastContactAt = cleanOptionalString(body.lastContactAt);
      if (Object.prototype.hasOwnProperty.call(body, "slaDueAt")) lead.slaDueAt = cleanOptionalString(body.slaDueAt);
        if (Object.prototype.hasOwnProperty.call(body, "closingOutcome")) {
          const nextOutcome = String(body.closingOutcome || "").trim();
          if (["open", "won", "lost", "disqualified"].includes(nextOutcome)) lead.closingOutcome = nextOutcome;
        }
        if (Object.prototype.hasOwnProperty.call(body, "lossReason")) lead.lossReason = cleanOptionalString(body.lossReason);
        if (Object.prototype.hasOwnProperty.call(body, "lossDetail")) lead.lossDetail = cleanOptionalString(body.lossDetail);
        syncLeadAssignmentState(lead, previousAssignedTo, new Date().toISOString());
        syncLeadSlaState(lead);
        if (!["lost", "disqualified"].includes(String(lead.closingOutcome || ""))) {
          lead.lossReason = null;
          lead.lossDetail = null;
        }
      const hasNotesUpdate = Object.prototype.hasOwnProperty.call(body, "notes");
      const hasDocumentsUpdate = Object.prototype.hasOwnProperty.call(body, "documents");
      const hasPaymentsUpdate = Object.prototype.hasOwnProperty.call(body, "payments");
      const hasLeadFieldUpdate =
        ["fullName", "phone", "email", "source", "budget", "assignedTo"].some((key) => Object.prototype.hasOwnProperty.call(body, key)) ||
        ["sourceLeadId", "sourcePlatform", "sourceCampaignId", "sourceFormId", "assignedAt", "firstContactAt", "lastContactAt", "slaDueAt", "closingOutcome", "lossReason", "lossDetail"].some((key) =>
          Object.prototype.hasOwnProperty.call(body, key)
        );
      if (Object.prototype.hasOwnProperty.call(body, "documents")) {
        lead.documents = normalizePracticeDocuments(body.documents);
      }
      if (Object.prototype.hasOwnProperty.call(body, "payments")) {
        lead.payments = normalizePracticePayments(body.payments);
      }
      lead.updatedAt = new Date().toISOString();
      await saveLead(lead);
      if (Object.prototype.hasOwnProperty.call(body, "documents")) {
        await syncDocumentChecklistTask(lead);
      }
      if (Object.prototype.hasOwnProperty.call(body, "payments")) {
        await syncPaymentChecklistTask(lead);
      }
      if (Object.prototype.hasOwnProperty.call(body, "assignedTo")) {
        await syncPostSaleTasks(lead, "lead_patch");
      }
      const activities = [];
      if (hasPaymentsUpdate) {
        activities.push(
          createActivity({
            leadId: lead.id,
            type: "payments_updated",
            text: "Pagamenti pratica aggiornati.",
            actor: body.actor || "system"
          })
        );
      } else if (hasDocumentsUpdate) {
        activities.push(
          createActivity({
            leadId: lead.id,
            type: "documents_updated",
            text: "Documenti pratica aggiornati.",
            actor: body.actor || "system"
          })
        );
      }

      if (hasNotesUpdate) {
        const previousNoteText = previousNotes.trim();
        const nextNoteText = String(lead.notes || "").trim();
        if (nextNoteText && nextNoteText !== previousNoteText) {
          activities.push(
            createActivity({
              leadId: lead.id,
              type: previousNoteText ? "note_updated" : "note_added",
              text: nextNoteText,
              actor: body.actor || "system"
            })
          );
        }
      }

      if (!hasDocumentsUpdate && !hasPaymentsUpdate && hasLeadFieldUpdate) {
        activities.push(
          createActivity({
            leadId: lead.id,
            type: "lead_updated",
            text: "Anagrafica lead aggiornata.",
            actor: body.actor || "system"
          })
        );
      }

      await appendActivities(activities);
      return sendJson(res, 200, safeLead(lead));
    }

    const documentParams = routeMatch(pathname, "/leads/:leadId/documents/:documentId");
    if (documentParams && method === "PATCH") {
      const body = await parseBody(req);
      const lead = await getLeadById(documentParams.leadId);
      if (!lead) return sendJson(res, 404, { error: "Lead non trovato." });
      const documents = normalizePracticeDocuments(lead.documents);
      const documentId = String(documentParams.documentId || "");
      let found = false;
      const now = new Date().toISOString();
      documents.items = documents.items.map((item) => {
        if (String(item.key) !== documentId) return item;
        found = true;
        return {
          ...item,
          received: Object.prototype.hasOwnProperty.call(body, "received") ? Boolean(body.received) : item.received,
          verified: Object.prototype.hasOwnProperty.call(body, "verified") ? Boolean(body.verified) : item.verified,
          note: Object.prototype.hasOwnProperty.call(body, "note") ? String(body.note || "") : item.note,
          updatedAt: now
        };
      });
      if (!found) return sendJson(res, 404, { error: "Documento non trovato." });
      lead.documents = documents;
      lead.updatedAt = now;
      await saveLead(lead);
      await syncDocumentChecklistTask(lead);
      await appendActivities([
        createActivity({
          leadId: lead.id,
          type: "documents_updated",
          text: "Documento pratica aggiornato.",
          actor: body.actor || "chat"
        })
      ]);
      return sendJson(res, 200, safeLead(lead));
    }

    const paymentParams = routeMatch(pathname, "/leads/:leadId/payments/:paymentId");
    if (paymentParams && method === "PATCH") {
      const body = await parseBody(req);
      const lead = await getLeadById(paymentParams.leadId);
      if (!lead) return sendJson(res, 404, { error: "Lead non trovato." });
      const payments = normalizePracticePayments(lead.payments);
      const paymentId = String(paymentParams.paymentId || "");
      const allowedStatuses = new Set(["pending", "received", "verified"]);
      const now = new Date().toISOString();
      let found = false;
      payments.items = payments.items.map((item) => {
        if (String(item.id) !== paymentId) return item;
        found = true;
        const nextStatus = allowedStatuses.has(String(body.status || "")) ? String(body.status) : item.status;
        return {
          ...item,
          status: nextStatus,
          receivedAt: nextStatus === "received" || nextStatus === "verified" ? item.receivedAt || now : item.receivedAt,
          verifiedAt: nextStatus === "verified" ? item.verifiedAt || now : item.verifiedAt,
          method: Object.prototype.hasOwnProperty.call(body, "method") ? String(body.method || "") : item.method,
          note: Object.prototype.hasOwnProperty.call(body, "note") ? String(body.note || "") : item.note,
          updatedAt: now
        };
      });
      if (!found) return sendJson(res, 404, { error: "Pagamento non trovato." });
      lead.payments = payments;
      lead.updatedAt = now;
      await saveLead(lead);
      await syncPaymentChecklistTask(lead);
      await appendActivities([
        createActivity({
          leadId: lead.id,
          type: "payments_updated",
          text: "Pagamento pratica aggiornato.",
          actor: body.actor || "chat"
        })
      ]);
      return sendJson(res, 200, safeLead(lead));
    }

    const statusParams = routeMatch(pathname, "/leads/:leadId/status");
    if (statusParams && method === "POST") {
      const body = await parseBody(req);
      const toStatus = String(body.toStatus || "").trim();
      if (!toStatus) return sendJson(res, 400, { error: "toStatus obbligatorio." });
      const lead = await getLeadById(statusParams.leadId);
      if (!lead) return sendJson(res, 404, { error: "Lead non trovato." });
      const valid = await validateTransition(lead.status, toStatus);
      if (!valid) return sendJson(res, 400, { error: `Transizione non valida da "${lead.status}" a "${toStatus}".` });
      const lossReasonError = assertLossReasonForStatus(toStatus, body.lossReason);
      if (lossReasonError) return sendJson(res, 400, { error: lossReasonError });
      const previous = lead.status;
      lead.status = toStatus;
      lead.updatedAt = new Date().toISOString();
      syncLeadClosureState(lead, body.lossReason, body.lossDetail);
      syncLeadSlaState(lead);
      const activities = [
        createActivity({
          leadId: lead.id,
          type: "status_changed",
          text: `Stato aggiornato da "${previous}" a "${toStatus}".`,
          actor: body.actor || "system",
          meta: {
            fromStatus: previous,
            toStatus,
            closingOutcome: lead.closingOutcome,
            lossReason: lead.lossReason || null,
            lossDetail: lead.lossDetail || null
          }
        })
      ];
      activities.push(...applyStatusAutomation(lead, toStatus, body.actor || "system"));
      await saveLead(lead);
      await syncPostSaleTasks(lead, "status_change");
      await appendActivities(activities);
      const metaSync = await syncLeadToMetaCrm(lead, { stage: "status", eventTime: lead.updatedAt });
      await persistMetaSyncIfChanged(lead, metaSync);
      return sendJson(res, 200, safeLead(lead));
    }

    const callParams = routeMatch(pathname, "/leads/:leadId/calls");
    if (callParams && method === "GET") {
      const lead = await getLeadById(callParams.leadId);
      if (!lead) return sendJson(res, 404, { error: "Lead non trovato." });
      return sendJson(res, 200, await listCallLogsByLeadId(lead.id));
    }

    if (callParams && method === "POST") {
      const body = await parseBody(req);
      const lead = await getLeadById(callParams.leadId);
      if (!lead) return sendJson(res, 404, { error: "Lead non trovato." });
      const idempotencyKey = body.idempotencyKey ? String(body.idempotencyKey) : "";
      if (idempotencyKey) {
        const existingCall = await findCallLogByIdempotencyKey(lead.id, idempotencyKey);
        if (existingCall) {
          return sendJson(res, 200, safeLead(lead));
        }
      }
      const disposition = body.disposition || "completed";
      const previousStatus = lead.status;
      lead.updatedAt = new Date().toISOString();
      const startedAt = body.startedAt ? String(body.startedAt) : lead.updatedAt;
      const endedAt = body.endedAt ? String(body.endedAt) : lead.updatedAt;
      markLeadContacted(lead, endedAt);
      const note = body.note ? String(body.note) : "";
      if (body.followUpAt) lead.nextActionAt = String(body.followUpAt);
      const activities = [
        createActivity({
          leadId: lead.id,
          type: "call",
          text: note.trim() ? `Chiamata registrata (${disposition}) - ${note.trim()}` : `Chiamata registrata (${disposition}).`,
          actor: body.actor || "operator",
          meta: { durationSeconds: body.durationSeconds || 0, direction: body.direction || "outbound", phone: lead.phone, startedAt, endedAt, note }
        })
      ];
      const nextStatus = getStatusFromCallDisposition(disposition);
      if (nextStatus) {
        const valid = await validateTransition(lead.status, nextStatus);
        if (valid) {
          lead.status = nextStatus;
          syncLeadClosureState(lead, body.lossReason, body.lossDetail);
          syncLeadSlaState(lead);
          if (previousStatus !== nextStatus) {
            activities.push(
              createActivity({
                leadId: lead.id,
                type: "status_changed",
                text: `Stato aggiornato da "${previousStatus}" a "${nextStatus}".`,
                actor: body.actor || "system",
                meta: {
                  fromStatus: previousStatus,
                  toStatus: nextStatus,
                  source: "call_disposition",
                  closingOutcome: lead.closingOutcome,
                  lossReason: lead.lossReason || null,
                  lossDetail: lead.lossDetail || null
                }
              })
            );
          }
          activities.push(...applyStatusAutomation(lead, nextStatus, body.actor || "system"));
        }
      }
      await createCallLog({
        leadId: lead.id,
        startedAt,
        endedAt,
        outcome: disposition,
        actor: body.actor || "operator",
        note,
        idempotencyKey: idempotencyKey || undefined
      });
      lead.latestCallOutcome = disposition;
      lead.latestCallAt = startedAt;
      await saveLead(lead);
      await syncPostSaleTasks(lead, "call_status");
      await appendActivities(activities);
      if (nextStatus && previousStatus !== lead.status) {
        const metaSync = await syncLeadToMetaCrm(lead, { stage: "status", eventTime: endedAt });
        await persistMetaSyncIfChanged(lead, metaSync);
      }
      return sendJson(res, 200, safeLead(lead));
    }

    const taskParams = routeMatch(pathname, "/tasks/:taskId");
    if (taskParams && method === "PATCH") {
      const body = await parseBody(req);
      const task = (await getTaskById(taskParams.taskId)) as TaskRecord | null;
      if (!task) return sendJson(res, 404, { error: "Task non trovato." });
      if (body.status && ["open", "done", "dismissed"].includes(String(body.status))) task.status = String(body.status) as TaskRecord["status"];
      if (Object.prototype.hasOwnProperty.call(body, "priority")) task.priority = Number(body.priority || task.priority);
      if (Object.prototype.hasOwnProperty.call(body, "assignedTo")) task.assignedTo = body.assignedTo ? String(body.assignedTo) : "";
      if (Object.prototype.hasOwnProperty.call(body, "dueAt")) task.dueAt = body.dueAt ? String(body.dueAt) : null;
      if (body.title) task.title = String(body.title);
      if (Object.prototype.hasOwnProperty.call(body, "description")) task.description = body.description ? String(body.description) : "";
      task.updatedAt = new Date().toISOString();
      await saveTask(task);
      return sendJson(res, 200, task);
    }

    if (method === "POST" && pathname === "/internal/call-events") return sendJson(res, 200, await handleCallEvent(await parseBody(req)));
    return sendJson(res, 404, { error: "Endpoint non trovato." });
  } catch (error: any) {
    return sendJson(res, 500, { error: error.message || "Errore interno." });
  }
});

if (process.env.NODE_ENV !== "test") {
  server.listen(PORT, HOST, () => {
    console.log(`lead-service su http://localhost:${PORT}`);
    cleanupLegacyAutomaticTaskDuplicates().catch(() => {});
    ensureSlaTasks().catch(() => {});
    setInterval(() => {
      ensureSlaTasks().catch(() => {});
    }, SLA_TASK_INTERVAL_MS);
  });
}

