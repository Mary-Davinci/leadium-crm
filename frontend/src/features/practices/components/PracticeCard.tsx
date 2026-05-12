import { useEffect, useRef } from "react";
import { Lead } from "../pratiche.types";
import { CrmTask } from "../../../store/crm-store";
import {
  getNextActionMeta,
  getPriority,
  getSuggestedAction,
  urgencyLabels
} from "../pratiche.utils";

export type PracticeCardProps = {
  lead: Lead;
  linkedTask?: CrmTask | null;
  isSelected: boolean;
  isBusy: boolean;
  onSelect: (id: string) => void;
  onPrefetchDetail?: (id: string) => void;
  onOpen: (id: string) => void;
  onStartCall: (lead: Lead) => void;
  onRegisterCall: (lead: Lead) => void;
  onWrite: (lead: Lead) => void;
  onQuickTask: (lead: Lead) => void;
  onStatusChange: (leadId: string, status: string) => void;
  onAssign: (lead: Lead) => void;
  onMarkUrgent: (lead: Lead) => void;
  onSuggestedAction: (lead: Lead, kind: "call" | "open" | "task") => void;
  availableStatuses?: string[];
};

type MetaVisual = {
  label: string;
  meta: string;
  tone: "contact" | "action" | "due";
  icon: "phone" | "whatsapp" | "message" | "form" | "calendar" | "task";
};

function CellIcon({ kind }: { kind: MetaVisual["icon"] }) {
  if (kind === "phone") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M4.2 1.8c.4-.4 1-.5 1.5-.2l1.5.9c.5.3.7.9.5 1.4l-.5 1.3c.7 1.4 1.8 2.5 3.2 3.2l1.3-.5c.5-.2 1.1 0 1.4.5l.9 1.5c.3.5.2 1.1-.2 1.5l-1 1c-.5.5-1.2.7-1.9.5C6.6 13.1 2.9 9.4 1.9 4.7c-.2-.7 0-1.4.5-1.9l1-1Z" />
      </svg>
    );
  }
  if (kind === "whatsapp") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 1.5a6 6 0 0 0-5.2 9l-.7 3 3-.8A6 6 0 1 0 8 1.5Zm0 1.3a4.7 4.7 0 1 1 0 9.4c-.7 0-1.4-.2-2-.5l-.3-.2-1.8.5.5-1.8-.2-.3a4.7 4.7 0 0 1 3.8-7.1Zm-1.5 2c-.2 0-.4.1-.5.3-.2.2-.6.6-.6 1.4s.6 1.7.7 1.8c.1.1 1.2 1.9 3 2.5 1.4.6 1.7.4 2 .4.3 0 1-.4 1.1-.8.1-.4.1-.8 0-.8l-.7-.3c-.2-.1-.4-.1-.5.1l-.4.5c-.1.1-.2.2-.4.1-.2-.1-.8-.3-1.5-1-.6-.5-1-1.2-1.1-1.4-.1-.2 0-.3.1-.4l.3-.3.2-.4c.1-.1 0-.3 0-.4l-.3-.8c-.1-.2-.2-.5-.4-.5Z" />
      </svg>
    );
  }
  if (kind === "message") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M3 3.5h10c.8 0 1.5.7 1.5 1.5v5c0 .8-.7 1.5-1.5 1.5H8.2l-2.6 1.8c-.5.3-1.1 0-1.1-.6v-1.2H3c-.8 0-1.5-.7-1.5-1.5V5C1.5 4.2 2.2 3.5 3 3.5Z" />
      </svg>
    );
  }
  if (kind === "form") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M4 2.5h6l2 2V13c0 .8-.7 1.5-1.5 1.5h-6C3.7 14.5 3 13.8 3 13V4c0-.8.7-1.5 1.5-1.5Zm5.5 0V5H12" />
        <path d="M5.5 7.2h5M5.5 9.2h5M5.5 11.2h3.2" />
      </svg>
    );
  }
  if (kind === "calendar") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M5 1.8v1.7M11 1.8v1.7M3 4h10c.8 0 1.5.7 1.5 1.5V12c0 .8-.7 1.5-1.5 1.5H3c-.8 0-1.5-.7-1.5-1.5V5.5C1.5 4.7 2.2 4 3 4Zm0 2.3h10" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 2.5h10c.8 0 1.5.7 1.5 1.5v8c0 .8-.7 1.5-1.5 1.5H3c-.8 0-1.5-.7-1.5-1.5V4C1.5 3.2 2.2 2.5 3 2.5Zm2 3h6M5 8h6M5 10.5h4" />
    </svg>
  );
}

