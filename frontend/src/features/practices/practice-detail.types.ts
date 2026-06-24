export type Workflow = {
  statuses: string[];
  flow: Record<string, string[]>;
};

export type Lead = {
  id: string;
  fullName: string;
  phone: string;
  email?: string;
  source?: string;
  assignedTo?: string;
  assignedAt?: string | null;
  notes?: string;
  sourceLeadId?: string | null;
  sourcePlatform?: string | null;
  sourceCampaignId?: string | null;
  sourceFormId?: string | null;
  firstContactAt?: string | null;
  lastContactAt?: string | null;
  slaDueAt?: string | null;
  closingOutcome?: "open" | "won" | "lost" | "disqualified";
  lossReason?: string | null;
  lossDetail?: string | null;
  metaEventSync?: {
    lastEventName?: string | null;
    lastStatus?: string | null;
    lastSyncedAt?: string | null;
    lastAttemptAt?: string | null;
    lastError?: string | null;
    attemptCount?: number;
  } | null;
  status: string;
  nextActionAt?: string;
};

export type TimelineItem = {
  type: string;
  text: string;
  actor: string;
  createdAt: string;
};

export type LeadDetail = {
  lead: Lead;
  timeline: TimelineItem[];
};

export type Task = {
  id: string;
  leadId: string;
  title: string;
  description?: string;
  dueAt?: string;
  status: "open" | "done" | "dismissed";
  assignedTo?: string;
  createdAt?: string;
};

export type Priority = "alta" | "media" | "bassa";

export type NoteEntry = {
  id: string;
  text: string;
  createdAt: string;
  actor: string;
};

export type NextActionMeta = {
  label: string;
  detail: string;
  className: string;
};

export type TimelineMeta = {
  icon: string;
  className: string;
};
