// Runs in the 3CX web client. When an incoming-call screen with an Answer button appears, asks
// the extension whether it is the callback Leadium just requested; clicks Answer only if so.
(() => {
  const ANSWER = /^(rispondi|answer|accept|accetta)$/i;
  let current = null; // the Answer button of the incoming screen being handled

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
  };
  const labelOf = (el) => [el.getAttribute("aria-label"), el.getAttribute("title"), el.textContent].map((v) => (v || "").trim());

  /**
   * The clickable Answer control. 3CX web client (Angular, observed Oct 2026):
   * <call-view> … <button data-qa="answer" title="Rispondi">. Label matching is only a fallback.
   */
  function findAnswerButton() {
    const tagged = document.querySelector('button[data-qa="answer"]');
    if (tagged && visible(tagged)) return tagged;
    for (const el of document.querySelectorAll("button, [role=button]")) {
      if (visible(el) && labelOf(el).some((v) => ANSWER.test(v))) return el;
    }
    for (const el of document.querySelectorAll("span, div, label, p")) {
      if (el.children.length || !ANSWER.test((el.textContent || "").trim())) continue;
      const own = el.closest("button, [role=button]");
      if (own && visible(own)) return own;
      const sibling = el.parentElement && el.parentElement.querySelector("button, [role=button]");
      if (sibling && visible(sibling)) return sibling;
    }
    return null;
  }

  /** Digits shown on the incoming-call screen around the button (caller number), not the whole page. */
  function shownDigits(button) {
    const view = button.closest("call-view");
    if (view) return ((view.innerText || "").match(/\+?[\d][\d\s().-]{5,}\d/g) || []).map((run) => run.replace(/\D/g, "")).join(" ");
    let node = button;
    for (let i = 0; i < 8 && node.parentElement; i++) {
      node = node.parentElement;
      const runs = (node.innerText || "").match(/\+?[\d][\d\s().-]{5,}\d/g);
      if (runs) return runs.map((run) => run.replace(/\D/g, "")).join(" ");
    }
    return "";
  }

  function check() {
    const button = findAnswerButton();
    if (button === current) return;
    current = button; // reset to null when the screen goes away, so a reused button counts again
    if (!button) return;
    const digits = shownDigits(button);
    chrome.runtime.sendMessage({ type: "claim", shownDigits: digits }).then((result) => {
      if (!result || result.decision !== "answer" || !button.isConnected) return;
      button.click();
      chrome.runtime.sendMessage({ type: "note", text: "Rispondi premuto nella scheda 3CX" }).catch(() => undefined);
    }).catch(() => undefined);
  }

  // Diagnostic: shows in the log that the extension reached the 3CX page (top frame only).
  if (window === window.top) chrome.runtime.sendMessage({ type: "note", text: "Collegata alla scheda 3CX (" + location.host + ")" }).catch(() => undefined);

  let pending = false;
  new MutationObserver(() => {
    if (pending) return;
    pending = true;
    // Background tabs still run microtasks: no timers, so throttling cannot delay the answer.
    queueMicrotask(() => { pending = false; check(); });
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  check();
})();
