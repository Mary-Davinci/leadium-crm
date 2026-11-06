// Holds at most one expected callback, valid for a short window and consumed once.
const WINDOW_MS = 25000;
const CLAIM_WAIT_MS = 8000;
const MAX_LOG = 25;
const ANSWER_TRIES = 5;
const ANSWER_RETRY_MS = 500;
const mask = (digits) => (digits ? "…" + digits.slice(-3) : "—");

async function log(text) {
  const { events = [] } = await chrome.storage.local.get("events");
  events.unshift({ at: new Date().toISOString(), text });
  await chrome.storage.local.set({ events: events.slice(0, MAX_LOG) });
}

/**
 * A real incoming call: the 3CX tab comes in front of whatever the operator is working on, unless
 * they are looking at Leadium, whose Rispondi works from there. `force` is for an answer that failed.
 */
async function bringForward(tabId, force = false) {
  const { leadiumFocused } = await chrome.storage.session.get("leadiumFocused");
  if (leadiumFocused && !force) return;
  if (typeof tabId !== "number") {
    await log("Chiamata in arrivo, ma la scheda 3CX non risulta aperta: aprila e ricaricala");
    return;
  }
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true, drawAttention: true });
    await log("Chiamata in arrivo: scheda 3CX portata in primo piano");
  } catch {
    await log("Chiamata in arrivo: scheda 3CX non raggiungibile, ricaricala");
  }
}

const tabIdOf = (sender) => (sender.tab ? sender.tab.id : undefined);

const RING_NOTIFICATION = "leadium-call";
let ringQueue = Promise.resolve();
// Leadium and the 3CX tab report the same call a moment apart: one at a time, or it shows twice.
const oneAtATime = (work) => (ringQueue = ringQueue.then(work, work));

async function showRinging(ringing, opensWindow) {
  const title = ringing.name || ringing.phone || "Numero sconosciuto";
  try {
    await chrome.notifications.create(RING_NOTIFICATION, {
      type: "basic", iconUrl: "icon.png", title: "Chiamata in arrivo", message: title,
      contextMessage: ringing.name ? ringing.phone || "" : "", priority: 2, requireInteraction: true,
      buttons: [{ title: "Rispondi" }, { title: "Apri 3CX" }]
    });
  } catch {
    await log("Notifica non mostrata: controlla le notifiche di Chrome nel sistema");
  }
  if (!opensWindow) return;
  try {
    const opened = await chrome.windows.create({ url: "incoming.html", type: "popup", width: 340, height: 230, focused: true });
    await chrome.storage.session.set({ ringing: { ...ringing, windowId: opened.id } });
  } catch {
    await log("Finestra della chiamata non aperta");
  }
}

/** A real incoming call, while the operator is away from Leadium, whose Rispondi works from there. */
function announceCall(call) {
  return oneAtATime(async () => {
    const { ringing, lastCallId, leadiumFocused } = await chrome.storage.session.get(["ringing", "lastCallId", "leadiumFocused"]);
    if (leadiumFocused) return;
    if (call.callId && call.callId === lastCallId) return;
    if (call.callId) await chrome.storage.session.set({ lastCallId: call.callId });
    if (ringing && (!ringing.callId || !call.callId || ringing.callId === call.callId)) {
      // The same call seen by the other source: it may bring the name, never a second window.
      const merged = { ...ringing, callId: ringing.callId || call.callId, name: ringing.name || call.name, phone: ringing.phone || call.phone };
      await chrome.storage.session.set({ ringing: merged });
      if (merged.name !== ringing.name) await showRinging(merged, false);
      return;
    }
    const { settings = {} } = await chrome.storage.local.get("settings");
    const next = { callId: call.callId || "", name: call.name || "", phone: call.phone || "", windowId: ringing ? ringing.windowId : undefined };
    await chrome.storage.session.set({ ringing: next });
    await log(`Chiamata in arrivo (${mask(next.phone)}): finestra e notifica`);
    await showRinging(next, settings.bringForward !== false && next.windowId === undefined);
  });
}

