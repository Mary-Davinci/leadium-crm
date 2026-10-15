export type CrmChatTarget = {
  id?: string | null;
  customerId?: string | null;
  phone?: string | null;
  fullName?: string | null;
};

// Every WhatsApp entry point routes to the internal CRM chat (Cloud API, tracked on the lead),
// never to wa.me / WhatsApp Web. The chat page resolves the conversation from these params and
// creates an empty one for the phone when none exists yet.
export function buildCrmChatPath(target: CrmChatTarget | null | undefined) {
  const params = new URLSearchParams();
  if (target?.customerId) params.set("customerId", target.customerId);
  if (target?.id) params.set("leadId", target.id);
  if (target?.phone) params.set("phone", target.phone);
  if (target?.fullName) params.set("customerName", target.fullName);
  const query = params.toString();
  return query ? `/chat?${query}` : "/chat";
}
