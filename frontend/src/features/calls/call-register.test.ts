import { describe, expect, it } from "vitest";
import { dayHeading, daySummary, directionLabel, formatTalk, formatTotalTalk, isAnswered, isInPeriod, operatorNames, operatorOf, operatorSummary, talkSeconds } from "./call-register";

const now = Date.parse("2026-11-06T11:00:00Z"); // 12:00 in Rome
const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
const names = operatorNames([{ username: "marta", name: "Marta", threeCxDn: "913" }, { username: "giuseppe", name: "Giuseppe", threeCxDn: "901" }]);

describe("call register", () => {
  it("counts talking time, not the ringing", () => {
    expect(talkSeconds({ startedAt: at(-10), endedAt: at(-5), outcome: "completed", durationSeconds: 90, source: "3cx" })).toBe(90);
    expect(talkSeconds({ startedAt: at(-10), endedAt: at(-5), outcome: "completed", answeredAt: at(-9), source: "3cx" })).toBe(240);
    expect(talkSeconds({ startedAt: at(-10), endedAt: at(-5), outcome: "completed", source: "3cx" })).toBe(0);
    expect(talkSeconds({ startedAt: at(-10), endedAt: at(-5), outcome: "no_answer", source: "3cx" })).toBe(0);
    expect(talkSeconds({ startedAt: at(-5), endedAt: at(-4), outcome: "completed", source: "manual" })).toBe(60);
  });
  it("tells answered from unanswered", () => {
    expect(isAnswered({ startedAt: at(0), outcome: "no_answer" })).toBe(false);
    expect(isAnswered({ startedAt: at(0), outcome: "busy" })).toBe(false);
    expect(isAnswered({ startedAt: at(0), outcome: "call_back" })).toBe(true);
  });
  it("writes durations", () => {
    expect([formatTalk(0), formatTalk(45), formatTalk(252)]).toEqual(["—", "45s", "4m 12s"]);
    expect([formatTotalTalk(600), formatTotalTalk(11520)]).toEqual(["10m", "3h 12m"]);
  });
  it("names the operator whatever the log wrote", () => {
    expect(operatorOf({ startedAt: at(0), outcome: "completed", actor: "913" }, names)).toBe("Marta");
    expect(operatorOf({ startedAt: at(0), outcome: "completed", actor: "giuseppe" }, names)).toBe("Giuseppe");
    expect(operatorOf({ startedAt: at(0), outcome: "completed", actor: "3cx", lead: { assignedTo: "marta" } }, names)).toBe("Marta");
    expect(operatorOf({ startedAt: at(0), outcome: "completed", actor: "999", lead: { assignedTo: "" } }, names)).toBe("Da assegnare");
    expect(operatorOf({ startedAt: at(0), outcome: "completed", actor: "ex.collega" }, names)).toBe("ex.collega");
  });
  it("uses Rome's day for today and the headings", () => {
    expect(isInPeriod({ startedAt: "2026-11-05T23:30:00Z", outcome: "completed" }, "today", now)).toBe(true);
    expect(isInPeriod({ startedAt: "2026-11-05T22:30:00Z", outcome: "completed" }, "today", now)).toBe(false);
    expect(isInPeriod({ startedAt: at(-60 * 24 * 6), outcome: "completed" }, "7d", now)).toBe(true);
    expect(isInPeriod({ startedAt: at(-60 * 24 * 8), outcome: "completed" }, "7d", now)).toBe(false);
    expect(dayHeading(at(-10), now)).toBe("Oggi · 6 novembre");
    expect(dayHeading(at(-60 * 24), now)).toBe("Ieri · 5 novembre");
    expect(dayHeading(at(-60 * 24 * 4), now)).toBe("2 novembre 2026");
  });
  it("sums today, and today only", () => {
    const calls = [
      { startedAt: at(-10), outcome: "completed", direction: "inbound" as const, durationSeconds: 100, actor: "913" },
      { startedAt: at(-20), outcome: "no_answer", direction: "outbound" as const, actor: "913" },
      { startedAt: at(-30), outcome: "call_back", direction: "outbound" as const, durationSeconds: 50, actor: "901" },
      { startedAt: at(-60 * 24), outcome: "completed", direction: "inbound" as const, durationSeconds: 999, actor: "901" },
      { startedAt: at(-5), outcome: "no_answer", direction: "inbound" as const, actor: "3cx" }
    ];
    expect(daySummary(calls, now)).toEqual({ total: 4, inbound: 2, outbound: 2, answered: 2, unanswered: 2, callBack: 1, talk: 150 });
    expect(operatorSummary(calls, names, now)).toEqual([
      { name: "Marta", total: 2, answered: 1, talk: 100 },
      { name: "Giuseppe", total: 1, answered: 1, talk: 50 }
    ]);
    expect(directionLabel(calls[0])).toBe("In arrivo");
    expect(directionLabel({ startedAt: at(0), outcome: "completed" })).toBe("—");
  });
});
