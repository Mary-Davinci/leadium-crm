import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";

type BreakdownRow = {
  label: string;
  count: number;
};

type OwnerLoadRow = {
  owner: string;
  total: number;
  ready: number;
  closed: number;
  overdue: number;
  slaBreached: number;
};

type Kpi = {
  total: number;
  toContact: number;
  interested: number;
  sold: number;
  noAnswer: number;
  overdueCallbacks: number;
  readyToClose: number;
  closed: number;
  lost: number;
  disqualified: number;
  unassigned: number;
  slaBreached: number;
  lossReasons: BreakdownRow[];
  statusBreakdown: BreakdownRow[];
  sourceBreakdown: BreakdownRow[];
  ownerLoad: OwnerLoadRow[];
};

const numberFormatter = new Intl.NumberFormat("it-IT");

function formatCount(value?: number) {
  return numberFormatter.format(Number(value || 0));
}

export function AnalyticsPage() {
  const [kpi, setKpi] = useState<Kpi | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<Kpi>("/api/analytics/kpis")
      .then((payload) => {
        setKpi(payload);
        setError("");
      })
      .catch((fetchError: Error) => {
        setError(fetchError.message);
      });
  }, []);

  const summaryRows = useMemo(
    () => [
      { label: "Lead totali", value: kpi?.total ?? 0 },
      { label: "Da contattare", value: kpi?.toContact ?? 0 },
      { label: "Interessati", value: kpi?.interested ?? 0 },
      { label: "Vendute", value: kpi?.sold ?? 0 },
      { label: "Pronte da chiudere", value: kpi?.readyToClose ?? 0 },
      { label: "Chiuse 100%", value: kpi?.closed ?? 0 },
      { label: "Perse", value: kpi?.lost ?? 0 },
      { label: "Escluse", value: kpi?.disqualified ?? 0 },
      { label: "Richiami scaduti", value: kpi?.overdueCallbacks ?? 0 },
      { label: "SLA primo contatto superata", value: kpi?.slaBreached ?? 0 },
      { label: "Non assegnate", value: kpi?.unassigned ?? 0 },
      { label: "Non risponde", value: kpi?.noAnswer ?? 0 }
    ],
    [kpi]
  );

  return (
    <div className="panel">
      <h3>Analytics CRM</h3>
      <p className="muted">Vista amministrativa su perdite, carico operatori e stati reali del funnel.</p>
      {error ? <p className="pr-error">{error}</p> : null}

      <table className="table">
        <tbody>
          {summaryRows.map((row) => (
            <tr key={row.label}>
              <th>{row.label}</th>
              <td>{formatCount(row.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h4 style={{ marginTop: 24 }}>Motivi perdita</h4>
      <table className="table">
        <thead>
          <tr>
            <th>Motivo</th>
            <th>Totale</th>
          </tr>
        </thead>
        <tbody>
          {kpi?.lossReasons?.length ? (
            kpi.lossReasons.map((row) => (
              <tr key={row.label}>
                <td>{row.label}</td>
                <td>{formatCount(row.count)}</td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={2}>Nessun motivo perdita registrato.</td>
            </tr>
          )}
        </tbody>
      </table>

      <h4 style={{ marginTop: 24 }}>Carico operatori</h4>
      <table className="table">
        <thead>
          <tr>
            <th>Owner</th>
            <th>Pratiche</th>
            <th>Ready</th>
            <th>Chiuse</th>
            <th>Scadute</th>
            <th>SLA rotte</th>
          </tr>
        </thead>
        <tbody>
          {kpi?.ownerLoad?.length ? (
            kpi.ownerLoad.map((row) => (
              <tr key={row.owner}>
                <td>{row.owner}</td>
                <td>{formatCount(row.total)}</td>
                <td>{formatCount(row.ready)}</td>
                <td>{formatCount(row.closed)}</td>
                <td>{formatCount(row.overdue)}</td>
                <td>{formatCount(row.slaBreached)}</td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={6}>Nessun dato operatori disponibile.</td>
            </tr>
          )}
        </tbody>
      </table>

      <h4 style={{ marginTop: 24 }}>Distribuzione stati</h4>
      <table className="table">
        <thead>
          <tr>
            <th>Stato</th>
            <th>Totale</th>
          </tr>
        </thead>
        <tbody>
          {kpi?.statusBreakdown?.length ? (
            kpi.statusBreakdown.map((row) => (
              <tr key={row.label}>
                <td>{row.label}</td>
                <td>{formatCount(row.count)}</td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={2}>Nessun dato stati disponibile.</td>
            </tr>
          )}
        </tbody>
      </table>

      <h4 style={{ marginTop: 24 }}>Distribuzione sorgenti</h4>
      <table className="table">
        <thead>
          <tr>
            <th>Sorgente</th>
            <th>Totale</th>
          </tr>
        </thead>
        <tbody>
          {kpi?.sourceBreakdown?.length ? (
            kpi.sourceBreakdown.map((row) => (
              <tr key={row.label}>
                <td>{row.label}</td>
                <td>{formatCount(row.count)}</td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={2}>Nessun dato sorgenti disponibile.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
