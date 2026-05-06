import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { buildPracticeUrl } from "../practices/practice-links";
import { CrmTask } from "../../store/crm-store";
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
  leadLoading: boolean;
  leadError: string;
  authUsername: string;
  patchingConversation: boolean;
  actionBusyKey: string;
  completedActionKey: string;
  paymentsOpen: boolean;
  documentsOpen: boolean;
  openPaymentMenuId: string;
  onTogglePayments: () => void;
  onToggleDocuments: () => void;
  onTogglePaymentMenu: (paymentId: string) => void;
  onClosePaymentMenu: () => void;
  onPatchConversation: (patch: Partial<ChatDecisionConversation>) => void;
  onCallCustomer: () => void;
  onRequestDocuments: () => void;
  onRequestPaymentReminder: () => void;
  onMarkDocumentReceived: (documentId: string) => void;
  onMarkPaymentReceived: (paymentId: string) => void;
  onVerifyPayment: (paymentId: string) => void;
  onCompleteTask: (taskId: string) => void;
  onPostponeTaskOneDay: (taskId: string) => void;
};

function formatEuroAmount(value: number) {
  return new Intl.NumberFormat("it-IT", { maximumFractionDigits: 0 }).format(value);
}

function getRelatedOpenTask(openTasks: CrmTask[], terms: string[]) {
  return openTasks.find((task) => {
    const haystack = `${task.kind || ""} ${task.title || ""} ${task.description || ""}`.toLowerCase();
    return terms.some((term) => haystack.includes(term));
  });
}

