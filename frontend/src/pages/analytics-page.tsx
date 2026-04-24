import { useEffect, useState } from "react";
import { api } from "../lib/api";

type Kpi = {
  total: number;
  toContact: number;
  interested: number;
  sold: number;
  noAnswer: number;
  overdueCallbacks: number;
};

export function AnalyticsPage() {
  const [kpi, setKpi] = useState<Kpi | null>(null);

  useEffect(() => {
    api<Kpi>("/api/analytics/kpis")
      .then(setKpi)
      .catch((error: Error) => alert(error.message));
  }, []);

  return (
    <div className="panel">
      <h3>Analytics</h3>
      <table className="table">
        <tbody>
          <tr>
            <th>Lead totali</th>
            <td>{kpi?.total ?? 0}</td>
          </tr>
          <tr>
            <th>Da contattare</th>
            <td>{kpi?.toContact ?? 0}</td>
          </tr>
          <tr>
            <th>Interessati</th>
            <td>{kpi?.interested ?? 0}</td>
          </tr>
          <tr>
            <th>Vendute</th>
            <td>{kpi?.sold ?? 0}</td>
          </tr>
          <tr>
            <th>Non risponde</th>
            <td>{kpi?.noAnswer ?? 0}</td>
          </tr>
          <tr>
            <th>Richiami scaduti</th>
            <td>{kpi?.overdueCallbacks ?? 0}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
