import { createActivity } from "../common/automation";
import { createLead, findLeadByContact, newId, normalizeEmail, normalizePhone } from "../common/leadStore";
import { LEAD_STATUSES } from "../common/workflow";

export type LeadImportCandidateInput = {
  rowNumber?: number;
  fullName?: string;
  phone?: string;
  email?: string;
  notes?: string;
  metadata?: Record<string, unknown> | null;
};

type LeadImportPreparedRow = {
  rowNumber: number;
  fullName: string;
  phone: string;
  email: string;
  notes: string;
  metadata: Record<string, unknown> | null;
  contactKey: string;
};

export type LeadImportPreviewRow = {
  rowNumber: number;
  fullName: string;
  phone: string;
  email: string;
  notes: string;
  status: "ready" | "invalid" | "duplicate_file" | "duplicate_existing";
  reason?: string;
  metadata?: Record<string, unknown> | null;
  existingLead?: {
    id: string;
    fullName: string;
    phone: string;
    email: string;
    source: string;
    status: string;
  } | null;
};

export type LeadImportPreviewResult = {
  source: string;
  status: string;
  summary: {
    received: number;
    ready: number;
    invalid: number;
    duplicateFile: number;
    duplicateExisting: number;
  };
  rows: LeadImportPreviewRow[];
};

export type LeadImportApplyResult = LeadImportPreviewResult & {
  created: Array<{
    id: string;
    fullName: string;
    phone: string;
    email: string;
  }>;
};

function cleanText(value: unknown) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ");
}

function buildContactKey(phone: string, email: string) {
  const phoneKey = normalizePhone(phone);
  if (phoneKey) return `phone::${phoneKey}`;
  const emailKey = normalizeEmail(email);
  if (emailKey) return `email::${emailKey}`;
  return "";
}