export function ChatDecisionEngine({
  lead,
  selectedConversation,
  openTasks,
  leadLoading,
  leadError,
  authUsername,
  patchingConversation,
  actionBusyKey,
  completedActionKey,
  paymentsOpen,
  documentsOpen,
  openPaymentMenuId,
  onTogglePayments,
  onToggleDocuments,
  onTogglePaymentMenu,
  onClosePaymentMenu,
  onPatchConversation,
  onCallCustomer,
  onRequestDocuments,
  onRequestPaymentReminder,
  onMarkDocumentReceived,
  onMarkPaymentReceived,
  onVerifyPayment,
  onCompleteTask,
  onPostponeTaskOneDay
}: ChatDecisionEngineProps) {
  const navigate = useNavigate();
  const decision = useMemo(() => getDecisionSnapshot(lead, openTasks), [lead, openTasks]);
  const {
    pendingPayments,
    pendingPaymentAmount,
    missingDocuments,
    missingDocumentsCount,
    paymentProgress,
    recommendedAction,
    blockersCount
  } = decision;

  return (
    <aside className="panel chat-react-detail chat-decision-engine" aria-label="Motore decisionale pratica">
      <div className="chat-decision-engine-head">
        <h3>Dettagli Contatto</h3>
        <div className="chat-contact-card">
          <span className="chat-contact-avatar">{String(lead?.fullName || selectedConversation?.customerName || "?").slice(0, 2).toUpperCase()}</span>
          <div>
            <strong>{lead?.fullName || selectedConversation?.customerName || "-"}</strong>
            <span>{lead?.phone || selectedConversation?.phone || "-"}</span>
            {lead?.email ? <span>{lead.email}</span> : null}
          </div>
        </div>
        <div className="chat-contact-meta">
          <div className="meta-row">
            <span>Calendario</span>
            <strong>Compleanno: -</strong>
          </div>
          <div className="meta-row">
            <span>Lingua</span>
            <strong>Italiano</strong>
          </div>
          <div className="meta-row">
            <span>Note cliente</span>
            <strong>{lead ? "Cliente collegato alla pratica." : "Nessuna nota disponibile."}</strong>
          </div>
        </div>
        <div className={`chat-contact-alert ${pendingPayments.length ? "warning" : "ok"}`}>
          <span>Pagamenti in sospeso</span>
          <strong>
            {pendingPayments.length ? "Si" : "No"}
            {pendingPayments.length && pendingPaymentAmount > 0 ? ` · EUR ${formatEuroAmount(pendingPaymentAmount)}` : ""}
          </strong>
        </div>
        <div className={`chat-contact-alert ${missingDocumentsCount ? "warning" : "ok"}`}>
          <span>Documenti assenti</span>
          <strong>{missingDocumentsCount ? `Si -  ${missingDocumentsCount}` : "No"}</strong>
        </div>
        <button type="button" className="chat-contact-edit" onClick={() => lead && navigate(buildPracticeUrl(lead.id, "overview"))}>
          Apri pratica
        </button>
      </div>

      {lead && recommendedAction ? (
        <section className="chat-recommended-action">
          <div className="chat-react-section-head recommended">
            <span>Prossima azione consigliata</span>
          </div>
          <strong>{recommendedAction.label}</strong>
          <p>{recommendedAction.detail}</p>
          <div className="chat-recommended-actions">
            <button type="button" disabled={!lead.phone} onClick={onCallCustomer}>
              Chiama cliente
            </button>
            {recommendedAction.kind === "payment" ? (
              <>
                <button type="button" className="secondary" onClick={onRequestPaymentReminder}>
                  Invia template
                </button>
                <button
                  type="button"
                  className={`secondary ${completedActionKey === `payment-received:${recommendedAction.payment.id}` ? "completed" : ""}`}
                  disabled={Boolean(actionBusyKey)}
                  onClick={() => onMarkPaymentReceived(recommendedAction.payment.id)}
                >
                  {completedActionKey === `payment-received:${recommendedAction.payment.id}`
                    ? "✓ Ricevuto"
                    : actionBusyKey === `payment-received:${recommendedAction.payment.id}`
                      ? "Loading..."
                      : "Segna ricevuto"}
                </button>
              </>
            ) : recommendedAction.kind === "document" ? (
              <>
                <button type="button" className="secondary" onClick={onRequestDocuments}>
                  Invia template
                </button>
                <button
                  type="button"
                  className={`secondary ${completedActionKey === `document:${recommendedAction.document.key}` ? "completed" : ""}`}
                  disabled={Boolean(actionBusyKey)}
                  onClick={() => onMarkDocumentReceived(recommendedAction.document.key)}
                >
                  {completedActionKey === `document:${recommendedAction.document.key}`
                    ? "✓ Ricevuto"
                    : actionBusyKey === `document:${recommendedAction.document.key}`
                      ? "Loading..."
                      : "Segna ricevuto"}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="secondary"
                  disabled={Boolean(actionBusyKey)}
                  onClick={() => onPostponeTaskOneDay(recommendedAction.task.id)}
                >
                  {actionBusyKey === `task-snooze:${recommendedAction.task.id}` ? "Rinvio..." : "+1 giorno"}
                </button>
                <button type="button" className="secondary" disabled={Boolean(actionBusyKey)} onClick={() => onCompleteTask(recommendedAction.task.id)}>
                  {actionBusyKey === `task:${recommendedAction.task.id}` ? "Completo..." : "Completa task"}
                </button>
              </>
            )}
          </div>
        </section>
      ) : null}

      {lead && (pendingPayments.length || missingDocumentsCount) ? (
        <section className="chat-react-urgent-section">
          <div className="chat-react-section-head urgent">
            <span>Bloccanti pratica</span>
          </div>
          <div className="chat-action-blocks urgent">
            {pendingPayments.length ? (
              <article className="chat-action-block danger urgent">
                <header>
                  <button type="button" className="chat-action-title" onClick={onTogglePayments}>
                    Pagamenti in sospeso ({pendingPayments.length}) {paymentsOpen ? "^" : "v"}
                  </button>
                  <div className="chat-action-header-tools">
                    {pendingPaymentAmount > 0 ? <span>EUR {pendingPaymentAmount}</span> : null}
                    <button
                      type="button"
                      className="chat-action-link-button"
                      onClick={() => navigate(buildPracticeUrl(lead.id, "payments", pendingPayments[0]?.id ? { payment: pendingPayments[0].id } : {}))}
                    >
                      Vai alla sezione pagamenti -&gt;
                    </button>
                  </div>
                </header>
                {paymentProgress.totalAmount > 0 ? (
                  <div
                    className="chat-payment-progress"
                    aria-label={`Pagamenti: ${paymentProgress.verifiedAmount} su ${paymentProgress.totalAmount} euro verificati`}
                  >
                    <div>
                      <span>Pagamenti</span>
                      <strong>
                        {formatEuroAmount(paymentProgress.verifiedAmount)} / {formatEuroAmount(paymentProgress.totalAmount)} € verificati
                      </strong>
                    </div>
                    <div className="chat-payment-progress-bar">
                      <span style={{ width: `${paymentProgress.percent}%` }} />
                    </div>
                  </div>
                ) : null}
                {paymentsOpen ? (
                  <div className="chat-action-items">
                    {pendingPayments.slice(0, 3).map((payment) => {
                      const paymentTask = getRelatedOpenTask(openTasks, ["payment", "pagament", "saldo", "acconto"]);
                      const status = getPaymentVisualStatus(payment);
                      return (
                        <div key={payment.id} className="chat-action-item urgent">
                          <div className="chat-action-item-head">
                            <span>
                              {payment.label || payment.id}
                              {payment.amount ? ` - EUR ${payment.amount}` : ""}
                            </span>
                            <em className={`chat-status-chip ${status.tone}`}>{status.label}</em>
                          </div>
                          <div>
                            {payment.status !== "received" ? (
                              <button
                                type="button"
                                className={completedActionKey === `payment-received:${payment.id}` ? "completed" : ""}
                                disabled={Boolean(actionBusyKey)}
                                onClick={() => onMarkPaymentReceived(payment.id)}
                              >
                                {completedActionKey === `payment-received:${payment.id}`
                                  ? "✓ Ricevuto"
                                  : actionBusyKey === `payment-received:${payment.id}`
                                    ? "Loading..."
                                    : "Segna ricevuto"}
                              </button>
                            ) : null}
                            <div className="chat-row-menu">
                              <button
                                type="button"
                                className="secondary icon"
                                aria-label="Altre azioni pagamento"
                                onClick={() => onTogglePaymentMenu(payment.id)}
                              >
                                ...
                              </button>
                              {openPaymentMenuId === payment.id ? (
                                <div className="chat-row-menu-pop">
                                  <button
                                    type="button"
                                    disabled={Boolean(actionBusyKey) || !paymentTask}
                                    onClick={() => {
                                      onClosePaymentMenu();
                                      if (paymentTask) onPostponeTaskOneDay(paymentTask.id);
                                    }}
                                  >
                                    {paymentTask && actionBusyKey === `task-snooze:${paymentTask.id}` ? "Rinvio..." : "+1 giorno"}
                                  </button>
                                  <button
                                    type="button"
                                    disabled={!lead.phone}
                                    onClick={() => {
                                      onClosePaymentMenu();
                                      onCallCustomer();
                                    }}
                                  >
                                    Chiama cliente
                                  </button>
                                  <button
                                    type="button"
                                    className={completedActionKey === `payment-verified:${payment.id}` ? "completed" : ""}
                                    disabled={Boolean(actionBusyKey)}
                                    onClick={() => {
                                      onClosePaymentMenu();
                                      onVerifyPayment(payment.id);
                                    }}
                                  >
                                    {completedActionKey === `payment-verified:${payment.id}`
                                      ? "Verificato"
                                      : actionBusyKey === `payment-verified:${payment.id}`
                                        ? "Verifico..."
                                        : "Verifica"}
                                  </button>
                                </div>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </article>
            ) : null}

            {missingDocumentsCount ? (
              <article className="chat-action-block warning compact">
                <header>
                  <button type="button" className="chat-action-title" onClick={onToggleDocuments}>
                    Documenti mancanti ({missingDocumentsCount}) {documentsOpen ? "^" : "v"}
                  </button>
                </header>
                {documentsOpen ? (
                  <div className="chat-action-items">
                    {missingDocuments.slice(0, 4).map((document) => {
                      const documentTask = getRelatedOpenTask(openTasks, ["document", "doc"]);
                      return (
                        <div key={document.key} className="chat-action-item urgent">
                          <span>{document.label || document.key}</span>
                          <div>
                            <button
                              type="button"
                              className={completedActionKey === `document:${document.key}` ? "completed" : ""}
                              disabled={Boolean(actionBusyKey)}
                              onClick={() => onMarkDocumentReceived(document.key)}
                            >
                              {completedActionKey === `document:${document.key}`
                                ? "✓ Ricevuto"
                                : actionBusyKey === `document:${document.key}`
                                  ? "Loading..."
                                  : "Segna ricevuto"}
                            </button>
                            <button
                              type="button"
                              className="secondary"
                              disabled={Boolean(actionBusyKey) || !documentTask}
                              onClick={() => documentTask && onPostponeTaskOneDay(documentTask.id)}
                            >
                              {documentTask && actionBusyKey === `task-snooze:${documentTask.id}` ? "Rinvio..." : "+1 giorno"}
                            </button>
                            <button type="button" className="secondary" disabled={!lead.phone} onClick={onCallCustomer}>
                              Chiama
                            </button>
                            <button type="button" className="secondary" onClick={onRequestDocuments}>
                              Richiedi
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </article>
            ) : null}
          </div>
        </section>
      ) : null}

      {selectedConversation ? (
        <section className="chat-react-detail-section chat-history-card">
          <div className="chat-react-section-head">
            <span>Storico interazioni</span>
          </div>
          <div className="chat-history-list">
            <div><span>Chat WhatsApp</span><strong>Oggi, 10:24</strong></div>
            <div><span>Richiesta preventivo</span><strong>Ieri, 15:30</strong></div>
            <div><span>Email inviata</span><strong>08/05/2024</strong></div>
          </div>
          <button type="button" className="chat-see-all">Vedi tutto</button>
          <div className="chat-react-section-head chat-actions-heading">
            <span>Azioni chat</span>
          </div>
          <div className="chat-react-ops">
            <div className="chat-react-ops-row">
              <button type="button" disabled={patchingConversation || !authUsername} onClick={() => onPatchConversation({ assignedTo: authUsername })}>
                Assegna a me
              </button>
              <button type="button" className="secondary" disabled={patchingConversation} onClick={() => onPatchConversation({ assignedTo: "" })}>
                Libera
              </button>
            </div>
            <div className="chat-react-ops-row">
              <button type="button" className="secondary" disabled={patchingConversation} onClick={() => onPatchConversation({ status: "open" })}>
                Apri
              </button>
              <button
                type="button"
                className="secondary"
                disabled={patchingConversation}
                onClick={() => onPatchConversation({ status: "waiting_customer" })}
              >
                In gestione
              </button>
              <button type="button" disabled={patchingConversation} onClick={() => onPatchConversation({ status: "resolved" })}>
                Chiudi
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {leadLoading ? <p className="muted">Caricamento contesto pratica...</p> : null}
      {leadError ? <p className="chat-react-error">{leadError}</p> : null}

      {lead ? (
        <>
          {!recommendedAction ? (
            <section className="chat-react-detail-section">
              <div className="chat-react-section-head">
                <span>Prossima azione</span>
              </div>
              <div className="chat-react-task-list">
                {openTasks.slice(0, 1).map((task) => (
                  <article key={task.id} className={`chat-task-action ${getTaskDueLane(task)}`}>
                    <button type="button" className="chat-task-open" onClick={() => navigate(buildPracticeUrl(lead.id, "task"))}>
                      <strong>{task.title}</strong>
                      <span>{task.dueAt ? new Date(task.dueAt).toLocaleString("it-IT") : "Da pianificare"}</span>
                    </button>
                    <div className="chat-task-actions">
                      <button type="button" className="secondary" disabled={Boolean(actionBusyKey)} onClick={() => onPostponeTaskOneDay(task.id)}>
                        {actionBusyKey === `task-snooze:${task.id}` ? "Rinvio..." : "+1 giorno"}
                      </button>
                      <button type="button" className="secondary" disabled={!lead.phone} onClick={onCallCustomer}>
                        Chiama
                      </button>
                      <button type="button" disabled={Boolean(actionBusyKey)} onClick={() => onCompleteTask(task.id)}>
                        {actionBusyKey === `task:${task.id}` ? "Completo..." : "Completa task"}
                      </button>
                    </div>
                  </article>
                ))}
                {!openTasks.length ? <p className="muted">Nessun task aperto collegato.</p> : null}
              </div>
            </section>
          ) : null}

        
        </>
      ) : (
        <div className="chat-react-unlinked">
          <strong>Nessuna pratica collegata</strong>
          <span>La prossima ricezione o invio tentera il collegamento automatico tramite numero.</span>
        </div>
      )}
    </aside>
  );
}
