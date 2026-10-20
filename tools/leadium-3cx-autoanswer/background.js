// Holds at most one expected callback, valid for a short window and consumed once.
const WINDOW_MS = 25000;
const CLAIM_WAIT_MS = 8000;
const MAX_LOG = 25;
const mask = (digits) => (digits ? "…" + digits.slice(-3) : "—");

async function log(text) {
  const { events = [] } = await chrome.storage.local.get("events");
  events.unshift({ at: new Date().toISOString(), text });
  await chrome.storage.local.set({ events: events.slice(0, MAX_LOG) });
}

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  (async () => {
    if (message.type === "callback-expected") {
      const digits = message.destination.replace(/\D/g, "");
      await chrome.storage.session.set({ expected: { digits, until: Date.now() + WINDOW_MS } });
      await log(`Chiama da Leadium verso ${mask(digits)}: attendo il richiamo per ${WINDOW_MS / 1000}s`);
      reply({ ok: true });
    } else if (message.type === "claim") {
      // The 3CX page asks whether an incoming call showing these digits is the expected callback.
      // 3CX rings the device about a second before the makecall response reaches Leadium:
      // without an expectation yet, wait for it here (the service worker is not throttled like a
      // background tab). Still answered only if the number matches.
      const deadline = Date.now() + CLAIM_WAIT_MS;
      let expected;
      for (;;) {
        ({ expected } = await chrome.storage.session.get("expected"));
        if ((expected && expected.until > Date.now()) || Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const { settings = { enabled: true, diagnostic: false } } = await chrome.storage.local.get("settings");
      const shown = String(message.shownDigits || "");
      const valid = expected && expected.until > Date.now();
      const match = valid && shown.length >= 6 && expected.digits.slice(-9) !== "" && shown.includes(expected.digits.slice(-9));
      let decision = "ignore";
      if (match && settings.enabled && !settings.diagnostic) { decision = "answer"; await chrome.storage.session.remove("expected"); }
      else if (match) decision = "diagnostic";
      await log(`Chiamata in arrivo (numeri visibili ${mask(shown)}): ${
        decision === "answer" ? "è il richiamo di Leadium, rispondo"
        : decision === "diagnostic" ? (settings.enabled ? "è il richiamo, ma modalità diagnostica: non rispondo" : "è il richiamo, ma estensione disattivata")
        : !valid ? "nessun Chiama recente da Leadium: squilla normalmente"
        : "numero diverso da quello chiamato: squilla normalmente"}`);
      reply({ decision });
    } else if (message.type === "note") {
      await log(String(message.text).slice(0, 200));
      reply({ ok: true });
    }
  })();
  return true;
});
