export type PracticeFocusSection = "overview" | "task" | "documents" | "payments" | "notes" | "timeline";

export const focusSectionMap: Record<PracticeFocusSection, string> = {
  overview: "overview-section",
  task: "overview-section",
  documents: "documents-section",
  payments: "payments-section",
  notes: "notes-section",
  timeline: "timeline-section"
};

type BuildPracticeUrlOptions = {
  payment?: string;
  document?: string;
};

type PracticeLinkTaskLike = {
  kind?: string;
  title?: string;
  description?: string;
  meta?: Record<string, unknown> | null;
};

export function buildPracticeUrl(leadId: string, focus?: PracticeFocusSection | null, options: BuildPracticeUrlOptions = {}) {
  const targetId = String(leadId || "").trim();
  if (!targetId) return "/pratiche";

  const searchParams = new URLSearchParams();
  if (focus) searchParams.set("focus", focus);
  if (options.payment) searchParams.set("payment", options.payment);
  if (options.document) searchParams.set("document", options.document);

  const query = searchParams.toString();
  return `/pratiche/${targetId}${query ? `?${query}` : ""}`;
}

function firstString(list: unknown): string | undefined {
  if (!Array.isArray(list)) return undefined;
  const value = list.find((item) => typeof item === "string" && item.trim());
  return typeof value === "string" ? value : undefined;
}

function includesAny(value: string, terms: string[]) {
  const normalized = String(value || "").toLowerCase();
  return terms.some((term) => normalized.includes(term));
}

export function getPracticeFocusFromTask(task: PracticeLinkTaskLike): PracticeFocusSection {
  const kind = String(task?.kind || "").toLowerCase();
  if (includesAny(kind, ["payment", "saldo"])) return "payments";
  if (includesAny(kind, ["document"])) return "documents";
  return "overview";
}

export function getPracticeUrlOptionsFromTask(task: PracticeLinkTaskLike): BuildPracticeUrlOptions {
  const meta = task?.meta || {};
  const description = `${task?.title || ""} ${task?.description || ""}`.toLowerCase();
  const focus = getPracticeFocusFromTask(task);

  if (focus === "payments") {
    const pendingId = firstString((meta as Record<string, unknown>).pendingIds);
    if (pendingId) return { payment: pendingId };
    if (includesAny(description, ["saldo", "balance"])) return { payment: "payment_balance" };
    if (includesAny(description, ["acconto", "deposit"])) return { payment: "payment_deposit" };
    return {};
  }

  if (focus === "documents") {
    const missingKey = firstString((meta as Record<string, unknown>).missingKeys);
    if (missingKey) return { document: missingKey };
    if (includesAny(description, ["identit", "passaporto"])) return { document: "identity_document" };
    if (includesAny(description, ["passegger"])) return { document: "passenger_data" };
    if (includesAny(description, ["contratto"])) return { document: "signed_contract" };
    if (includesAny(description, ["acconto", "pagamento"])) return { document: "deposit_payment" };
  }

  return {};
}
