// Relays the expected callback from the Leadium page to the extension.
// A copy left in an open tab after the extension is updated must stay silent (context invalidated).
function send(message) {
  try { if (chrome.runtime && chrome.runtime.id) chrome.runtime.sendMessage(message).catch(() => undefined); } catch { /* extension updated: reload the tab */ }
}
// Tells Leadium that its Rispondi can work through this extension.
document.documentElement.setAttribute("data-leadium-3cx-answer", "1");

/** Asks the extension to press Answer in the 3CX tab and hands the outcome back to the page. */
async function answerCall(requestId, phone) {
  let result;
  try { result = await chrome.runtime.sendMessage({ type: "answer-call", phone }); } catch { /* extension updated: reload the tab */ }
  window.postMessage({ source: "leadium-3cx-extension", type: "answer-result", requestId, result: result || { ok: false, reason: "extension-stale" } }, window.location.origin);
}

window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const data = event.data;
  if (!data || data.source !== "leadium-3cx-autoanswer") return;
  if (data.type === "dial-started") { send({ type: "dial-started" }); return; }
  if (data.type === "incoming-call") {
    if (typeof data.callId === "string" && /^\d{1,20}$/.test(data.callId)) send({ type: "incoming-call", callId: data.callId });
    return;
  }
  if (data.type === "answer-call") {
    if (typeof data.requestId === "string" && typeof data.phone === "string") void answerCall(data.requestId.slice(0, 80), data.phone.replace(/\D/g, "").slice(0, 15));
    return;
  }
  if (data.type !== "callback-expected") return;
  if (typeof data.destination !== "string" || !/^\+?\d{6,15}$/.test(data.destination)) return;
  send({ type: "callback-expected", destination: data.destination });
});

// While the operator is on Leadium the 3CX tab stays behind: Rispondi is right here.
const reportFocus = () => send({ type: "leadium-focus", focused: document.hasFocus() });
window.addEventListener("focus", reportFocus);
window.addEventListener("blur", reportFocus);
window.addEventListener("pagehide", () => send({ type: "leadium-focus", focused: false }));
reportFocus();

// Diagnostic: shows in the log that the extension reached this Leadium page.
send({ type: "note", text: "Collegata alla pagina Leadium (" + location.host + ")" });
