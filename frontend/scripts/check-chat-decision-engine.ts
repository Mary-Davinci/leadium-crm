import assert from "node:assert/strict";
import {
  getConversationPriorityScore,
  getDecisionSnapshot,
  getPaymentVisualStatus,
  sortOperationalTasks,
  type DecisionLead,
  type DecisionTask
} from "../src/features/chat/ChatDecisionEngine.logic";

const overdueDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
overdueDate.setHours(9, 0, 0, 0);
const todayDate = new Date();
todayDate.setHours(23, 0, 0, 0);
const yesterday = overdueDate.toISOString();
const today = todayDate.toISOString();

const paymentLead: DecisionLead = {
  id: "lead-payment",
  fullName: "Mario Rossi",
  payments: {
    items: [
      {
        id: "deposit",
        label: "Acconto",
        required: true,
        status: "pending",
        amount: 300,
        dueAt: yesterday
      }
    ]
  },
  documents: {
    items: [
      {
        key: "passport",
        label: "Passaporto",
        required: true,
        received: false,
        verified: false
      }
    ]
  }
};

const paymentSnapshot = getDecisionSnapshot(paymentLead, []);
assert.equal(paymentSnapshot.recommendedAction?.kind, "payment", "Il pagamento scaduto deve essere la prossima azione.");
assert.equal(paymentSnapshot.blockersCount, 2, "Pagamento e documento devono contare come bloccanti.");
assert.equal(getPaymentVisualStatus(paymentLead.payments?.items?.[0]!).tone, "danger", "Pagamento scaduto deve essere rosso.");

const documentLead: DecisionLead = {
  id: "lead-document",
  fullName: "Franco Bianchi",
  payments: {
    items: [{ id: "deposit", label: "Acconto", required: true, status: "verified", amount: 300, dueAt: today }]
  },
  documents: {
    items: [{ key: "identity", label: "Documento identita", required: true, received: false, verified: false }]
  }
};

const documentSnapshot = getDecisionSnapshot(documentLead, []);
assert.equal(documentSnapshot.recommendedAction?.kind, "document", "Documento mancante deve emergere quando i pagamenti sono ok.");
assert.equal(documentSnapshot.pendingPayments.length, 0, "I pagamenti verificati non devono restare pendenti.");
assert.equal(documentSnapshot.missingDocumentsCount, 1, "Il documento mancante deve restare visibile.");

const taskA: DecisionTask = {
  id: "task-today",
  leadId: "lead-chat",
  title: "Richiamo cliente attivo",
  status: "open",
  priority: 60,
  dueAt: today,
  createdAt: today
};
const taskB: DecisionTask = {
  id: "task-overdue",
  leadId: "lead-chat",
  title: "Task scaduto",
  status: "open",
  priority: 40,
  dueAt: yesterday,
  createdAt: yesterday
};
assert.equal([taskA, taskB].sort(sortOperationalTasks)[0].id, "task-overdue", "Task scaduto deve precedere task di oggi.");

const activeOpenWhatsappScore = getConversationPriorityScore(
  { status: "open", unreadCount: 1, assignedTo: "operatore", hasOpenSession: true },
  "operatore"
);
const closedWhatsappScore = getConversationPriorityScore(
  { status: "open", unreadCount: 0, assignedTo: "operatore", hasOpenSession: false },
  "operatore"
);
assert.ok(activeOpenWhatsappScore > closedWhatsappScore, "WhatsApp aperto con cliente attivo deve salire in priorita.");

console.log("ChatDecisionEngine smoke: pagamento scaduto, documento mancante e WhatsApp attivo OK.");
