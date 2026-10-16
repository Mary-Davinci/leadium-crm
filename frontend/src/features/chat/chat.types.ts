import type { CrmChatMessage, CrmChatMessageAttachment, CrmConversation } from "../../store/crm-store";

export type ConversationStatus = "open" | "waiting_customer" | "resolved";
export type InboxFilter = "all" | "unread" | "mine" | "unassigned" | "waiting" | "resolved";
export type MessageMode = "text" | "template";
export type AttachmentKind = "file" | "quote" | "practice_document";
export type ChatLayoutMode = "wide" | "medium" | "narrow" | "mobile";

export type Conversation = CrmConversation & {
  id: string;
  status?: ConversationStatus | string;
};

export type ChatAttachment = CrmChatMessageAttachment;

export type Message = CrmChatMessage & {
  agentName?: string;
  // Delivery-failure reason reported later by Meta's webhook (message saved, then status "failed").
  statusError?: string;
  // Client-only state for a message that has not been confirmed by the server yet.
  localState?: "sending" | "failed";
  localError?: string;
};

export type TemplateParameterOption = {
  name: string;
  label: string;
  component: "body" | "button_url";
  index: number;
  kind?: "text" | "url";
  required?: boolean;
  // Lead field the server prefills the value from when the operator leaves it empty.
  source?: "productInterest" | "quoteUrl" | "fullName";
};

export type TemplateOption = {
  key: string;
  name: string;
  label: string;
  body: string;
  category: "utility" | "followup";
  suggestionTag?: string;
  // Booking templates (additive; legacy templates simply omit them).
  parameters?: TemplateParameterOption[];
  metaCategory?: string;
  metaStatus?: string;
  automationMode?: "manual_only" | "automatic_allowed";
};

/** GET /api/whatsapp/automation/state: derived Booking automation state for the selected lead. */
export type WhatsappAutomationInfo = {
  leadId: string | null;
  state: {
    firstContactSentAt: string | null;
    lastTemplateKey: string | null;
    lastTemplateSentAt: string | null;
    followupStep: number;
    customerRepliedAt: string | null;
    paused: boolean;
    stoppedReason: string | null;
    stoppedReasonLabel: string | null;
    doNotContact: { active?: boolean; reason?: string | null; setAt?: string; setBy?: string } | null;
    automationEnabled: boolean;
  } | null;
  suggestions: Array<{ key: string; reason: string }>;
  templates: Record<string, { allowed: boolean; code?: string; reason?: string }>;
};

export type TimelineItem = {
  type: string;
  text: string;
  actor?: string;
  createdAt: string;
};

export type PracticeDocumentAttachment = {
  id: string;
  name: string;
  mimeType?: string;
  size?: number;
  storageKey?: string;
};

export type PracticeDocumentOption = {
  documentLabel: string;
  attachment: PracticeDocumentAttachment & { storageKey: string };
};

// A file the operator picked but has not sent yet.
export type DraftAttachment =
  | {
      id: string;
      source: "upload";
      kind: Exclude<AttachmentKind, "practice_document">;
      file: File;
      name: string;
      mimeType: string;
      size: number;
      previewUrl?: string;
    }
  | {
      id: string;
      source: "practice";
      kind: "practice_document";
      name: string;
      mimeType: string;
      size: number;
      storageKey: string;
    };
