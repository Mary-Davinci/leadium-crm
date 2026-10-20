// Runs in the Leadium page. Watches only the response of "Chiama" (/api/3cx/call) and
// announces the number 3CX is about to call back. No token, no other request is read.
(() => {
  const original = window.fetch;
  window.fetch = async function (input, init) {
    const response = await original.apply(this, arguments);
    try {
      const url = typeof input === "string" ? input : input && input.url;
      const method = (init && init.method) || (input && input.method) || "GET";
      if (url && /\/api\/3cx\/call(\?|$)/.test(url) && method.toUpperCase() === "POST" && response.ok) {
        response.clone().json().then((body) => {
          const destination = body && typeof body.destination === "string" ? body.destination : "";
          if (destination) window.postMessage({ source: "leadium-3cx-autoanswer", type: "callback-expected", destination }, window.location.origin);
        }).catch(() => undefined);
      }
    } catch { /* never interfere with Leadium */ }
    return response;
  };
})();
