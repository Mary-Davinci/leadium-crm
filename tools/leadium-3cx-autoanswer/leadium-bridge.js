// Relays the expected callback from the Leadium page to the extension.
window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const data = event.data;
  if (!data || data.source !== "leadium-3cx-autoanswer" || data.type !== "callback-expected") return;
  if (typeof data.destination !== "string" || !/^\+?\d{6,15}$/.test(data.destination)) return;
  chrome.runtime.sendMessage({ type: "callback-expected", destination: data.destination }).catch(() => undefined);
});

// Diagnostic: shows in the log that the extension reached this Leadium page.
chrome.runtime.sendMessage({ type: "note", text: "Collegata alla pagina Leadium (" + location.host + ")" }).catch(() => undefined);
