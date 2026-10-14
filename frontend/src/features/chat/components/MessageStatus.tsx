import { Check, CheckCheck, CircleAlert, Clock, FlaskConical } from "lucide-react";
import { getMessageStatusMeta } from "../chat.logic";
import type { Message } from "../chat.types";

export function MessageStatus({ message }: { message: Pick<Message, "status" | "localState"> }) {
  const meta = getMessageStatusMeta(message);
  if (!meta) return null;
  const Icon =
    meta.tone === "pending"
      ? Clock
      : meta.tone === "failed"
        ? CircleAlert
        : meta.tone === "simulated"
          ? FlaskConical
          : meta.tone === "sent"
            ? Check
            : CheckCheck;
  return (
    <span className={`chat-msg-status ${meta.tone}`} title={meta.label}>
      <Icon size={14} aria-hidden="true" />
      <span className="sr-only">{meta.label}</span>
    </span>
  );
}