/** The ringing is over, whoever stopped it. */
function endRinging() {
  return oneAtATime(async () => {
    const { ringing } = await chrome.storage.session.get("ringing");
    if (!ringing) return;
    await chrome.storage.session.remove("ringing");
    await chrome.notifications.clear(RING_NOTIFICATION).catch(() => undefined);
    if (typeof ringing.windowId === "number") await chrome.windows.remove(ringing.windowId).catch(() => undefined);
  });
}

/** Rispondi outside Leadium: the operator ends up on 3CX, where the call can be closed. */
async function answerRinging() {
  const { ringing, threecxTabId } = await chrome.storage.session.get(["ringing", "threecxTabId"]);
  const digits = String((ringing && ringing.phone) || "").replace(/\D/g, "");
  if (typeof threecxTabId !== "number") {
    await log("Rispondi: la scheda 3CX non risulta aperta");
    return;
  }
  const result = await pressAnswer(threecxTabId, digits);
  await log(`Rispondi dalla finestra (${mask(digits)}): ${result.pressed ? "premuto nella scheda 3CX" : "non riuscito, apro la scheda 3CX"}`);
  await endRinging();
  await bringForward(threecxTabId, true);
}

async function open3cx() {
  const { threecxTabId } = await chrome.storage.session.get("threecxTabId");
  await bringForward(threecxTabId, true);
}

chrome.notifications.onButtonClicked.addListener((id, button) => {
  if (id !== RING_NOTIFICATION) return;
  void (button === 0 ? answerRinging() : open3cx());
});
chrome.notifications.onClicked.addListener((id) => { if (id === RING_NOTIFICATION) void open3cx(); });

/** The operator pressed Rispondi in Leadium. 3CX can draw its screen after Leadium: short retries. */
async function pressAnswer(tabId, digits) {
  let result;
  for (let attempt = 0; attempt < ANSWER_TRIES; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, ANSWER_RETRY_MS));
    // Only the frame holding the button replies: no reply means no button yet (or the tab is gone).
    result = await chrome.tabs.sendMessage(tabId, { type: "press-answer", digits }).catch(() => undefined);
    if (result) break;
  }
  return result || { pressed: false, reason: "no-button" };
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  (async () => {
    if (message.type === "threecx-tab") {
      await chrome.storage.session.set({ threecxTabId: tabIdOf(sender) });
      reply({ ok: true });
    } else if (message.type === "incoming-call") {
      // Leadium is told by the PBX itself: this works while the 3CX tab is hidden and draws nothing.
      await announceCall({ callId: message.callId, name: message.name, phone: message.phone });
      reply({ ok: true });
    } else if (message.type === "ring-ended") {
      await endRinging();
      reply({ ok: true });
    } else if (message.type === "ring-answer") {
      await answerRinging();
      reply({ ok: true });
    } else if (message.type === "ring-open-3cx") {
      await open3cx();
      reply({ ok: true });
    } else if (message.type === "leadium-focus") {
      await chrome.storage.session.set({ leadiumFocused: message.focused === true });
      reply({ ok: true });
    } else if (message.type === "answer-call") {
      const { threecxTabId } = await chrome.storage.session.get("threecxTabId");
      if (typeof threecxTabId !== "number") {
        await log("Rispondi da Leadium: la scheda 3CX non risulta aperta");
        reply({ ok: false, reason: "no-tab" });
        return;
      }
      const digits = String(message.phone || "").replace(/\D/g, "");
      const result = await pressAnswer(threecxTabId, digits);
      await log(`Rispondi da Leadium (${mask(digits)}): ${result.pressed ? "premuto nella scheda 3CX"
        : result.reason === "other-call" ? "nella scheda 3CX c'è un'altra chiamata, non premo"
        : "pulsante Rispondi non trovato nella scheda 3CX"}`);
      if (!result.pressed) await bringForward(threecxTabId, true);
      reply(result.pressed ? { ok: true } : { ok: false, reason: result.reason });
    } else if (message.type === "dial-started") {
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
      if (decision === "ignore") await announceCall({ phone: shown.split(" ")[0] || "" });
      reply({ decision });
    } else if (message.type === "note") {
      await log(String(message.text).slice(0, 200));
      reply({ ok: true });
    }
  })();
  return true;
});
