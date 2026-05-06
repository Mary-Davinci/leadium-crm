import { useEffect, useRef, useState } from "react";
import { Lead } from "../pratiche.types";
import { CrmTask } from "../../../store/crm-store";
import {
  getCallOutcomeClass,
  getCallOutcomeLabel,
  getMissingDocumentsCount,
  getNextActionMeta,
  getPriority,
  getStatusClass,
  getStatusLabel,
  getSuggestedAction,
  getTravelLabel,
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

export function PracticeCard({
  lead,
  linkedTask,
  isSelected,
  isBusy,
  onSelect,
  onPrefetchDetail,
  onOpen,
  onStartCall,
  onRegisterCall,
  onWrite,
  onQuickTask,
  onStatusChange,
  onAssign,
  onMarkUrgent,
  onSuggestedAction,
  availableStatuses = []
}: PracticeCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const priority = getPriority(lead);
  const missingDocumentsCount = getMissingDocumentsCount(lead);
  const nextMeta = getNextActionMeta(lead.nextActionAt);
  const suggestedAction = getSuggestedAction(lead);
  const linkedTaskDueText = linkedTask?.dueAt ? new Date(linkedTask.dueAt).toLocaleString("it-IT") : "Da pianificare";
  const hasHighPriorityTask = Boolean(linkedTask && linkedTask.status !== "done" && linkedTask.priority >= 80);
  const linkedTaskKindText = linkedTask
    ? linkedTask.kind.includes("payment") || linkedTask.kind.includes("saldo")
      ? "Pagamento"
      : linkedTask.kind.includes("document")
        ? "Documenti"
        : linkedTask.kind.includes("call") || linkedTask.kind.includes("richiamo")
          ? "Richiamo"
          : linkedTask.kind.includes("follow")
            ? "Follow-up"
            : linkedTask.kind.includes("next_action")
              ? "Task principale"
              : "Task operativo"
    : "";

  useEffect(() => {
    if (!menuOpen) return;

    function handleClickOutside(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [menuOpen]);

  return (
    <article
      className={`pr-row-card ${isSelected ? "active" : ""} ${hasHighPriorityTask ? "priority-glow" : ""}`}
      onClick={() => onSelect(lead.id)}
      onMouseEnter={() => onPrefetchDetail?.(lead.id)}
    >
      <div className="pr-row-head">
        <div className="pr-row-client">
          <button
            type="button"
            className="pr-client-link"
            onClick={(event) => {
              event.stopPropagation();
              onSelect(lead.id);
            }}
          >
            {lead.fullName}
          </button>
          <p className="pr-row-meta">
            {lead.phone || "-"} · {getTravelLabel(lead)}
          </p>
          {lead.latestCallOutcome ? (
            <div className="pr-call-summary">
              <span className={`pr-call-badge ${getCallOutcomeClass(lead.latestCallOutcome)}`}>
                📞 {getCallOutcomeLabel(lead.latestCallOutcome)}
              </span>
              {lead.latestCallAt ? <small>{new Date(lead.latestCallAt).toLocaleString("it-IT")}</small> : null}
            </div>
          ) : null}
        </div>

        <div className="pr-row-controls" onClick={(event) => event.stopPropagation()}>
          <div className="pr-row-badges">
            <span className={`pr-status ${getStatusClass(lead.status)}`}>{getStatusLabel(lead.status)}</span>
            <span className={`pr-priority pr-priority-${priority}`}>{urgencyLabels[priority]} priorità</span>
          </div>
          <div className="pr-actions">
            <button
              type="button"
              className="primary"
              disabled={isBusy}
              onClick={(event) => {
                event.stopPropagation();
                onOpen(lead.id);
              }}
            >
              Apri
            </button>
            <button
              type="button"
              className="secondary"
              disabled={isBusy}
              onClick={(event) => {
                event.stopPropagation();
                onStartCall(lead);
              }}
            >
              Chiama
            </button>
            <button
              type="button"
              className="secondary"
              disabled={isBusy}
              onClick={(event) => {
                event.stopPropagation();
                onWrite(lead);
              }}
            >
              Scrivi
            </button>

            <div className={`pr-more-menu ${menuOpen ? "open" : ""}`} ref={menuRef}>
              <button
                type="button"
                className="pr-more-trigger"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={(event) => {
                  event.stopPropagation();
                  setMenuOpen((current) => !current);
                }}
              >
                ...
              </button>
              <div className="pr-more-pop" role="menu">
                <div className="pr-more-group">
                  <span className="pr-more-group-label">Suggerita</span>
                  <button
                    type="button"
                    className="secondary recommended"
                    disabled={isBusy}
                    onClick={() => {
                      setMenuOpen(false);
                      onSuggestedAction(lead, suggestedAction.kind);
                    }}
                  >
                    {suggestedAction.label}
                  </button>
                </div>

                <div className="pr-more-divider" />

                <div className="pr-more-group">
                  <span className="pr-more-group-label">Operativo</span>
                  <button
                    type="button"
                    className="secondary"
                    disabled={isBusy}
                    onClick={() => {
                      setMenuOpen(false);
                      onRegisterCall(lead);
                    }}
                  >
                    Registra chiamata
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={isBusy}
                    onClick={() => {
                      setMenuOpen(false);
                      onQuickTask(lead);
                    }}
                  >
                    Crea task
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={isBusy}
                    onClick={() => {
                      setMenuOpen(false);
                      onAssign(lead);
                    }}
                  >
                    Assegna
                  </button>
                </div>

                <div className="pr-more-divider" />

                <div className="pr-more-group">
                  <span className="pr-more-group-label">Priorità</span>
                  <button
                    type="button"
                    className="secondary danger"
                    disabled={isBusy}
                    onClick={() => {
                      setMenuOpen(false);
                      onMarkUrgent(lead);
                    }}
                  >
                    Segna urgente
                  </button>
                </div>

                <div className="pr-more-divider" />

                <div className="pr-more-group">
                  <span className="pr-more-group-label">Navigazione e stato</span>
                  <button
                    type="button"
                    className="secondary"
                    disabled={isBusy}
                    onClick={() => {
                      setMenuOpen(false);
                      onOpen(lead.id);
                    }}
                  >
                    Apri dettaglio completo
                  </button>
                  {availableStatuses.length ? (
                    <select
                      defaultValue=""
                      onChange={(event) => {
                        if (!event.target.value) return;
                        setMenuOpen(false);
                        onStatusChange(lead.id, event.target.value);
                        event.target.value = "";
                      }}
                    >
                      <option value="">Cambia stato</option>
                      {availableStatuses.map((status) => (
                        <option key={status} value={status}>
                          {status}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="pr-flow-closed">Flusso chiuso</span>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {linkedTask ? (
        <div className={`pr-next-action pr-task-action ${hasHighPriorityTask ? "priority-glow-soft" : ""}`}>
          <strong>{linkedTaskKindText}: {linkedTask.title}</strong>
          <span>Scadenza task: {linkedTaskDueText}</span>
        </div>
      ) : (
        <div className={`pr-next-action ${nextMeta.className}`}>
          <strong>{nextMeta.label}</strong>
          <span>{nextMeta.dateText}</span>
        </div>
      )}

      <p className="pr-row-note">{lead.notes?.trim() || "Nessuna nota operativa disponibile."}</p>

      <div className="pr-row-foot" onClick={(event) => event.stopPropagation()}>
        <span className="pr-assigned">Assegnato: {lead.assignedTo || "me"}</span>
      </div>
    </article>
  );
}

