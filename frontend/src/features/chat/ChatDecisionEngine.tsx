import { useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { CalendarClock, ChevronDown, EllipsisVertical, ExternalLink, Phone, X } from "lucide-react";
import { buildPracticeUrl } from "../practices/practice-links";
import { CrmTask } from "../../store/crm-store";
import { getAvatarLabel, getConversationStatusLabel } from "./chat.logic";
import type { TimelineItem } from "./chat.types";
import {
  DecisionDocument as PracticeDocument,
  DecisionLead as ChatDecisionLead,
  DecisionPayment as Payment,
  getDecisionSnapshot,
  getPaymentVisualStatus,
  getTaskDueLane,
  sortOperationalTasks
} from "./ChatDecisionEngine.logic";

export type { ChatDecisionLead, Payment, PracticeDocument };
export { getTaskDueLane, sortOperationalTasks };

export type ChatDecisionConversation = {
  leadId?: string | null;
  customerName?: string;
  phone?: string;
  assignedTo?: string;
  status?: string;
};

type ChatDecisionEngineProps = {
  lead: ChatDecisionLead | null;
  selectedConversation: ChatDecisionConversation | null;
  openTasks: CrmTask[];
  timeline: TimelineItem[];
  leadLoading: boolean;
  leadError: string;
  authUsername: string;
  actionBusyKey: string;
  completedActionKey: string;
  onClose: () => void;
  onCallCustomer: () => void;
  onRequestDocuments: () => void;
  onRequestPaymentReminder: () => void;
  onScheduleCallback: (payload: { followUpAt: string; callbackReason: string }) => void;
  callbackScheduling: boolean;
  onMarkDocumentReceived: (documentId: string) => void;
  onMarkPaymentReceived: (paymentId: string) => void;
  onVerifyPayment: (paymentId: string) => void;
  onCompleteTask: (taskId: string) => void;
  onPostponeTaskOneDay: (taskId: string) => void;
  // WhatsApp opt-out / follow-up state, shown right under the contact so it is never missed.
  automationSection?: ReactNode;
};

function formatEuroAmount(value: number) {
  return new Intl.NumberFormat("it-IT", { maximumFractionDigits: 0 }).format(value);
}

function formatTimelineDate(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleString("it-IT", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function getRelatedOpenTask(openTasks: CrmTask[], terms: string[]) {
  return openTasks.find((task) => {
    const haystack = `${task.kind || ""} ${task.title || ""} ${task.description || ""}`.toLowerCase();
    return terms.some((term) => haystack.includes(term));
  });
}

function actionLabel(key: string, busyKey: string, completedKey: string, idle: string, busy: string, done: string) {
  if (completedKey === key) return done;
  if (busyKey === key) return busy;
  return idle;
}

export function ChatDecisionEngine({
  lead,
  selectedConversation,
  openTasks,
  timeline,
  leadLoading,
  leadError,
  authUsername,
  actionBusyKey,
  completedActionKey,
  onClose,
  onCallCustomer,
  onRequestDocuments,
  onRequestPaymentReminder,
  onScheduleCallback,
  callbackScheduling,
  onMarkDocumentReceived,
  onMarkPaymentReceived,
  onVerifyPayment,
  onCompleteTask,
  onPostponeTaskOneDay,
  automationSection
}: ChatDecisionEngineProps) {
  const navigate = useNavigate();
  const decision = useMemo(() => getDecisionSnapshot(lead, openTasks), [lead, openTasks]);
  const [paymentsOpen, setPaymentsOpen] = useState(true);
  const [documentsOpen, setDocumentsOpen] = useState(false);
  const [callbackFormOpen, setCallbackFormOpen] = useState(false);
  const [callbackDate, setCallbackDate] = useState("");
  const [callbackReasonDraft, setCallbackReasonDraft] = useState("");
  const { pendingPayments, pendingPaymentAmount, missingDocuments, missingDocumentsCount, paymentProgress, recommendedAction } = decision;
  const recentTimeline = useMemo(
    () => [...timeline].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 5),
    [timeline]
  );
  const busy = Boolean(actionBusyKey);
  const documentTask = getRelatedOpenTask(openTasks, ["document", "doc"]);
  const name = lead?.fullName || selectedConversation?.customerName || "-";
  const phone = lead?.phone || selectedConversation?.phone || "";
  const assignee = String(selectedConversation?.assignedTo || "").trim();

  function submitCallbackForm() {
    if (!callbackDate || !callbackReasonDraft.trim()) return;
    onScheduleCallback({ followUpAt: callbackDate, callbackReason: callbackReasonDraft.trim() });
    setCallbackFormOpen(false);
    setCallbackDate("");
    setCallbackReasonDraft("");
  }

  return (
    <aside className="chat-info" aria-label="Dettagli contatto e pratica">
      <header className="chat-info-head">
        <h3>Dettagli contatto</h3>
        <button type="button" className="chat-icon-button" onClick={onClose} aria-label="Chiudi dettagli">
          <X size={18} aria-hidden="true" />
        </button>
      </header>

      <div className="chat-info-scroll">
        <section className="chat-info-contact">
          <span className="chat-avatar large" aria-hidden="true">
            {getAvatarLabel(name, phone)}
          </span>
          <strong>{name}</strong>
          {phone ? <span>{phone}</span> : null}
          {lead?.email ? <span>{lead.email}</span> : null}
          <dl className="chat-info-facts">
            <div>
              <dt>Assegnata a</dt>
              <dd>{assignee ? (assignee === authUsername ? "Te" : assignee) : "Nessuno"}</dd>
            </div>
            <div>
              <dt>Stato chat</dt>
              <dd>{getConversationStatusLabel(selectedConversation?.status)}</dd>
            </div>
          </dl>
        </section>

        {automationSection}

        <section className="chat-info-section">
          <h4>Pratica collegata</h4>
          {lead ? (
            <div className="chat-info-practice">
              <div>
                <span className="chat-info-practice-status">{lead.status || "Stato non indicato"}</span>
                <span className="chat-info-practice-blockers">
                  {pendingPayments.length || missingDocumentsCount
                    ? [
                        pendingPayments.length ? `${pendingPayments.length} pagamenti in sospeso` : "",
                        missingDocumentsCount ? `${missingDocumentsCount} documenti mancanti` : ""
                      ]
                        .filter(Boolean)
                        .join(" · ")
                    : "Nessun blocco aperto"}
                </span>
              </div>
              <button type="button" className="chat-secondary-button" onClick={() => navigate(buildPracticeUrl(lead.id, "overview"))}>
                <ExternalLink size={14} aria-hidden="true" /> Apri pratica
              </button>
            </div>
          ) : leadLoading ? (
            <span className="chat-skeleton line" aria-label="Caricamento pratica" />
          ) : (
            <p className="chat-info-muted">Nessuna pratica collegata. Il collegamento avviene in automatico dal numero al prossimo messaggio.</p>
          )}
          {leadError ? (
            <p className="chat-inline-alert error" role="alert">
              {leadError}
            </p>
          ) : null}
        </section>

        {lead && recommendedAction ? (
          <section className="chat-info-section chat-info-next">
            <h4>Prossima azione consigliata</h4>
            <strong>{recommendedAction.label}</strong>
            <p>{recommendedAction.detail}</p>
            <div className="chat-info-actions">
              {recommendedAction.kind === "payment" ? (
                <>
                  <button type="button" className="chat-secondary-button" onClick={onRequestPaymentReminder}>
                    Prepara sollecito
                  </button>
                  <button type="button" className="chat-primary-button" disabled={busy} onClick={() => onMarkPaymentReceived(recommendedAction.payment.id)}>
                    {actionLabel(`payment-received:${recommendedAction.payment.id}`, actionBusyKey, completedActionKey, "Segna ricevuto", "Salvataggio...", "Ricevuto")}
                  </button>
                </>
              ) : recommendedAction.kind === "document" ? (
                <>
                  <button type="button" className="chat-secondary-button" onClick={onRequestDocuments}>
                    Richiedi documenti
                  </button>
                  <button type="button" className="chat-primary-button" disabled={busy} onClick={() => onMarkDocumentReceived(recommendedAction.document.key)}>
                    {actionLabel(`document:${recommendedAction.document.key}`, actionBusyKey, completedActionKey, "Segna ricevuto", "Salvataggio...", "Ricevuto")}
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="chat-secondary-button" disabled={busy} onClick={() => onPostponeTaskOneDay(recommendedAction.task.id)}>
                    {actionBusyKey === `task-snooze:${recommendedAction.task.id}` ? "Rinvio..." : "+1 giorno"}
                  </button>
                  <button type="button" className="chat-primary-button" disabled={busy} onClick={() => onCompleteTask(recommendedAction.task.id)}>
                    {actionBusyKey === `task:${recommendedAction.task.id}` ? "Salvataggio..." : "Completa task"}
                  </button>
                </>
              )}
            </div>
          </section>
        ) : null}

        {lead && pendingPayments.length ? (
          <section className="chat-info-section">
            <button type="button" className="chat-info-toggle" onClick={() => setPaymentsOpen((open) => !open)} aria-expanded={paymentsOpen}>
              <h4>
                Pagamenti in sospeso <span className="chat-count">{pendingPayments.length}</span>
              </h4>
              {pendingPaymentAmount > 0 ? <span className="chat-info-amount">EUR {formatEuroAmount(pendingPaymentAmount)}</span> : null}
              <ChevronDown size={16} aria-hidden="true" className={paymentsOpen ? "open" : ""} />
            </button>
            {paymentProgress.totalAmount > 0 ? (
              <div
                className="chat-progress"
                role="img"
                aria-label={`Pagamenti verificati: ${formatEuroAmount(paymentProgress.verifiedAmount)} su ${formatEuroAmount(paymentProgress.totalAmount)} euro`}
              >
                <span style={{ width: `${paymentProgress.percent}%` }} />
              </div>
            ) : null}
            {paymentsOpen ? (
              <ul className="chat-info-list">
                {pendingPayments.slice(0, 3).map((payment) => {
                  const status = getPaymentVisualStatus(payment);
                  const paymentTask = getRelatedOpenTask(openTasks, ["payment", "pagament", "saldo", "acconto"]);
                  return (
                    <li key={payment.id}>
                      <div className="chat-info-item-copy">
                        <strong>
                          {payment.label || payment.id}
                          {payment.amount ? ` · EUR ${formatEuroAmount(payment.amount)}` : ""}
                        </strong>
                        <span className={`chat-status-chip ${status.tone}`}>{status.label}</span>
                      </div>
                      {payment.status !== "received" ? (
                        <button type="button" className="chat-secondary-button small" disabled={busy} onClick={() => onMarkPaymentReceived(payment.id)}>
                          {actionLabel(`payment-received:${payment.id}`, actionBusyKey, completedActionKey, "Ricevuto", "...", "Fatto")}
                        </button>
                      ) : null}
                      <DropdownMenu.Root>
                        <DropdownMenu.Trigger asChild>
                          <button type="button" className="chat-icon-button small" aria-label={`Altre azioni per ${payment.label || "pagamento"}`}>
                            <EllipsisVertical size={15} aria-hidden="true" />
                          </button>
                        </DropdownMenu.Trigger>
                        <DropdownMenu.Portal>
                          <DropdownMenu.Content className="chat-menu" align="end" sideOffset={4}>
                            <DropdownMenu.Item className="chat-menu-item" disabled={busy} onSelect={() => onVerifyPayment(payment.id)}>
                              Segna verificato
                            </DropdownMenu.Item>
                            <DropdownMenu.Item className="chat-menu-item" disabled={busy || !paymentTask} onSelect={() => paymentTask && onPostponeTaskOneDay(paymentTask.id)}>
                              Rimanda follow-up di 1 giorno
                            </DropdownMenu.Item>
                            <DropdownMenu.Item className="chat-menu-item" onSelect={() => navigate(buildPracticeUrl(lead.id, "payments", { payment: payment.id }))}>
                              Apri nella pratica
                            </DropdownMenu.Item>
                          </DropdownMenu.Content>
                        </DropdownMenu.Portal>
                      </DropdownMenu.Root>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </section>
        ) : null}

        {lead && missingDocumentsCount ? (
          <section className="chat-info-section">
            <button type="button" className="chat-info-toggle" onClick={() => setDocumentsOpen((open) => !open)} aria-expanded={documentsOpen}>
              <h4>
                Documenti mancanti <span className="chat-count">{missingDocumentsCount}</span>
              </h4>
              <ChevronDown size={16} aria-hidden="true" className={documentsOpen ? "open" : ""} />
            </button>
            {documentsOpen ? (
              <ul className="chat-info-list">
                {missingDocuments.slice(0, 4).map((document) => (
                  <li key={document.key}>
                    <div className="chat-info-item-copy">
                      <strong>{document.label || document.key}</strong>
                      <span className="chat-status-chip warning">{document.received ? "DA VERIFICARE" : "MANCANTE"}</span>
                    </div>
                    <button type="button" className="chat-secondary-button small" disabled={busy} onClick={() => onMarkDocumentReceived(document.key)}>
                      {actionLabel(`document:${document.key}`, actionBusyKey, completedActionKey, "Ricevuto", "...", "Fatto")}
                    </button>
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger asChild>
                        <button type="button" className="chat-icon-button small" aria-label={`Altre azioni per ${document.label || "documento"}`}>
                          <EllipsisVertical size={15} aria-hidden="true" />
                        </button>
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.Content className="chat-menu" align="end" sideOffset={4}>
                          <DropdownMenu.Item
                            className="chat-menu-item"
                            disabled={busy || !documentTask}
                            onSelect={() => documentTask && onPostponeTaskOneDay(documentTask.id)}
                          >
                            Rimanda follow-up di 1 giorno
                          </DropdownMenu.Item>
                          <DropdownMenu.Item
                            className="chat-menu-item"
                            onSelect={() => navigate(buildPracticeUrl(lead.id, "documents", { document: document.key }))}
                          >
                            Apri nella pratica
                          </DropdownMenu.Item>
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Root>
                  </li>
                ))}
              </ul>
            ) : null}
            {documentsOpen ? (
              <button type="button" className="chat-link-button" onClick={onRequestDocuments}>
                Prepara richiesta documenti
              </button>
            ) : null}
          </section>
        ) : null}

        {lead && !recommendedAction && openTasks.length ? (
          <section className="chat-info-section">
            <h4>Prossimo task</h4>
            {openTasks.slice(0, 1).map((task) => (
              <div key={task.id} className={`chat-info-task ${getTaskDueLane(task)}`}>
                <button type="button" className="chat-info-task-open" onClick={() => navigate(buildPracticeUrl(lead.id, "task"))}>
                  <strong>{task.title}</strong>
                  <span>{task.dueAt ? new Date(task.dueAt).toLocaleString("it-IT") : "Da pianificare"}</span>
                </button>
                <div className="chat-info-actions">
                  <button type="button" className="chat-secondary-button small" disabled={busy} onClick={() => onPostponeTaskOneDay(task.id)}>
                    {actionBusyKey === `task-snooze:${task.id}` ? "Rinvio..." : "+1 giorno"}
                  </button>
                  <button type="button" className="chat-primary-button small" disabled={busy} onClick={() => onCompleteTask(task.id)}>
                    {actionBusyKey === `task:${task.id}` ? "Salvataggio..." : "Completa"}
                  </button>
                </div>
              </div>
            ))}
          </section>
        ) : null}

        {lead ? (
          <section className="chat-info-section">
            <h4>Storico interazioni</h4>
            {recentTimeline.length ? (
              <ol className="chat-info-timeline">
                {recentTimeline.map((item, index) => (
                  <li key={`${item.createdAt}-${index}`}>
                    <span>{item.text || item.type}</span>
                    <time dateTime={item.createdAt}>{formatTimelineDate(item.createdAt)}</time>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="chat-info-muted">Nessuna attivita registrata sulla pratica.</p>
            )}
            {timeline.length > recentTimeline.length ? (
              <button type="button" className="chat-link-button" onClick={() => navigate(buildPracticeUrl(lead.id, "timeline"))}>
                Vedi tutto lo storico
              </button>
            ) : null}
          </section>
        ) : null}

        {selectedConversation ? (
          <section className="chat-info-section">
            <h4>Azioni rapide</h4>
            <div className="chat-info-actions">
              <button type="button" className="chat-secondary-button" disabled={!phone} onClick={onCallCustomer}>
                <Phone size={14} aria-hidden="true" /> Chiama cliente
              </button>
              {lead && !callbackFormOpen ? (
                <button type="button" className="chat-secondary-button" onClick={() => setCallbackFormOpen(true)}>
                  <CalendarClock size={14} aria-hidden="true" /> Programma richiamo
                </button>
              ) : null}
            </div>
            {lead && callbackFormOpen ? (
              <div className="chat-callback-form">
                <label>
                  <span>Data e ora richiamo</span>
                  <input type="datetime-local" value={callbackDate} onChange={(event) => setCallbackDate(event.target.value)} />
                </label>
                <label>
                  <span>Motivo</span>
                  <input
                    type="text"
                    value={callbackReasonDraft}
                    onChange={(event) => setCallbackReasonDraft(event.target.value)}
                    placeholder="Es. vuole confrontare i prezzi"
                  />
                </label>
                <div className="chat-info-actions">
                  <button type="button" className="chat-secondary-button" disabled={callbackScheduling} onClick={() => setCallbackFormOpen(false)}>
                    Annulla
                  </button>
                  <button
                    type="button"
                    className="chat-primary-button"
                    disabled={callbackScheduling || !callbackDate || !callbackReasonDraft.trim()}
                    onClick={submitCallbackForm}
                  >
                    {callbackScheduling ? "Salvataggio..." : "Conferma richiamo"}
                  </button>
                </div>
              </div>
            ) : null}
          </section>
        ) : null}
      </div>
    </aside>
  );
}