function slugifySource(value: string) {
  const base = cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const normalized = base || `import_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
  return normalized.startsWith("excel_") ? normalized : `excel_${normalized}`;
}

function normalizeSource(value?: string) {
  return slugifySource(value || "");
}

function normalizeStatus(value?: string) {
  const normalized = cleanText(value);
  return normalized || LEAD_STATUSES.TO_CONTACT;
}

function normalizeMetadata(metadata: unknown) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  return metadata as Record<string, unknown>;
}

function normalizeCandidate(input: LeadImportCandidateInput, index: number): LeadImportPreparedRow | null {
  const fullName = cleanText(input.fullName);
  const phone = cleanText(input.phone);
  const email = cleanText(input.email).toLowerCase();
  const notes = String(input.notes || "").trim();
  const rowNumber = Number(input.rowNumber || index + 1);
  const contactKey = buildContactKey(phone, email);
  if (!fullName || !contactKey) return null;

  return {
    rowNumber,
    fullName,
    phone,
    email,
    notes,
    metadata: normalizeMetadata(input.metadata),
    contactKey
  };
}

async function prepareImportRows(input: { source?: string; status?: string; leads?: LeadImportCandidateInput[] }) {
  const source = normalizeSource(input.source);
  const status = normalizeStatus(input.status);
  const leads = Array.isArray(input.leads) ? input.leads : [];
  const rows: LeadImportPreviewRow[] = [];
  const readyRows: LeadImportPreparedRow[] = [];
  const seenContacts = new Map<string, number>();

  for (let index = 0; index < leads.length; index += 1) {
    const raw = leads[index];
    const normalized = normalizeCandidate(raw, index);
    const fallbackRowNumber = Number(raw?.rowNumber || index + 1);

    if (!normalized) {
      rows.push({
        rowNumber: fallbackRowNumber,
        fullName: cleanText(raw?.fullName),
        phone: cleanText(raw?.phone),
        email: cleanText(raw?.email).toLowerCase(),
        notes: String(raw?.notes || "").trim(),
        status: "invalid",
        reason: "Nome o contatto mancante.",
        metadata: normalizeMetadata(raw?.metadata)
      });
      continue;
    }

    if (seenContacts.has(normalized.contactKey)) {
      rows.push({
        rowNumber: normalized.rowNumber,
        fullName: normalized.fullName,
        phone: normalized.phone,
        email: normalized.email,
        notes: normalized.notes,
        status: "duplicate_file",
        reason: `Duplicata nel file (riga ${seenContacts.get(normalized.contactKey)}).`,
        metadata: normalized.metadata
      });
      continue;
    }
    seenContacts.set(normalized.contactKey, normalized.rowNumber);

    const existing = await findLeadByContact(normalized.phone, normalized.email);
    if (existing) {
      rows.push({
        rowNumber: normalized.rowNumber,
        fullName: normalized.fullName,
        phone: normalized.phone,
        email: normalized.email,
        notes: normalized.notes,
        status: "duplicate_existing",
        reason: "Gia presente nel database.",
        metadata: normalized.metadata,
        existingLead: {
          id: String(existing.id || ""),
          fullName: String(existing.fullName || ""),
          phone: String(existing.phone || ""),
          email: String(existing.email || ""),
          source: String(existing.source || ""),
          status: String(existing.status || "")
        }
      });
      continue;
    }

    readyRows.push(normalized);
    rows.push({
      rowNumber: normalized.rowNumber,
      fullName: normalized.fullName,
      phone: normalized.phone,
      email: normalized.email,
      notes: normalized.notes,
      status: "ready",
      metadata: normalized.metadata
    });
  }

  return {
    source,
    status,
    rows,
    readyRows
  };
}

function buildSummary(rows: LeadImportPreviewRow[]) {
  return {
    received: rows.length,
    ready: rows.filter((row) => row.status === "ready").length,
    invalid: rows.filter((row) => row.status === "invalid").length,
    duplicateFile: rows.filter((row) => row.status === "duplicate_file").length,
    duplicateExisting: rows.filter((row) => row.status === "duplicate_existing").length
  };
}

export async function previewLeadImport(input: { source?: string; status?: string; leads?: LeadImportCandidateInput[] }): Promise<LeadImportPreviewResult> {
  const prepared = await prepareImportRows(input);
  return {
    source: prepared.source,
    status: prepared.status,
    summary: buildSummary(prepared.rows),
    rows: prepared.rows
  };
}

export async function applyLeadImport(
  input: { source?: string; status?: string; leads?: LeadImportCandidateInput[] },
  actor = "excel_import"
): Promise<LeadImportApplyResult> {
  const prepared = await prepareImportRows(input);
  const created: LeadImportApplyResult["created"] = [];

  for (const row of prepared.readyRows) {
    const now = new Date().toISOString();
    const lead = {
      id: newId("lead"),
      fullName: row.fullName,
      phone: row.phone,
      email: row.email,
      source: prepared.source,
      budget: "",
      assignedTo: "",
      status: prepared.status,
      notes: row.notes,
      documents: { items: [] },
      payments: { items: [] },
      latestCallOutcome: null,
      latestCallAt: null,
      callAttempts: 0,
      nextActionAt: null,
      createdAt: now,
      updatedAt: now
    };

    await createLead(lead, [
      createActivity({
        leadId: lead.id,
        type: "lead_created",
        text: "Lead creato da import Excel.",
        actor
      }),
      createActivity({
        leadId: lead.id,
        type: "lead_imported",
        text: `Lead importato nel batch ${prepared.source}.`,
        actor,
        meta: {
          source: prepared.source,
          rowNumber: row.rowNumber,
          metadata: row.metadata || null
        }
      })
    ]);

    created.push({
      id: lead.id,
      fullName: lead.fullName,
      phone: lead.phone,
      email: lead.email
    });
  }

  return {
    source: prepared.source,
    status: prepared.status,
    summary: buildSummary(prepared.rows),
    rows: prepared.rows,
    created
  };
}
