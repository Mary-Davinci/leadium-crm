import { useCallback, useEffect, useRef, useState } from "react";

// An operator working in Excel does not see Leadium or hear the 3CX tab. While they are elsewhere a
// ringing call raises a system notification that stays until answered, a ring and a blinking tab
// title. A browser can never pull itself in front of another program: the click on the
// notification is what brings Leadium forward.

type RingingCall = { callId: string; direction: string; status: string; customerName?: string; customerPhone?: string };
type AlertPermission = NotificationPermission | "unsupported";

const DISMISS_KEY = "leadium.incomingAlert.dismissed";
const RING_EVERY_MS = 3000;

export type IncomingAlertState = { permission: AlertPermission; dismissed: boolean; enable(): void; dismiss(): void };

export function ringingCalls<T extends RingingCall>(calls: T[]) {
  return calls.filter((call) => call.direction === "inbound" && call.status === "ringing");
}

export function alertBody(call: RingingCall) {
  const phone = String(call.customerPhone || "").trim();
  const name = String(call.customerName || "").trim();
  if (name && phone) return `${name} · ${phone}`;
  return name || phone || "Numero sconosciuto";
}

function readPermission(): AlertPermission {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

function readDismissed() {
  try { return localStorage.getItem(DISMISS_KEY) === "1"; } catch { return false; }
}

export function useIncomingAlert(calls: RingingCall[]): IncomingAlertState {
  const [permission, setPermission] = useState<AlertPermission>(readPermission);
  const [dismissed, setDismissed] = useState(readDismissed);
  const [away, setAway] = useState(() => !document.hasFocus());
  const open = useRef(new Map<string, Notification>());
  const audio = useRef<AudioContext | null>(null);
  const ringing = ringingCalls(calls);
  const ringingKey = ringing.map((call) => call.callId).join(",");

  useEffect(() => {
    const update = () => setAway(!document.hasFocus());
    // Browsers play sound only after a click on the page: the first one unlocks the ring.
    const unlock = () => { audio.current ??= new AudioContext(); void audio.current.resume(); };
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    window.addEventListener("pointerdown", unlock, { once: true });
    return () => { window.removeEventListener("focus", update); window.removeEventListener("blur", update); window.removeEventListener("pointerdown", unlock); };
  }, []);

  useEffect(() => {
    const notifications = open.current;
    const live = new Set(ringing.map((call) => call.callId));
    for (const [callId, notification] of notifications) {
      if (live.has(callId) && away) continue;
      notification.close();
      notifications.delete(callId);
    }
    if (!away || !ringing.length) return;

    if (permission === "granted") {
      for (const call of ringing) {
        if (notifications.has(call.callId)) continue;
        const notification = new Notification("Chiamata in arrivo", { body: alertBody(call), tag: `leadium-call-${call.callId}`, requireInteraction: true });
        notification.onclick = () => { window.focus(); notification.close(); };
        notifications.set(call.callId, notification);
      }
    }

    const title = document.title;
    let blink = false;
    const beep = () => {
      const context = audio.current;
      if (!context || context.state !== "running") return;
      for (const start of [0, 0.35]) {
        const tone = context.createOscillator(), gain = context.createGain();
        tone.frequency.value = 880;
        gain.gain.value = 0.12;
        tone.connect(gain).connect(context.destination);
        tone.start(context.currentTime + start);
        tone.stop(context.currentTime + start + 0.25);
      }
    };
    beep();
    const flash = window.setInterval(() => { blink = !blink; document.title = blink ? "Chiamata in arrivo" : title; }, 1000);
    const ring = window.setInterval(beep, RING_EVERY_MS);
    return () => { window.clearInterval(flash); window.clearInterval(ring); document.title = title; };
  }, [ringingKey, away, permission]);

  useEffect(() => () => { open.current.forEach((notification) => notification.close()); }, []);

  const enable = useCallback(() => {
    void Notification.requestPermission().then(setPermission);
  }, []);
  const dismiss = useCallback(() => {
    setDismissed(true);
    try { localStorage.setItem(DISMISS_KEY, "1"); } catch { /* it just comes back on reload */ }
  }, []);

  return { permission, dismissed, enable, dismiss };
}
