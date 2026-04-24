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
  notes?: string;
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
