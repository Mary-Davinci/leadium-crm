import { LEAD_STATUSES } from "./workflow";

const META_CRM_SYNC_ENABLED = ["1", "true", "yes", "on"].includes(String(process.env.META_CRM_SYNC_ENABLED || "").trim().toLowerCase());
const META_CRM_PIXEL_ID = String(process.env.META_CRM_PIXEL_ID || "").trim();
const META_CRM_ACCESS_TOKEN = String(process.env.META_CRM_ACCESS_TOKEN || "").trim();
const META_CRM_GRAPH_VERSION = String(process.env.META_CRM_GRAPH_VERSION || "v25.0").trim();
const META_CRM_LEAD_EVENT_SOURCE = String(process.env.META_CRM_LEAD_EVENT_SOURCE || "leadium_crm").trim();
const META_CRM_TEST_EVENT_CODE = String(process.env.META_CRM_TEST_EVENT_CODE || "").trim();
const META_CRM_MAX_ATTEMPTS = Math.max(1, Number(process.env.META_CRM_MAX_ATTEMPTS || 2));

type MetaSyncStage = "initial" | "status";

type MetaEventSyncState = {
  lastEventName?: string | null;
  lastStatus?: string | null;
  lastSyncedAt?: string | null;
  lastAttemptAt?: string | null;
  lastError?: string | null;
  attemptCount?: number;
};

type MetaSyncResult = {
  attempted: boolean;
  sent: boolean;
  skipped: boolean;
  changed: boolean;
  eventName?: string | null;
  reason?: string;
};

function sanitizeLeadId(value: unknown) {
  const digits = String(value || "").replace(/\D+/g, "");
  return /^\d{15,16}$/.test(digits) ? digits : null;
}

function toUnixSeconds(value?: string | null) {
  const parsed = value ? new Date(value).getTime() : Date.now();
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed / 1000) : Math.floor(Date.now() / 1000);
}

function getMetaEventNameForStatus(status: string) {
  switch (status) {
    case LEAD_STATUSES.CALLBACK_AGREED:
      return "contacted";
    case LEAD_STATUSES.NO_ANSWER:
      return "contact_attempted";
    case LEAD_STATUSES.INTERESTED:
      return "qualified_lead";
    case LEAD_STATUSES.INSTALLMENT_SALE:
    case LEAD_STATUSES.ONE_SHOT_SALE:
      return "sales_opportunity";
    case LEAD_STATUSES.FIRST_DEPOSIT:
      return "deposit_paid";
    case LEAD_STATUSES.SECOND_DEPOSIT:
      return "second_deposit_paid";
    case LEAD_STATUSES.BALANCE_DUE:
      return "balance_due";
    case LEAD_STATUSES.SOLD:
      return "converted";
    case LEAD_STATUSES.NOT_INTERESTED:
    case LEAD_STATUSES.OUT_OF_BUDGET:
      return "disqualified";
    case LEAD_STATUSES.LOST:
      return "lost";
    default:
      return null;
  }
}

function getMetaEventName(lead: any, stage: MetaSyncStage) {
  if (stage === "initial") return "initial_lead";
  return getMetaEventNameForStatus(String(lead?.status || ""));
}

function getMetaSyncState(lead: any): MetaEventSyncState {
  const current = lead?.metaEventSync;
  if (!current || typeof current !== "object" || Array.isArray(current)) return {};
  return current as MetaEventSyncState;
}

function buildPayload(lead: any, eventName: string, eventTime?: string | null) {
  const leadId = sanitizeLeadId(lead?.sourceLeadId);
  if (!leadId) return null;
  const payload: Record<string, unknown> = {
    data: [
      {
        event_name: eventName,
        event_time: toUnixSeconds(eventTime || lead?.updatedAt || lead?.createdAt || null),
        action_source: "system_generated",
        user_data: {
          lead_id: Number(leadId)
        },
        custom_data: {
          event_source: "crm",
          lead_event_source: META_CRM_LEAD_EVENT_SOURCE,
          crm_status: String(lead?.status || ""),
          closing_outcome: String(lead?.closingOutcome || "open")
        }
      }
    ]
  };
  if (META_CRM_TEST_EVENT_CODE) payload.test_event_code = META_CRM_TEST_EVENT_CODE;
  return payload;
}

