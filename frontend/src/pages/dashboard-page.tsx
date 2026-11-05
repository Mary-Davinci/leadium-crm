import { useState } from "react";
import { AdminDashboard } from "../features/dashboard/AdminDashboard";
import { OperatorDashboard } from "../features/dashboard/OperatorDashboard";
import { getAuthUser } from "../lib/auth";
import "../styles/dashboard-page.css";

export function DashboardPage() {
  const user = getAuthUser();
  const isAdmin = user?.role === "admin" || user?.role === "super_admin";
  const [summary, setSummary] = useState("");
  const todayLabel = new Date().toLocaleDateString("it-IT", { timeZone: "Europe/Rome", weekday: "long", day: "numeric", month: "long" }).toLocaleUpperCase("it-IT");

  return (
    <div className="cruise-dashboard">
      <section className="cd-welcome">
        <img className="cd-welcome-image" src="/brand/cruise.jpg" alt="" />
        <div className="cd-welcome-copy"><span className="cd-eyebrow">{todayLabel}</span>
          <h1>Benvenuto, {user?.name || user?.username || "Crocieriamo"}</h1>
          <p>{summary}</p>
        </div>
        <img className="cd-welcome-logo" src="/brand/crocieriamo.png" alt="Crocieriamo" />
        {/* Same seamless two-layer wave as the sidebar: each path repeats every 224 units across a
            448-wide viewBox, so sliding by half its width loops. */}
        <div className="cd-welcome-sea" aria-hidden="true">
          <svg className="cd-welcome-wave back" viewBox="0 0 448 40" preserveAspectRatio="none" fill="none">
            <path d="M0 22C37 10 75 10 112 22S187 34 224 22S299 10 336 22S411 34 448 22" stroke="#096094" strokeWidth="5" />
          </svg>
          <svg className="cd-welcome-wave front" viewBox="0 0 448 40" preserveAspectRatio="none" fill="none">
            <path d="M0 28C37 16 75 16 112 28S187 40 224 28S299 16 336 28S411 40 448 28" stroke="#0877ad" strokeWidth="12" />
          </svg>
        </div>
      </section>
      {isAdmin ? <AdminDashboard onSummary={setSummary} /> : <OperatorDashboard onSummary={setSummary} />}
    </div>
  );
}
