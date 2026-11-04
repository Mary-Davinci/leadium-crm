import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { CrmTask } from "../../store/crm-store";
import { actorKeys, describeDue, selectScheduledCalls, snoozeKey, type ScheduledCall } from "./scheduled-calls";
import { ScheduledCallCards } from "./ScheduledCallsAlert";

const now = Date.parse("2026-11-04T14:00:00Z"); // 15:00 in Rome
const minutes = (value: number) => new Date(now + value * 60_000).toISOString();
const task = (id: string, dueAt: string | null, extra: Partial<CrmTask> = {}): CrmTask => ({
  id, leadId: "lead-1", assignedTo: "marta", kind: "callback_reminder", title: "Richiamare", status: "open", priority: 75, dueAt, createdAt: minutes(-600), updatedAt: minutes(-600), ...extra
});
const leads = [{ id: "lead-1", fullName: "Mario Rossi", phone: "+393331112222" }, { id: "lead-2", fullName: "Anna Bianchi", phone: "+393334445555" }];
const keys = actorKeys({ username: "marta", name: "Marta" });
const select = (tasks: CrmTask[], snoozes = {}) => selectScheduledCalls(tasks, leads, keys, snoozes, now);

describe("scheduled call reminders", () => {
  it("starts 10 minutes before the call, not earlier", () => {
    expect(select([task("a", minutes(11))])).toEqual([]);
    expect(select([task("a", minutes(10))]).map(call => call.customerName)).toEqual(["Mario Rossi"]);
  });

  it("stays until handled today; older late calls stay on the bell", () => {
    expect(select([task("a", minutes(-120))])).toHaveLength(1);
    expect(select([task("a", minutes(-60 * 24))])).toEqual([]);
    expect(select([task("a", minutes(5), { status: "done" })])).toEqual([]);
  });

  it("only the operator's own calls, and only calls", () => {
    expect(select([task("a", minutes(5), { assignedTo: "luca" })])).toEqual([]);
    expect(select([task("a", minutes(5), { assignedTo: "" })])).toEqual([]);
    for (const kind of ["quote_preparation", "document_checklist", "payment_checklist", "sla_first_contact"]) expect(select([task("a", minutes(5), { kind })])).toEqual([]);
    expect(select([task("a", minutes(5), { kind: "appointment_reminder" })])).toHaveLength(1);
  });

  it("a practice missing from the merged board still reminds, from the task's own data", () => {
    const [call] = select([task("a", minutes(5), { leadId: "merged", title: "Richiamare: Luisa Verdi", meta: { phone: "+393339998888" } })]);
    expect([call.customerName, call.phone, call.leadId]).toEqual(["Luisa Verdi", "+393339998888", "merged"]);
  });

  it("one reminder per customer, earliest first", () => {
    const calls = select([
      task("next", minutes(5), { kind: "next_action" }),
      task("callback", minutes(5)),
      task("other", minutes(-3), { leadId: "lead-2" })
    ]);
    expect(calls.map(call => call.taskId)).toEqual(["other", "callback"]);
  });

  it("snooze hides until it expires; a new time reminds again", () => {
    const original = task("a", minutes(5));
    const key = snoozeKey({ taskId: "a", dueAt: String(original.dueAt) });
    expect(select([original], { [key]: now + 60_000 })).toEqual([]);
    expect(select([original], { [key]: now - 1 })).toHaveLength(1);
    expect(select([task("a", minutes(8))], { [key]: now + 60_000 })).toHaveLength(1);
  });

  it("speaks in Rome time, also across the hours", () => {
    expect(describeDue(minutes(8), now)).toEqual({ late: false, label: "Alle 15:08 · tra 8 min" });
    expect(describeDue(minutes(-75), now)).toEqual({ late: true, label: "Era alle 13:45 · in ritardo di 1 h 15 min" });
    expect(describeDue(minutes(0), now).label).toBe("Alle 15:00 · adesso");
  });
});

describe("scheduled call card", () => {
  const call = (id: string): ScheduledCall => ({ taskId: id, dueAt: minutes(5), leadId: "lead-1", customerName: "Mario Rossi", phone: "+393331112222" });
  const render = (calls: ScheduledCall[], canDial = true) => renderToStaticMarkup(<MemoryRouter><ScheduledCallCards calls={calls} now={now} canDial={canDial} onCall={() => {}} onSnooze={() => {}} /></MemoryRouter>);

  it("names customer and time, offers the actions", () => {
    const html = render([call("a")]);
    expect(html).toContain("Mario Rossi");
    expect(html).toContain("Alle 15:05");
    for (const label of ["Chiama", "Apri pratica", "Ricordamelo tra 10 min"]) expect(html).toContain(label);
  });

  it("no call button without a 3CX extension", () => {
    expect(render([call("a")], false)).not.toContain(">Chiama<");
  });

  it("shows three and counts the others; nothing when nothing is due", () => {
    const html = render(["a", "b", "c", "d"].map(call));
    expect(html.match(/sc-alert-card/g)).toHaveLength(3);
    expect(html).toContain("Altre 1 chiamate da fare");
    expect(render([])).toBe("");
  });
});
