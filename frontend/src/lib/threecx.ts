import { CallOutcome, Lead } from "../features/practices/pratiche.types";

const PENDING_CALL_KEY = "leadium.pending-call";

export type Pending3CXCall = {
  leadId: string;
  phone: string;
  startedAt: string;
  requestKey: string;
};

export type ThreeCXCallbackPayload = {
  leadId: string;
  startedAt?: string;
  requestKey?: string;
  outcome: CallOutcome;
  note?: string;
  followUpAt?: string;
};

function getFirstSearchParam(url: URL, keys: string[]) {
  for (const key of keys) {
    const value = url.searchParams.get(key);
    if (value) return value;
  }
  return "";
}

function sanitizePhone(phone: string) {
  return String(phone || "").replace(/[^\d+]/g, "");
}

function getCallbackPath() {
  return String(import.meta.env.VITE_3CX_CALLBACK_PATH || "/calls/bridge").trim() || "/calls/bridge";
}

export function createPending3CXCall(lead: Lead) {
  const pending: Pending3CXCall = {
    leadId: lead.id,
    phone: sanitizePhone(lead.phone || ""),
    startedAt: new Date().toISOString(),
    requestKey: `callreq_${lead.id}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`
  };
  sessionStorage.setItem(PENDING_CALL_KEY, JSON.stringify(pending));
  return pending;
}

export function getPending3CXCall() {
  const raw = sessionStorage.getItem(PENDING_CALL_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Pending3CXCall;
  } catch {
    return null;
  }
}

export function clearPending3CXCall() {
  sessionStorage.removeItem(PENDING_CALL_KEY);
}

export function build3CXCallUri(lead: Lead, pending: Pending3CXCall) {
  const template = String(import.meta.env.VITE_3CX_DIAL_URL || "").trim();
  const phone = sanitizePhone(lead.phone || "");
  if (!phone) return "";

  if (!template) return `tel:${phone}`;

  const callbackUrl = new URL(getCallbackPath(), window.location.origin);
  callbackUrl.searchParams.set("leadId", pending.leadId);
  callbackUrl.searchParams.set("startedAt", pending.startedAt);
  callbackUrl.searchParams.set("requestKey", pending.requestKey);

  return template
    .replaceAll("{phone}", encodeURIComponent(phone))
    .replaceAll("{leadId}", encodeURIComponent(pending.leadId))
    .replaceAll("{startedAt}", encodeURIComponent(pending.startedAt))
    .replaceAll("{requestKey}", encodeURIComponent(pending.requestKey))
    .replaceAll("{callbackUrl}", encodeURIComponent(callbackUrl.toString()));
}

export function launch3CXUri(uri: string) {
  const target = String(uri || "").trim();
  if (!target) return false;

  try {
    const anchor = document.createElement("a");
    anchor.href = target;
    anchor.rel = "noopener";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    window.setTimeout(() => {
      if (document.visibilityState === "visible") {
        window.location.assign(target);
      }
    }, 140);
    window.setTimeout(() => {
      anchor.remove();
    }, 200);
    return true;
  } catch {
    try {
      window.location.assign(target);
      return true;
    } catch {
      return false;
    }
  }
}

function mapOutcome(raw: string): CallOutcome | null {
  const normalized = String(raw || "").trim().toLowerCase();
  if (normalized === "completed" || normalized === "answered" || normalized === "success") return "completed";
  if (normalized === "no_answer" || normalized === "no-answer" || normalized === "missed") return "no_answer";
  if (normalized === "busy") return "busy";
  if (normalized === "call_back" || normalized === "callback" || normalized === "call-back") return "call_back";
  if (normalized === "interested") return "interested";
  if (normalized === "not_interested" || normalized === "not-interested") return "not_interested";
  return null;
}

export function read3CXCallbackPayload(url: URL): ThreeCXCallbackPayload | null {
  const pending = getPending3CXCall();
  const leadId = getFirstSearchParam(url, ["leadId", "lead_id", "crmLeadId", "crm_lead_id"]) || pending?.leadId || "";
  const startedAt =
    getFirstSearchParam(url, ["startedAt", "started_at", "callStartedAt", "call_started_at"]) || pending?.startedAt || undefined;
  const requestKey =
    getFirstSearchParam(url, ["requestKey", "request_key", "callRequestKey", "call_request_key"]) ||
    pending?.requestKey ||
    undefined;
  const rawOutcome = getFirstSearchParam(url, [
    "outcome",
    "disposition",
    "status",
    "callOutcome",
    "call_outcome",
    "result",
    "callResult",
    "call_result"
  ]);
  const outcome = mapOutcome(rawOutcome);

  if (!leadId || !outcome) return null;

  return {
    leadId,
    startedAt,
    requestKey,
    outcome,
    note: getFirstSearchParam(url, ["note", "notes", "comment", "description"]) || undefined,
    followUpAt: getFirstSearchParam(url, ["followUpAt", "follow_up_at", "callbackAt", "callback_at"]) || undefined
  };
}
