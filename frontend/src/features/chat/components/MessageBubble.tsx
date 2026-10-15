import { memo } from "react";
import { RotateCcw, Trash2 } from "lucide-react";
import { formatShortTime, tokenizeMessageText } from "../chat.logic";
import type { Message } from "../chat.types";
import { MessageAttachment } from "./MessageAttachment";
import { MessageStatus } from "./MessageStatus";

type MessageBubbleProps = {
  message: Message;
  localPreviewUrl?: string;
  onRetry?: (messageId: string) => void;
  onDiscard?: (messageId: string) => void;
  onOpenPractice?: () => void;
};

const MEDIA_PLACEHOLDER = /^\[(\w+)\]$/;
const MEDIA_LABELS: Record<string, string> = {
  image: "Immagine",
  document: "Documento",
  audio: "Messaggio vocale",
  video: "Video",
  sticker: "Sticker",
  location: "Posizione",
  contacts: "Contatto",
  reaction: "Reazione",
  unsupported: "Messaggio non supportato"
};

function getVisibleText(message: Message) {
  // With an attachment, the card already shows the file name: only a real caption is text.
  if (message.attachment) return message.attachment.caption || "";
  const placeholder = String(message.text || "").match(MEDIA_PLACEHOLDER);
  if (placeholder) return `${MEDIA_LABELS[placeholder[1]] || "Contenuto"} non visualizzabile in Leadium`;
  return message.text || "";
}

function MessageText({ text }: { text: string }) {
  return (
    <p className="chat-msg-text">
      {tokenizeMessageText(text).map((token, index) =>
        token.type === "link" ? (
          <a key={index} href={token.href} target="_blank" rel="noopener noreferrer">
            {token.value}
          </a>
        ) : (
          <span key={index}>{token.value}</span>
        )
      )}
    </p>
  );
}

export const MessageBubble = memo(function MessageBubble({ message, localPreviewUrl, onRetry, onDiscard, onOpenPractice }: MessageBubbleProps) {
  const outbound = message.direction === "outbound";
  const text = getVisibleText(message);
  const failed = message.localState === "failed";
  const deliveryFailed = !message.localState && message.status === "failed";
  const isTemplate = message.messageType === "template";

  return (
    <div className={`chat-msg-row ${outbound ? "out" : "in"}`}>
      <article className={`chat-msg ${outbound ? "out" : "in"} ${failed ? "failed" : ""} ${message.attachment ? "has-attachment" : ""}`}>
        {isTemplate ? <span className="chat-msg-tag">Template{message.templateName ? ` · ${message.templateName}` : ""}</span> : null}
        {message.attachment ? (
          <MessageAttachment
            messageId={message.id}
            attachment={message.attachment}
            localPreviewUrl={localPreviewUrl}
            onOpenPractice={onOpenPractice}
          />
        ) : null}
        {text ? <MessageText text={text} /> : null}
        <footer className="chat-msg-meta">
          {outbound && message.agentName ? <span className="chat-msg-agent">{message.agentName}</span> : null}
          <time dateTime={message.createdAt}>{formatShortTime(message.createdAt)}</time>
          {outbound ? <MessageStatus message={message} /> : null}
        </footer>
      </article>
      {failed ? (
        <div className="chat-msg-failure" role="alert">
          <span>{message.localError || "Messaggio non inviato."}</span>
          {onRetry ? (
            <button type="button" className="chat-link-button" onClick={() => onRetry(message.id)}>
              <RotateCcw size={13} aria-hidden="true" /> Riprova
            </button>
          ) : null}
          {onDiscard ? (
            <button type="button" className="chat-link-button muted" onClick={() => onDiscard(message.id)}>
              <Trash2 size={13} aria-hidden="true" /> Elimina
            </button>
          ) : null}
        </div>
      ) : null}
      {deliveryFailed ? (
        <div className="chat-msg-failure" role="status">
          <span>{message.statusError || "WhatsApp non ha consegnato il messaggio."}</span>
        </div>
      ) : null}
    </div>
  );
});
