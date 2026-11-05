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

/** A real incoming call: the 3CX tab comes in front of whatever the operator is working on. */
async function bringForward(tab) {
  if (!tab) return;
  try {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true, drawAttention: true });
  } catch (error) {
    await log("Scheda 3CX non portata in primo piano");
  }
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  (async () => {
    if (message.type === "dial-started") {
      await chrome.storage.session.set({ dialingUntil: Date.now() + CLAIM_WAIT_MS });
      reply({ ok: true });
    } else if (message.type === "callback-expected") {
      const digits = message.destination.replace(/\D/g, "");
      await chrome.storage.session.set({ expected: { digits, until: Date.now() + WINDOW_MS } });
      await log(`Chiama da Leadium verso ${mask(digits)}: attendo il richiamo per ${WINDOW_MS / 1000}s`);
      reply({ ok: true });
    } else if (message.type === "claim") {
      // The 3CX page asks whether an incoming call showing these digits is the expected callback.
      // 3CX rings the device about a second before the makecall response reaches Leadium: after a
      // Chiama, wait for the expectation here (the service worker is not throttled like a
      // background tab). With no Chiama under way this is a customer: no waiting.
      let expected;
      for (;;) {
        const session = await chrome.storage.session.get(["expected", "dialingUntil"]);
        expected = session.expected;
        if ((expected && expected.until > Date.now()) || !(session.dialingUntil > Date.now())) break;
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
      if (decision === "ignore" && settings.bringForward !== false) await bringForward(sender.tab);
      reply({ decision });
    } else if (message.type === "note") {
      await log(String(message.text).slice(0, 200));
      reply({ ok: true });
    }
  })();
  return true;
});
