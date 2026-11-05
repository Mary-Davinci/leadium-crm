export type TeamRow = {
  name: string; username: string; presence: "call" | "active" | "inactive";
  assigned: number; toContact: number; open: number; closed: number;
  done: number; todo: number; follow: number; followLate: number;
  chats: number; waiting: number; quotes: number; quotesOpen: number;
};

export type TeamDashboard = {
  generatedAt: string;
  totals: Omit<TeamRow, "name" | "username" | "presence"> & { unassigned: number };
  operators: TeamRow[];
};

export const PRESENCE_LABELS: Record<TeamRow["presence"], string> = {
  call: "In chiamata", active: "Attivo su Leadium", inactive: "Non attivo"
};

/** Only what needs a decision, most urgent first; a zero is not a problem to show. */
export function buildChecks(totals: TeamDashboard["totals"]) {
  return [
    { count: totals.unassigned, text: "Lead senza operatore: nessuno le sta lavorando", action: "Assegna", to: "/tasks" },
    { count: totals.quotesOpen, text: "Preventivi inviati senza un prossimo passo", action: "Apri elenco", to: "/pratiche" },
    { count: totals.waiting, text: "Clienti WhatsApp in attesa di risposta", action: "Apri chat", to: "/chat" },
    { count: totals.followLate, text: "Follow-up in ritardo", action: "Apri elenco", to: "/pratiche" }
  ].filter((item) => item.count > 0);
}
