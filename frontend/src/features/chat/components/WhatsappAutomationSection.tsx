import { FormEvent, useState } from "react";
import { Ban, ShieldCheck } from "lucide-react";
import type { TemplateOption, WhatsappAutomationInfo } from "../chat.types";

type WhatsappAutomationSectionProps = {
  info: WhatsappAutomationInfo | null;
  templates: TemplateOption[];
  busy: boolean;
  onUseTemplate: (templateKey: string) => void;
  onSetDoNotContact: (active: boolean, reason: string) => void;
};

function formatWhen(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleString("it-IT", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/**
 * WhatsApp side of the practice, inside the existing contact panel: the explicit opt-out, whether
 * follow-ups are still running (and why not), and what the Booking rules suggest sending now.
 */
export function WhatsappAutomationSection({ info, templates, busy, onUseTemplate, onSetDoNotContact }: WhatsappAutomationSectionProps) {
  const [optOutDraft, setOptOutDraft] = useState<string | null>(null);
  const state = info?.state || null;
  if (!info || !state) return null;

  const optedOut = Boolean(state.doNotContact && state.doNotContact.active);
  const labelOf = (key: string | null) => templates.find((item) => item.key === key)?.label || key || "";

  function submitOptOut(event: FormEvent) {
    event.preventDefault();
    onSetDoNotContact(true, String(optOutDraft || "").trim());
    setOptOutDraft(null);
  }

  return (
    <section className="chat-info-section chat-wa-automation" aria-label="WhatsApp e solleciti">
      <h4>WhatsApp</h4>
      {optedOut ? (
        <>
          <span className="chat-wa-badge blocked">
            <Ban size={13} aria-hidden="true" /> Non contattare
          </span>
          <p className="chat-wa-facts">
            {state.doNotContact?.reason ? <span>Motivo: {state.doNotContact.reason}</span> : null}
            {state.doNotContact?.setAt ? (
              <span>
                Dal {formatWhen(state.doNotContact.setAt)}
                {state.doNotContact.setBy ? ` (${state.doNotContact.setBy})` : ""}. Nessun template verra inviato; puoi rispondere se il cliente scrive.
              </span>
            ) : null}
          </p>
          <div className="chat-wa-optout-actions">
            <button type="button" className="chat-secondary-button small" disabled={busy} onClick={() => onSetDoNotContact(false, "")}>
              Rimuovi blocco
            </button>
          </div>
        </>
      ) : (
        <>
          <span className={`chat-wa-badge ${state.stoppedReason ? "stopped" : "active"}`}>
            <ShieldCheck size={13} aria-hidden="true" />
            {state.stoppedReason ? `Solleciti fermi: ${state.stoppedReasonLabel || state.stoppedReason}` : "Solleciti WhatsApp possibili"}
          </span>
          <p className="chat-wa-facts">
            <span>{state.firstContactSentAt ? `Primo contatto inviato il ${formatWhen(state.firstContactSentAt)}` : "Primo contatto non ancora inviato"}</span>
            {state.lastTemplateKey ? (
              <span>
                Ultimo template: {labelOf(state.lastTemplateKey)} ({formatWhen(state.lastTemplateSentAt)})
              </span>
            ) : null}
            {state.customerRepliedAt ? <span>Ultima risposta del cliente: {formatWhen(state.customerRepliedAt)}</span> : null}
            <span>{state.automationEnabled ? "Invio automatico attivo per i template abilitati." : "Invio automatico disattivato: i template si inviano solo manualmente."}</span>
          </p>
          {info.suggestions.length ? (
            <ul className="chat-wa-suggestions" aria-label="Template consigliati">
              {info.suggestions.map((item) => (
                <li key={item.key}>
                  <span>
                    <strong>{labelOf(item.key)}</strong>
                    <small>{item.reason}</small>
                  </span>
                  <button type="button" className="chat-secondary-button small" onClick={() => onUseTemplate(item.key)}>
                    Usa
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {optOutDraft === null ? (
            <div className="chat-wa-optout-actions">
              <button type="button" className="chat-link-button muted" disabled={busy} onClick={() => setOptOutDraft("")}>
                Segna "non contattare"
              </button>
            </div>
          ) : (
            <form className="chat-wa-optout" onSubmit={submitOptOut}>
              <label className="sr-only" htmlFor="chat-optout-reason">
                Motivo
              </label>
              <input
                id="chat-optout-reason"
                autoFocus
                value={optOutDraft}
                onChange={(event) => setOptOutDraft(event.target.value)}
                placeholder="Motivo (es. il cliente ha chiesto di non essere contattato)"
              />
              <div className="chat-wa-optout-actions">
                <button type="button" className="chat-secondary-button small" onClick={() => setOptOutDraft(null)}>
                  Annulla
                </button>
                <button type="submit" className="chat-primary-button small" disabled={busy}>
                  Conferma blocco
                </button>
              </div>
            </form>
          )}
        </>
      )}
    </section>
  );
}
