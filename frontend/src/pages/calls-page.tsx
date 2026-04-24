import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { buildPracticeUrl } from "../features/practices/practice-links";
import "../styles/calls-page.css";

export function CallsPage() {
  const navigate = useNavigate();
  const [payload, setPayload] = useState(`{
  "eventType": "call_ended",
  "callId": "abc-123",
  "from": "+393331234567",
  "to": "+39021234567",
  "durationSeconds": 128,
  "disposition": "completed",
  "externalLeadId": "lead_123"
}`);
  const [result, setResult] = useState("");
  const [lastLeadId, setLastLeadId] = useState("");
  const [lastDisposition, setLastDisposition] = useState("");

  async function sendWebhook(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const response = await api<Record<string, unknown>>("/api/3cx/webhook", {
      method: "POST",
      body: JSON.stringify(parsed)
    });
    setLastLeadId(String(response.externalLeadId || response.leadId || parsed.externalLeadId || ""));
    setLastDisposition(String(response.disposition || parsed.disposition || ""));
    setResult(JSON.stringify(response, null, 2));
  }

  return (
    <div className="calls-grid">
      <section className="panel">
        <h3>Webhook 3CX Test</h3>
        <form onSubmit={sendWebhook} className="calls-webhook-form">
          <textarea rows={12} value={payload} onChange={(e) => setPayload(e.target.value)} />
          <button type="submit">Invia Evento</button>
        </form>
      </section>
      <section className="panel">
        <h3>Risposta</h3>
        <pre className="calls-code-block">{result || "Nessuna risposta ancora."}</pre>
        {lastLeadId ? (
          <div className="pd-actions">
            <button
              type="button"
              onClick={() => navigate(buildPracticeUrl(lastLeadId, lastDisposition === "call_back" || lastDisposition === "no_answer" ? "task" : "timeline"))}
            >
              Apri pratica
            </button>
            <button type="button" onClick={() => navigate(buildPracticeUrl(lastLeadId, "timeline"))}>
              Vai a timeline
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
