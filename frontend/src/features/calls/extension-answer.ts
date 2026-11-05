// The 3CX web client (the only one on a Mac) refuses remote commands: the PBX reports
// direct_control false and its API cannot answer. The Leadium extension sits in that tab and
// presses Answer there, so Rispondi still works from Leadium.

const EXTENSION_MARK = "data-leadium-3cx-answer";
// Covers the extension's retries while 3CX draws its incoming screen.
const ANSWER_TIMEOUT_MS = 6000;
// The extension confirms the press before the PBX reports the call as answered.
export const ANSWER_SETTLE_MS = 2500;

type AnswerResult = { ok?: boolean; reason?: string };

export function extensionCanAnswer() {
  return typeof document !== "undefined" && document.documentElement.hasAttribute(EXTENSION_MARK);
}

export function answerFailureMessage(reason?: string) {
  if (reason === "no-tab") return "Scheda 3CX non aperta: aprila in Chrome e ricaricala per rispondere da Leadium.";
  if (reason === "other-call") return "Nella scheda 3CX c'è un'altra chiamata in arrivo: rispondi da lì.";
  if (reason === "extension-stale") return "Estensione aggiornata: ricarica questa pagina e la scheda 3CX.";
  return "Risposta non riuscita: rispondi nella scheda 3CX.";
}

/** Resolves to null once Answer is pressed in the 3CX tab, otherwise to the message for the operator. */
export function answerViaExtension(callId: string, phone: string, timeoutMs = ANSWER_TIMEOUT_MS) {
  const requestId = `${callId}-${Date.now()}`;
  return new Promise<string | null>((resolve) => {
    const finish = (outcome: string | null) => {
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve(outcome);
    };
    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      if (event.source !== window || data?.source !== "leadium-3cx-extension" || data.type !== "answer-result" || data.requestId !== requestId) return;
      const result = (data.result || {}) as AnswerResult;
      finish(result.ok ? null : answerFailureMessage(result.reason));
    };
    const timer = window.setTimeout(() => finish(answerFailureMessage("extension-stale")), timeoutMs);
    window.addEventListener("message", onMessage);
    window.postMessage({ source: "leadium-3cx-autoanswer", type: "answer-call", requestId, phone }, window.location.origin);
  });
}
