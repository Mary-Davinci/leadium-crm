import { MessageCircle } from "lucide-react";

export function ChatEmptyState({ hasConversations }: { hasConversations: boolean }) {
  return (
    <div className="chat-empty-state">
      <span className="chat-empty-icon" aria-hidden="true">
        <MessageCircle size={28} />
      </span>
      <strong>{hasConversations ? "Seleziona una conversazione" : "Nessuna conversazione WhatsApp"}</strong>
      <span>
        {hasConversations
          ? "Scegli una chat dall'elenco per leggere i messaggi e rispondere al cliente."
          : "Le conversazioni compaiono qui quando un cliente scrive o quando avvii una chat dalla pratica."}
      </span>
    </div>
  );
}
