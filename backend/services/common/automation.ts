import { LEAD_STATUSES } from "./workflow";

type ActivityInput = {
  leadId: string;
  type: string;
  text: string;
  meta?: Record<string, unknown>;
  actor?: string;
};

export function createActivity({ leadId, type, text, meta = {}, actor = "system" }: ActivityInput) {
  return {
    id: `act_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    leadId,
    type,
    text,
    meta,
    actor,
    createdAt: new Date().toISOString()
  };
}

function createTaskActivity(leadId: string, text: string, dueAt: string, actor: string) {
  return createActivity({
    leadId,
    type: "task",
    text,
    actor,
    meta: { dueAt }
  });
}

export function applyStatusAutomation(lead: any, toStatus: string, actor = "system") {
  const activities: any[] = [];
  const now = new Date().toISOString();

  if (toStatus === LEAD_STATUSES.NO_ANSWER) {
    lead.callAttempts = (lead.callAttempts || 0) + 1;
    lead.nextActionAt = lead.nextActionAt || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    activities.push(createTaskActivity(lead.id, "Richiamo automatico domani: chiamata non risposta.", lead.nextActionAt, actor));
  }

  if (toStatus === LEAD_STATUSES.CALLBACK_AGREED) {
    lead.nextActionAt = lead.nextActionAt || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    activities.push(createTaskActivity(lead.id, "Richiamo concordato con cliente.", lead.nextActionAt, actor));
  }

  if (toStatus === LEAD_STATUSES.INTERESTED) {
    lead.nextActionAt = lead.nextActionAt || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    activities.push(createTaskActivity(lead.id, "Lead interessato: proseguire trattativa o inviare preventivo.", lead.nextActionAt, actor));
  }

  if (toStatus === LEAD_STATUSES.NOT_INTERESTED || toStatus === LEAD_STATUSES.LOST) {
    lead.nextActionAt = null;
  }

  if (
    toStatus === LEAD_STATUSES.FIRST_DEPOSIT ||
    toStatus === LEAD_STATUSES.SECOND_DEPOSIT ||
    toStatus === LEAD_STATUSES.BALANCE_DUE
  ) {
    activities.push(
      createActivity({
        leadId: lead.id,
        type: "payment",
        text: `Aggiornamento pagamento: ${toStatus}.`,
        actor
      })
    );
  }

  if (toStatus === LEAD_STATUSES.SOLD) {
    activities.push(
      createTaskActivity(
        lead.id,
        "Inviare gadget e biglietti di viaggio.",
        new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
        actor
      )
    );
  }

  lead.updatedAt = now;
  return activities;
}