function applyMetaSyncState(lead: any, patch: Partial<MetaEventSyncState>) {
  const current = getMetaSyncState(lead);
  const next = { ...current, ...patch };
  const changed = JSON.stringify(current) !== JSON.stringify(next);
  if (changed) lead.metaEventSync = next;
  return changed;
}

function canSync() {
  return META_CRM_SYNC_ENABLED && Boolean(META_CRM_PIXEL_ID) && Boolean(META_CRM_ACCESS_TOKEN);
}

async function postPayload(payload: Record<string, unknown>) {
  const url = `https://graph.facebook.com/${META_CRM_GRAPH_VERSION}/${encodeURIComponent(META_CRM_PIXEL_ID)}/events?access_token=${encodeURIComponent(META_CRM_ACCESS_TOKEN)}`;
  let lastError = "";

  for (let attempt = 1; attempt <= META_CRM_MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (res.ok) return;
      lastError = await res.text();
      if (res.status < 500 || attempt === META_CRM_MAX_ATTEMPTS) {
        throw new Error(`Meta CRM sync error (${res.status}): ${lastError}`);
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt === META_CRM_MAX_ATTEMPTS) {
        throw new Error(lastError);
      }
    }
  }
}

export async function syncLeadToMetaCrm(lead: any, input: { stage: MetaSyncStage; eventTime?: string | null }): Promise<MetaSyncResult> {
  const eventName = getMetaEventName(lead, input.stage);
  if (!canSync()) {
    return { attempted: false, sent: false, skipped: true, changed: false, eventName, reason: "sync_disabled_or_unconfigured" };
  }
  if (!eventName) {
    return { attempted: false, sent: false, skipped: true, changed: false, reason: "no_mapped_event" };
  }
  const payload = buildPayload(lead, eventName, input.eventTime || null);
  if (!payload) {
    const changed = applyMetaSyncState(lead, {
      lastAttemptAt: new Date().toISOString(),
      lastError: "missing_or_invalid_sourceLeadId",
      attemptCount: (getMetaSyncState(lead).attemptCount || 0) + 1
    });
    return { attempted: false, sent: false, skipped: true, changed, eventName, reason: "missing_or_invalid_sourceLeadId" };
  }

  const currentSync = getMetaSyncState(lead);
  if (
    input.stage === "status" &&
    currentSync.lastEventName === eventName &&
    currentSync.lastStatus === String(lead?.status || "") &&
    !currentSync.lastError
  ) {
    return { attempted: false, sent: false, skipped: true, changed: false, eventName, reason: "already_synced_for_status" };
  }

  const attemptAt = new Date().toISOString();
  let changed = applyMetaSyncState(lead, {
    lastAttemptAt: attemptAt,
    attemptCount: (currentSync.attemptCount || 0) + 1
  });

  try {
    await postPayload(payload);
    changed =
      applyMetaSyncState(lead, {
        lastEventName: eventName,
        lastStatus: String(lead?.status || ""),
        lastSyncedAt: new Date().toISOString(),
        lastAttemptAt: attemptAt,
        lastError: null
      }) || changed;
    return { attempted: true, sent: true, skipped: false, changed, eventName };
  } catch (error) {
    changed =
      applyMetaSyncState(lead, {
        lastEventName: eventName,
        lastStatus: String(lead?.status || ""),
        lastAttemptAt: attemptAt,
        lastError: error instanceof Error ? error.message : "meta_sync_failed"
      }) || changed;
    return { attempted: true, sent: false, skipped: false, changed, eventName, reason: error instanceof Error ? error.message : "meta_sync_failed" };
  }
}
