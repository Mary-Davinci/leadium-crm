// Runs in the Leadium page. Watches only "Chiama" (/api/3cx/call): says a dial has started, then
// announces the number 3CX is about to call back. No token, no other request is read.
(() => {
  const original = window.fetch;
  window.fetch = async function (input, init) {
    let dialing = false;
    let url = "";
    try {
      url = typeof input === "string" ? input : (input && input.url) || "";
      const method = (init && init.method) || (input && input.method) || "GET";
      dialing = /\/api\/3cx\/call(\?|$)/.test(url) && method.toUpperCase() === "POST";
      // Before the request: 3CX rings the callback about a second before the response comes back.
      if (dialing) window.postMessage({ source: "leadium-3cx-autoanswer", type: "dial-started" }, window.location.origin);
    } catch { /* never interfere with Leadium */ }
    const response = await original.apply(this, arguments);
    try {
      if (dialing && response.ok) {
        response.clone().json().then((body) => {
          const destination = body && typeof body.destination === "string" ? body.destination : "";
          if (destination) window.postMessage({ source: "leadium-3cx-autoanswer", type: "callback-expected", destination }, window.location.origin);
        }).catch(() => undefined);
      }
    } catch { /* never interfere with Leadium */ }
    return response;
  };
})();
