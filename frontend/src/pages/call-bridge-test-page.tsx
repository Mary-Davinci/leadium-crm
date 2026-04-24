import { Link } from "react-router-dom";

const samples = [
  {
    label: "Esito completata",
    query: "?leadId=lead_demo_1&outcome=completed&startedAt=2026-04-10T09:00:00.000Z&requestKey=test_completed_1"
  },
  {
    label: "Esito nessuna risposta",
    query: "?lead_id=lead_demo_1&status=no_answer&started_at=2026-04-10T09:05:00.000Z&request_key=test_no_answer_1"
  },
  {
    label: "Esito da richiamare",
    query:
      "?crmLeadId=lead_demo_1&result=call_back&callStartedAt=2026-04-10T09:10:00.000Z&callRequestKey=test_callback_1&callbackAt=2026-04-11T10:00"
  },
  {
    label: "Esito interessato",
    query: "?leadId=lead_demo_1&callOutcome=interested&startedAt=2026-04-10T09:15:00.000Z&requestKey=test_interested_1"
  },
  {
    label: "Esito non interessato",
    query:
      "?leadId=lead_demo_1&disposition=not_interested&startedAt=2026-04-10T09:20:00.000Z&requestKey=test_not_interested_1&note=Richiesta%20chiusa"
  }
];

export function CallBridgeTestPage() {
  return (
    <div className="panel" style={{ margin: "24px", padding: "24px", display: "grid", gap: "16px" }}>
      <div>
        <h3>Test Bridge 3CX</h3>
        <p className="muted">Usa questi link per verificare il parser callback e il salvataggio esito senza 3CX reale.</p>
      </div>

      <div style={{ display: "grid", gap: "10px" }}>
        {samples.map((sample) => (
          <Link
            key={sample.label}
            to={`/calls/bridge${sample.query}`}
            style={{
              border: "1px solid #d6e1ef",
              borderRadius: "10px",
              background: "#fff",
              padding: "12px 14px",
              textDecoration: "none",
              color: "#254164",
              fontWeight: 700
            }}
          >
            {sample.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