function getRelativeTimeLabel(value?: string | null) {
  if (!value) return "Da contattare";
  const date = new Date(value);
  const diffMinutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
  if (diffMinutes < 60) return `${diffMinutes} minuti fa`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} ore fa`;
  const diffDays = Math.round(diffHours / 24);
  if (diffDays === 1) return "Ieri";
  return `${diffDays}g fa`;
}

function formatDueShort(value?: string) {
  if (!value) return "Da pianificare";
  const date = new Date(value);
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayLabel =
    target === new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
      ? "Oggi"
      : target === tomorrow
        ? "Domani"
        : date.toLocaleDateString("it-IT");

  return `${dayLabel}, ${date.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}`;
}

function getDueDeltaLabel(value?: string) {
  if (!value) return "SLA: da definire";
  const date = new Date(value);
  const diffMinutes = Math.round((date.getTime() - Date.now()) / 60000);
  const prefix = diffMinutes < 0 ? "SLA: -" : "SLA: ";
  const absMinutes = Math.abs(diffMinutes);
  if (absMinutes < 60) return `${prefix}${absMinutes}m`;
  const hours = Math.round(absMinutes / 60);
  if (hours < 24) return `${prefix}${hours}h`;
  const days = Math.round(hours / 24);
  return `${prefix}${days}g`;
}

function getAssigneeInitials(value?: string) {
  const source = String(value || "NA")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((item) => item[0]?.toUpperCase() || "")
    .join("");
  return source || "NA";
}

function getAssigneeShortName(value?: string) {
  const parts = String(value || "Non assegnato").split(" ").filter(Boolean);
  if (parts.length <= 1) return parts[0] || "Non assegnato";
  return `${parts[0]} ${parts[1][0] || ""}.`;
}

function getLastContactVisual(lead: Lead): MetaVisual {
  const source = String(lead.source || "").toLowerCase();
  if (lead.latestCallOutcome === "no_answer") {
    return { label: "Chiamata persa", meta: getRelativeTimeLabel(lead.latestCallAt), tone: "contact", icon: "phone" };
  }
  if (lead.latestCallOutcome) {
    return { label: "Chiamata", meta: getRelativeTimeLabel(lead.latestCallAt), tone: "contact", icon: "phone" };
  }
  if (source.includes("whatsapp")) {
    return { label: "WhatsApp", meta: "Messaggio recente", tone: "contact", icon: "whatsapp" };
  }
  if (source.includes("web") || source.includes("modulo")) {
    return { label: "Modulo web", meta: "Nuova richiesta", tone: "contact", icon: "form" };
  }
  return { label: "Messaggio", meta: "25 minuti fa", tone: "contact", icon: "message" };
}

function getNextActionVisual(label: string, meta: string): MetaVisual {
  const normalized = label.toLowerCase();
  const icon = normalized.includes("richiam") || normalized.includes("chiam")
    ? "calendar"
    : normalized.includes("follow") || normalized.includes("aggiorn")
      ? "task"
      : "calendar";
  return { label, meta, tone: "action", icon };
}

function getDueVisual(label: string, meta: string): MetaVisual {
  return { label, meta, tone: "due", icon: "calendar" };
}

export function PracticeCard({
  lead,
  linkedTask,
  isSelected,
  isBusy: _isBusy,
  onSelect,
  onPrefetchDetail,
  onOpen,
  onStartCall: _onStartCall,
  onRegisterCall: _onRegisterCall,
  onWrite: _onWrite,
  onQuickTask: _onQuickTask,
  onStatusChange: _onStatusChange,
  onAssign: _onAssign,
  onMarkUrgent: _onMarkUrgent,
  onSuggestedAction: _onSuggestedAction,
  availableStatuses: _availableStatuses = []
}: PracticeCardProps) {
  const priority = getPriority(lead);
  const nextMeta = getNextActionMeta(lead.nextActionAt);
  const suggestedAction = getSuggestedAction(lead);
  const linkedTaskDueText = linkedTask?.dueAt ? new Date(linkedTask.dueAt).toLocaleString("it-IT") : "Da pianificare";
  const hasHighPriorityTask = Boolean(linkedTask && linkedTask.status !== "done" && linkedTask.priority >= 80);
  const linkedTaskKindText = linkedTask
    ? linkedTask.kind.includes("payment") || linkedTask.kind.includes("saldo")
      ? "Conferma pagamento"
      : linkedTask.kind.includes("document")
        ? "Inviare dettagli"
        : linkedTask.kind.includes("call") || linkedTask.kind.includes("richiamo")
          ? "Richiamare"
          : linkedTask.kind.includes("follow")
            ? "Follow up"
            : linkedTask.kind.includes("next_action")
              ? "Aggiornamento"
              : "Task operativo"
    : "";
  const nextActionLabel = linkedTask ? `${linkedTaskKindText}` : suggestedAction.label;
  const nextActionMeta = linkedTask ? linkedTask.title : nextMeta.dateText;
  const dueValue = linkedTask?.dueAt || lead.nextActionAt;
  const dueLabel = dueValue ? formatDueShort(dueValue) : "Da pianificare";
  const dueMeta = getDueDeltaLabel(dueValue);
  const assigneeName = lead.assignedTo || "Non assegnato";
  const lastContact = getLastContactVisual(lead);
  const nextAction = getNextActionVisual(nextActionLabel, nextActionMeta);
  const dueInfo = getDueVisual(dueLabel, dueMeta);
  const clickTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (clickTimerRef.current) {
        window.clearTimeout(clickTimerRef.current);
      }
    };
  }, []);

  function handleClick() {
    if (clickTimerRef.current) {
      window.clearTimeout(clickTimerRef.current);
    }
    clickTimerRef.current = window.setTimeout(() => {
      onSelect(lead.id);
      clickTimerRef.current = null;
    }, 220);
  }

  function handleDoubleClick() {
    if (clickTimerRef.current) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    onOpen(lead.id);
  }

  return (
    <article
      className={`pr-row-card ${isSelected ? "active" : ""} ${hasHighPriorityTask ? "priority-glow" : ""}`}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onMouseEnter={() => onPrefetchDetail?.(lead.id)}
    >
      <div className="pr-row-grid">
        <div className="pr-cell pr-cell-priority">
          <span className={`pr-priority-dot pr-priority-dot-${priority}`} aria-hidden="true" />
          <div className="pr-cell-stack">
            <strong className={`pr-priority-label pr-priority-label-${priority}`}>{urgencyLabels[priority]}</strong>
          </div>
        </div>

        <div className="pr-cell pr-cell-client">
          <span className="pr-client-link">
            {lead.fullName}
          </span>
          <div className="pr-cell-stack">
            <span>{lead.phone || "-"}</span>
          </div>
        </div>

        <div className={`pr-cell pr-cell-meta pr-cell-tone-${lastContact.tone}`}>
          <span className={`pr-meta-icon pr-meta-icon-${lastContact.tone}`}>
            <CellIcon kind={lastContact.icon} />
          </span>
          <div className="pr-cell-stack">
            <strong>{lastContact.label}</strong>
            <span>{lastContact.meta}</span>
          </div>
        </div>

        <div className={`pr-cell pr-cell-text pr-cell-tone-${nextAction.tone}`}>
          <div className="pr-cell-stack">
            <strong>{nextAction.label}</strong>
            <span>{nextAction.meta}</span>
          </div>
        </div>

        <div className={`pr-cell pr-cell-text pr-cell-tone-${dueInfo.tone}`}>
          <div className="pr-cell-stack">
            <strong>{dueInfo.label}</strong>
          </div>
        </div>

        <div className="pr-cell pr-cell-assigned">
          <div className="pr-assignee">
            <span className="pr-assignee-name">{getAssigneeShortName(assigneeName)}</span>
          </div>
        </div>
      </div>
    </article>
  );
}
