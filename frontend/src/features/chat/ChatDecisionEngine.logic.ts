export type DecisionDocument = {
  key: string;
  label?: string;
  required?: boolean;
  received?: boolean;
  verified?: boolean;
};

export type DecisionPayment = {
  id: string;
  label?: string;
  required?: boolean;
  status?: "pending" | "received" | "verified" | string;
  amount?: number;
  dueAt?: string;
};

export type DecisionLead = {
  id: string;
  fullName: string;
  phone?: string;
  email?: string;
  status?: string;
  assignedTo?: string;
  documents?: {
    items?: DecisionDocument[];
  };
  payments?: {
    items?: DecisionPayment[];
  };
};

export type DecisionTask = {
  id: string;
  leadId?: string;
  kind?: string;
  title: string;
  description?: string;
  status?: string;
  priority?: number;
  dueAt?: string | null;
  createdAt: string;
};

export type DecisionConversation = {
  status?: string;
  unreadCount?: number;
  assignedTo?: string;
  hasOpenSession?: boolean;
};

export function getTaskDueLane(task: DecisionTask) {
  if (!task.dueAt) return "planned";
  const due = new Date(task.dueAt);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate()).getTime();
  if (due.getTime() < now.getTime()) return "overdue";
  if (dueDay === today) return "today";
  return "planned";
}

export function sortOperationalTasks(a: DecisionTask, b: DecisionTask) {
  const laneOrder: Record<string, number> = { overdue: 0, today: 1, planned: 2 };
  const laneDiff = laneOrder[getTaskDueLane(a)] - laneOrder[getTaskDueLane(b)];
  if (laneDiff !== 0) return laneDiff;
  if ((b.priority || 0) !== (a.priority || 0)) return (b.priority || 0) - (a.priority || 0);
  return new Date(a.dueAt || a.createdAt).getTime() - new Date(b.dueAt || b.createdAt).getTime();
}

export function getPendingPayments(lead?: DecisionLead | null) {
  return (lead?.payments?.items || []).filter((item) => item.required && item.status !== "verified");
}

export function getMissingDocuments(lead?: DecisionLead | null) {
  return (lead?.documents?.items || []).filter((item) => item.required && (!item.received || !item.verified));
}

export function getPaymentProgress(lead?: DecisionLead | null) {
  const requiredPayments = (lead?.payments?.items || []).filter((item) => item.required);
  const totalAmount = requiredPayments.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const verifiedAmount = requiredPayments
    .filter((item) => item.status === "verified")
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const percent = totalAmount > 0 ? Math.min(100, Math.round((verifiedAmount / totalAmount) * 100)) : 0;
  return { totalAmount, verifiedAmount, percent };
}

export function formatPaymentStatusDate(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit" });
}

export function getPaymentVisualStatus(payment: DecisionPayment) {
  const dueDate = formatPaymentStatusDate(payment.dueAt);
  if (payment.status === "verified") return { label: "VERIFICATO", tone: "success" as const };
  if (payment.dueAt && new Date(payment.dueAt).getTime() < Date.now()) {
    return { label: `SCADUTO${dueDate ? ` (${dueDate})` : ""}`, tone: "danger" as const };
  }
  if (payment.status === "received") return { label: "IN ATTESA VERIFICA", tone: "warning" as const };
  return { label: `IN ATTESA${dueDate ? ` (${dueDate})` : ""}`, tone: "warning" as const };
}

export function getRecommendedAction(lead: DecisionLead | null, openTasks: DecisionTask[]) {
  const firstPayment = getPendingPayments(lead)[0];
  if (firstPayment) {
    return {
      label: `${firstPayment.label || "Pagamento"} non ricevuto`,
      detail: firstPayment.amount ? `Importo EUR ${firstPayment.amount}` : "Pagamento da gestire",
      kind: "payment" as const,
      payment: firstPayment
    };
  }

  const firstDocument = getMissingDocuments(lead)[0];
  if (firstDocument) {
    return {
      label: `${firstDocument.label || "Documento"} mancante`,
      detail: "Documento richiesto non ancora completo",
      kind: "document" as const,
      document: firstDocument
    };
  }

  const firstTask = openTasks[0];
  if (firstTask) {
    return {
      label: firstTask.title,
      detail: firstTask.dueAt ? `Scadenza ${new Date(firstTask.dueAt).toLocaleString("it-IT")}` : "Task da pianificare",
      kind: "task" as const,
      task: firstTask
    };
  }

  return null;
}

export function getDecisionSnapshot(lead: DecisionLead | null, openTasks: DecisionTask[]) {
  const pendingPayments = getPendingPayments(lead);
  const missingDocuments = getMissingDocuments(lead);
  return {
    pendingPayments,
    pendingPaymentAmount: pendingPayments.reduce((sum, item) => sum + Number(item.amount || 0), 0),
    missingDocuments,
    missingDocumentsCount: missingDocuments.length,
    paymentProgress: getPaymentProgress(lead),
    recommendedAction: getRecommendedAction(lead, openTasks),
    blockersCount: pendingPayments.length + missingDocuments.length
  };
}

export function getConversationPriorityScore(conversation: DecisionConversation, authUsername: string) {
  let score = 0;
  if (conversation.status === "resolved") score -= 200;
  else if (conversation.status === "waiting_customer") score += 70;
  else score += 90;
  if (Number(conversation.unreadCount || 0) > 0) score += 120;
  if (authUsername && String(conversation.assignedTo || "") === authUsername) score += 35;
  if (!String(conversation.assignedTo || "").trim()) score += 20;
  if (conversation.hasOpenSession) score += 10;
  return score;
}
