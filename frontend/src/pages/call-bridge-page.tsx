import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { clearPending3CXCall, read3CXCallbackPayload } from "../lib/threecx";

export function CallBridgePage() {
  const navigate = useNavigate();
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;

    async function completeCall() {
      const payload = read3CXCallbackPayload(new URL(window.location.href));
      if (!payload) {
        if (active) setError("Callback 3CX non valido o incompleto.");
        return;
      }

      try {
        await api(`/api/leads/${payload.leadId}/calls`, {
          method: "POST",
          body: JSON.stringify({
            disposition: payload.outcome,
            actor: "3cx callback",
            note: payload.note || "",
            startedAt: payload.startedAt,
            endedAt: new Date().toISOString(),
            followUpAt: payload.followUpAt,
            idempotencyKey: payload.requestKey
          })
        });

        clearPending3CXCall();
        navigate("/pratiche", { replace: true });
      } catch (e) {
        if (active) {
          setError(e instanceof Error ? e.message : "Errore salvataggio esito chiamata 3CX.");
        }
      }
    }

    void completeCall();

    return () => {
      active = false;
    };
  }, [navigate]);

  return (
    <div className="panel" style={{ margin: "24px", padding: "24px" }}>
      <h3>Bridge chiamata 3CX</h3>
      {error ? <p className="pr-error">{error}</p> : <p className="muted">Elaborazione esito chiamata in corso...</p>}
    </div>
  );
}
