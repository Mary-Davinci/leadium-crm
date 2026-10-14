import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, Euro, FileText, Phone } from "lucide-react";
import { formatShortTime, type ThreadItem } from "../chat.logic";
import { MessageBubble } from "./MessageBubble";

type MessageThreadProps = {
  conversationId: string;
  items: ThreadItem[];
  loading: boolean;
  localPreviews: Record<string, string>;
  onRetry: (messageId: string) => void;
  onDiscard: (messageId: string) => void;
  onOpenPractice?: () => void;
};

const MARKER_ICONS = { call: Phone, document: FileText, payment: Euro };
// How close to the bottom (px) still counts as "reading the latest messages".
const STICK_TO_BOTTOM_PX = 120;

export function MessageThread({ conversationId, items, loading, localPreviews, onRetry, onDiscard, onOpenPractice }: MessageThreadProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const lastKey = items.length ? items[items.length - 1].key : "";

  function scrollToBottom() {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
    stickToBottom.current = true;
    setShowJump(false);
  }

  // Opening another conversation always starts at its latest message.
  useLayoutEffect(() => {
    stickToBottom.current = true;
    scrollToBottom();
  }, [conversationId]);

  // New messages only pull the view down if the operator was already at the bottom; otherwise
  // they'd lose their place while reading history, so offer a jump button instead.
  useEffect(() => {
    if (stickToBottom.current) scrollToBottom();
    else setShowJump(true);
  }, [lastKey]);

  function onScroll() {
    const node = scrollRef.current;
    if (!node) return;
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < STICK_TO_BOTTOM_PX;
    stickToBottom.current = atBottom;
    if (atBottom) setShowJump(false);
  }

  return (
    <div className="chat-thread-wrap">
      <div className="chat-thread" ref={scrollRef} onScroll={onScroll} role="log" aria-live="polite" aria-label="Messaggi della conversazione">
        {loading && !items.length ? (
          <div className="chat-thread-loading" aria-hidden="true">
            <span className="chat-skeleton bubble in" />
            <span className="chat-skeleton bubble out" />
            <span className="chat-skeleton bubble in short" />
          </div>
        ) : null}
        {!loading && !items.length ? (
          <div className="chat-thread-empty">
            <strong>Nessun messaggio</strong>
            <span>Scrivi il primo messaggio o invia un template per avviare la conversazione.</span>
          </div>
        ) : null}
        {items.map((item) => {
          if (item.type === "day") {
            return (
              <div key={item.key} className="chat-day-separator">
                <span>{item.label}</span>
              </div>
            );
          }
          if (item.type === "marker") {
            const Icon = MARKER_ICONS[item.marker.icon];
            return (
              <div key={item.key} className="chat-op-marker">
                <Icon size={13} aria-hidden="true" />
                <span>{item.marker.label}</span>
                <time dateTime={item.marker.createdAt}>{formatShortTime(item.marker.createdAt)}</time>
              </div>
            );
          }
          return (
            <MessageBubble
              key={item.key}
              message={item.message}
              localPreviewUrl={localPreviews[item.message.id]}
              onRetry={onRetry}
              onDiscard={onDiscard}
              onOpenPractice={onOpenPractice}
            />
          );
        })}
      </div>
      {showJump ? (
        <button type="button" className="chat-jump-latest" onClick={scrollToBottom} aria-label="Vai agli ultimi messaggi">
          <ArrowDown size={18} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
