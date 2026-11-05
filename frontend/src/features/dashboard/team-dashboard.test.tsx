import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildChecks, PRESENCE_LABELS, type TeamDashboard } from "./team-dashboard";

const totals: TeamDashboard["totals"] = { assigned: 0, toContact: 0, open: 0, closed: 0, done: 0, todo: 0, follow: 0, followLate: 0, chats: 0, waiting: 0, quotes: 0, quotesOpen: 0, unassigned: 0 };

describe("team dashboard", () => {
  it("checks keep the order of urgency", () => {
    const checks = buildChecks({ ...totals, unassigned: 9, quotesOpen: 6, waiting: 5, followLate: 3 });
    expect(checks.map((item) => [item.count, item.action, item.to])).toEqual([[9, "Assegna", "/tasks"], [6, "Apri elenco", "/pratiche"], [5, "Apri chat", "/chat"], [3, "Apri elenco", "/pratiche"]]);
  });

  it("a zero is not a problem to show", () => {
    expect(buildChecks(totals)).toEqual([]);
    expect(buildChecks({ ...totals, waiting: 1 }).map((item) => item.count)).toEqual([1]);
  });

  it("never states how long someone has been away", () => {
    expect(renderToStaticMarkup(<>{Object.values(PRESENCE_LABELS).join(" ")}</>)).not.toMatch(/ore|min|fermo/i);
  });
});
