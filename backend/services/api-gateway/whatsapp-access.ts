import { AuthPublicUser } from "./auth-store";

// Who may open a WhatsApp conversation. Admins see everything; an operator sees the chats of the
// customers the admin assigned to them. A chat with no operator is not readable: it is announced
// by number only, and the first operator who answers the alert takes it.

export const CHAT_FORBIDDEN_MESSAGE = "Questa chat e assegnata a un altro operatore.";
export const CHAT_TAKEN_MESSAGE = "Un collega ha gia preso questa chat.";

type ChatConversation = { leadId?: string | null; assignedTo?: string | null; status?: string; replyWindowExpiresAt?: string | null };
type ChatUser = Pick<AuthPublicUser, "username" | "name" | "surname" | "email">;

const NO_OPERATOR = new Set(["", "automazione"]);
const normalize = (value: unknown) => String(value ?? "").trim().toLowerCase();

/** assignedTo holds the username; older records may hold the name, as in the Pratiche filters. */
export function identityKeys(user: ChatUser) {
  const fullName = `${user.name || ""} ${user.surname || ""}`;
  return new Set([user.username, user.name, user.email, fullName].map(normalize).filter(Boolean));
}

/** The practice's operator decides; the chat's own assignee counts only without one. */
export function chatOwner(conversation: ChatConversation, leadOwners: Map<string, string>) {
  const leadOwner = conversation.leadId ? String(leadOwners.get(String(conversation.leadId)) || "").trim() : "";
  if (leadOwner) return leadOwner;
  const assignee = String(conversation.assignedTo || "").trim();
  return NO_OPERATOR.has(normalize(assignee)) ? "" : assignee;
}

export function ownsChat(user: ChatUser, owner: string) {
  return Boolean(owner) && identityKeys(user).has(normalize(owner));
}

/** A customer who wrote, can still be answered freely, and whom nobody has taken yet. */
export function awaitsOperator(conversation: ChatConversation, owner: string, now: number) {
  if (owner || conversation.status === "resolved") return false;
  const windowEnd = Date.parse(String(conversation.replyWindowExpiresAt || ""));
  return Number.isFinite(windowEnd) && windowEnd > now;
}
