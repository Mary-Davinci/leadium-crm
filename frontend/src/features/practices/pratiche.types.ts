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
  customerId?: string | null;
  practiceReview?: PracticeReviewState | null;
  metaEventSync?: {
    lastEventName?: string | null;
    lastStatus?: string | null;
    lastSyncedAt?: string | null;
    lastAttemptAt?: string | null;
    lastError?: string | null;
    attemptCount?: number;
  } | null;
  cruiseName?: string;
  destination?: string;
  company?: string;
  documentsMissingCount?: number;
  pendingPaymentsCount?: number;
  documents?: PracticeDocumentsState;
  payments?: PracticePaymentsState;
  status: string;
  nextActionAt?: string;
  latestCallOutcome?: CallOutcome | null;
  latestCallAt?: string | null;
  callAttempts?: number;
  secondAttemptPending?: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type PracticeReviewDecision = "pending_admin" | "approved" | "returned_to_operator";

export type PracticeReviewState = {
  finalNote?: string | null;
  finalNoteAt?: string | null;
  finalNoteBy?: string | null;
  sentToReviewAt?: string | null;
  sentToReviewBy?: string | null;
  reviewDecision?: PracticeReviewDecision | null;
  reviewedAt?: string | null;
  reviewedBy?: string | null;
  reviewNote?: string | null;
  returnedAt?: string | null;
  returnedBy?: string | null;
  closedAt?: string | null;
  closedBy?: string | null;
  reopenedAt?: string | null;
  reopenedBy?: string | null;
};

export type PracticeDocumentKey =
  | "identity_document"
  | "passenger_data"
  | "signed_contract"
  | "deposit_payment";

export type PracticeDocumentItem = {
  key: PracticeDocumentKey;
  label: string;
  required: boolean;
  received: boolean;
  verified: boolean;
  note?: string;
  updatedAt?: string;
  verifiedAt?: string;
  verifiedBy?: string;
  attachments?: PracticeDocumentAttachment[];
};

export type PracticeDocumentsState = {
  items: PracticeDocumentItem[];
};

export type PracticeDocumentAttachment = {
  id: string;
  name: string;
  mimeType?: string;
  size?: number;
  dataUrl?: string;
  storageKey?: string;
  storageProvider?: string;
  uploadedAt?: string;
  uploadedBy?: string;
};

export type PaymentStatus = "pending" | "received" | "verified";

export type PracticePaymentItem = {
  id: string;
  label: string;
  amount: number;
  status: PaymentStatus;
  dueAt?: string;
  receivedAt?: string;
  verifiedAt?: string;
  method?: string;
  note?: string;
  required: boolean;
  updatedAt?: string;
};

export type PracticePaymentsState = {
  items: PracticePaymentItem[];
};

export type CallOutcome =
  | "completed"
  | "no_answer"
  | "busy"
  | "call_back"
  | "interested"
  | "not_interested"
  | "quote_required"
  | "quote_sent"
  | "appointment_set"
  | "other";

export type CallLog = {
  id: string;
  leadId: string;
  startedAt: string;
  endedAt?: string;
  outcome: CallOutcome;
  actor: string;
  note?: string;
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
  callLogs?: CallLog[];
};

export type Priority = "alta" | "media" | "bassa";

export type NextActionMeta = {
  label: string;
  dateText: string;
  className: string;
};
