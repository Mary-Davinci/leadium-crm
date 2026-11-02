import { useEffect, useRef } from "react";

/** Refresh read-only queues, skipping hidden tabs, open forms and overlapping requests. */
export function useAutoRefresh(refresh: () => Promise<unknown>, enabled = true) {
  const callback = useRef(refresh);
  callback.current = refresh;
  useEffect(() => {
    if (!enabled) return;
    let running = false;
    const update = async () => {
      if (document.hidden || running) return;
      running = true;
      try { await callback.current(); } catch { /* The owning page renders its error state. */ }
      finally { running = false; }
    };
    const timer = window.setInterval(() => { void update(); }, 60000);
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [enabled]);
}
