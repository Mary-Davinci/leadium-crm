import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ArrowLeft,
  CircleCheck,
  Copy,
  EllipsisVertical,
  ExternalLink,
  Hourglass,
  MessageSquareDot,
  PanelRight,
  RotateCcw,
  UserCheck,
  UserMinus
} from "lucide-react";
import { getAvatarLabel, getConversationStatusLabel, type ReplyWindowState } from "../chat.logic";
import type { Conversation } from "../chat.types";

type ChatHeaderProps = {
  conversation: Conversation;
  displayName: string;
  displayPhone: string;
  replyWindow: ReplyWindowState;
  authUsername: string;
  busy: boolean;
  infoOpen: boolean;
  hasLinkedPractice: boolean;
  onBack: () => void;
  onToggleInfo: () => void;
  onAssignToMe: () => void;
  onRelease: () => void;
  onMarkUnread: () => void;
  onSetStatus: (status: "open" | "waiting_customer" | "resolved") => void;
  onOpenPractice: () => void;
  onCopyPhone: () => void;
};

export function ChatHeader({
  conversation,
  displayName,
  displayPhone,
  replyWindow,
  authUsername,
  busy,
  infoOpen,
  hasLinkedPractice,
  onBack,
  onToggleInfo,
  onAssignToMe,
  onRelease,
  onMarkUnread,
  onSetStatus,
  onOpenPractice,
  onCopyPhone
}: ChatHeaderProps) {
  const assignee = String(conversation.assignedTo || "").trim();
  const assignedToMe = Boolean(authUsername) && assignee === authUsername;
  const resolved = conversation.status === "resolved";

  return (
    <header className="chat-header">
      <button type="button" className="chat-icon-button chat-back" onClick={onBack} aria-label="Torna alle conversazioni">
        <ArrowLeft size={19} aria-hidden="true" />
      </button>
      <span className="chat-avatar" aria-hidden="true">
        {getAvatarLabel(displayName, displayPhone)}
      </span>
      <div className="chat-header-identity">
        <h3 title={displayName}>{displayName}</h3>
        <div className="chat-header-sub">
          <span>{displayPhone}</span>
          <span className={`chat-window-chip ${replyWindow.open ? (replyWindow.urgent ? "urgent" : "open") : "closed"}`}>{replyWindow.label}</span>
          <span className={`chat-tag assignee ${assignee ? (assignedToMe ? "mine" : "other") : "unassigned"}`}>
            {assignee ? (assignedToMe ? "In carico a te" : `In carico a ${assignee}`) : "Da assegnare"}
          </span>
          {conversation.status && conversation.status !== "open" ? (
            <span className={`chat-tag status ${conversation.status}`}>{getConversationStatusLabel(conversation.status)}</span>
          ) : null}
        </div>
      </div>
      <div className="chat-header-actions">
        {!assignedToMe ? (
          <button type="button" className="chat-header-cta" onClick={onAssignToMe} disabled={busy || !authUsername}>
            <UserCheck size={15} aria-hidden="true" />
            <span>Prendi in carico</span>
          </button>
        ) : null}
        <button
          type="button"
          className="chat-icon-button"
          onClick={onOpenPractice}
          disabled={!hasLinkedPractice}
          aria-label="Apri pratica"
          title={hasLinkedPractice ? "Apri pratica" : "Nessuna pratica collegata"}
        >
          <ExternalLink size={18} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`chat-icon-button ${infoOpen ? "active" : ""}`}
          onClick={onToggleInfo}
          aria-label={infoOpen ? "Nascondi dettagli contatto" : "Mostra dettagli contatto"}
          aria-pressed={infoOpen}
        >
          <PanelRight size={18} aria-hidden="true" />
        </button>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button type="button" className="chat-icon-button" aria-label="Azioni conversazione" disabled={busy}>
              <EllipsisVertical size={18} aria-hidden="true" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="chat-menu" align="end" sideOffset={6}>
              {assignedToMe ? (
                <DropdownMenu.Item className="chat-menu-item" onSelect={onRelease}>
                  <UserMinus size={15} aria-hidden="true" /> Rilascia conversazione
                </DropdownMenu.Item>
              ) : (
                <DropdownMenu.Item className="chat-menu-item" onSelect={onAssignToMe} disabled={!authUsername}>
                  <UserCheck size={15} aria-hidden="true" /> {assignee ? "Prendi in carico (riassegna a te)" : "Assegna a me"}
                </DropdownMenu.Item>
              )}
              {assignee && !assignedToMe ? (
                <DropdownMenu.Item className="chat-menu-item" onSelect={onRelease}>
                  <UserMinus size={15} aria-hidden="true" /> Rimuovi assegnazione
                </DropdownMenu.Item>
              ) : null}
              <DropdownMenu.Item className="chat-menu-item" onSelect={onMarkUnread}>
                <MessageSquareDot size={15} aria-hidden="true" /> Segna come non letta
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="chat-menu-separator" />
              {conversation.status !== "waiting_customer" && !resolved ? (
                <DropdownMenu.Item className="chat-menu-item" onSelect={() => onSetStatus("waiting_customer")}>
                  <Hourglass size={15} aria-hidden="true" /> In attesa del cliente
                </DropdownMenu.Item>
              ) : null}
              {resolved ? (
                <DropdownMenu.Item className="chat-menu-item" onSelect={() => onSetStatus("open")}>
                  <RotateCcw size={15} aria-hidden="true" /> Riapri conversazione
                </DropdownMenu.Item>
              ) : (
                <DropdownMenu.Item className="chat-menu-item" onSelect={() => onSetStatus("resolved")}>
                  <CircleCheck size={15} aria-hidden="true" /> Segna come risolta
                </DropdownMenu.Item>
              )}
              {conversation.status === "waiting_customer" ? (
                <DropdownMenu.Item className="chat-menu-item" onSelect={() => onSetStatus("open")}>
                  <RotateCcw size={15} aria-hidden="true" /> Torna ad aperta
                </DropdownMenu.Item>
              ) : null}
              <DropdownMenu.Separator className="chat-menu-separator" />
              <DropdownMenu.Item className="chat-menu-item" onSelect={onOpenPractice} disabled={!hasLinkedPractice}>
                <ExternalLink size={15} aria-hidden="true" /> Apri pratica
              </DropdownMenu.Item>
              <DropdownMenu.Item className="chat-menu-item" onSelect={onCopyPhone} disabled={!displayPhone || displayPhone === "-"}>
                <Copy size={15} aria-hidden="true" /> Copia numero
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </header>
  );
}
