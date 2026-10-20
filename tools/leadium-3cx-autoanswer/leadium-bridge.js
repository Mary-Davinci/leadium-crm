// Relays the expected callback from the Leadium page to the extension.
// A copy left in an open tab after the extension is updated must stay silent (context invalidated).
function send(message) {
  try { if (chrome.runtime && chrome.runtime.id) chrome.runtime.sendMessage(message).catch(() => undefined); } catch { /* extension updated: reload the tab */ }
}
window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const data = event.data;
  if (!data || data.source !== "leadium-3cx-autoanswer" || data.type !== "callback-expected") return;
  if (typeof data.destination !== "string" || !/^\+?\d{6,15}$/.test(data.destination)) return;
  send({ type: "callback-expected", destination: data.destination });
});

// Diagnostic: shows in the log that the extension reached this Leadium page.
send({ type: "note", text: "Collegata alla pagina Leadium (" + location.host + ")" });
