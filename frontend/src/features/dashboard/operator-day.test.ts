import { describe, expect, it } from "vitest";
import type { CrmTask } from "../../store/crm-store";
import { buildAgenda, buildOperatorDay, buildWaiting } from "./operator-day";

const now = Date.parse("2026-11-05T10:00:00Z"); // 11:00 in Rome
const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
const task = (id: string, dueAt: string | null, extra: Partial<CrmTask> = {}): CrmTask => ({
  id, leadId: "l1", kind: "callback_reminder", title: "Richiamare: Dal Task", status: "open", priority: 75, dueAt, createdAt: at(-600), updatedAt: at(-600), ...extra
});
const leads = [{ id: "l1", fullName: "Mario Rossi", phone: "+393331112222" }, { id: "l2", fullName: "Anna Bianchi", phone: "+393334445555", status: "Da contattare" }];

describe("operator agenda", () => {
  it("holds today's calls and every late one, earliest first", () => {
    const agenda = buildAgenda([task("a", at(30)), task("b", at(-60 * 24 * 3), { leadId: "l2" })], leads, now);
    expect(agenda.map((item) => [item.name, item.late, item.state])).toEqual([["Anna Bianchi", true, "In ritardo"], ["Mario Rossi", false, "Tra 30 min"]]);
  });

  it("leaves out tomorrow, other work and handled calls", () => {
    expect(buildAgenda([task("a", at(60 * 24))], leads, now)).toEqual([]);
    expect(buildAgenda([task("a", at(5), { kind: "document_checklist" })], leads, now)).toEqual([]);
    expect(buildAgenda([task("a", at(5), { status: "done" })], leads, now)).toEqual([]);
  });

  it("shows one row per customer, and reads Rome time", () => {
    const agenda = buildAgenda([task("a", at(120), { kind: "next_action" }), task("b", at(120))], leads, now);
    expect(agenda.map((item) => [item.taskId, item.time, item.state, item.what])).toEqual([["b", "13:00", "Oggi", "Richiamo concordato"]]);
  });

  it("keeps a call whose practice the board merged away", () => {
    const [item] = buildAgenda([task("a", at(5), { leadId: "merged", meta: { phone: "+393339998888" } })], leads, now);
    expect([item.name, item.phone]).toEqual(["Dal Task", "+393339998888"]);
  });
});

describe("customers waiting", () => {
  const chat = (id: string, extra = {}) => ({ id, customerName: "Giulia", lastInboundAt: at(-20), lastOutboundAt: at(-60), lastMessagePreview: "Che date avete?", ...extra });

  it("lists who wrote last, WhatsApp and email together, newest first", () => {
    const waiting = buildWaiting([chat("c")], [{ id: "m", direction: "inbound", readAt: null, subject: "Re: Preventivo", leadName: "Elena", receivedAt: at(-5) }], now);
    expect(waiting.map((item) => [item.name, item.text])).toEqual([["Elena", "Email: Re: Preventivo"], ["Giulia", "WhatsApp: Che date avete?"]]);
    expect(waiting[1].href).toBe("/chat?conversationId=c");
  });

  it("drops answered, resolved and old chats, read and sent emails", () => {
    expect(buildWaiting([chat("a", { lastOutboundAt: at(-1) }), chat("b", { status: "resolved" }), chat("c", { lastInboundAt: at(-60 * 24 * 8), lastOutboundAt: null })], [
      { id: "m1", direction: "inbound", readAt: at(-1), receivedAt: at(-5) },
      { id: "m2", direction: "outbound", readAt: null, receivedAt: at(-5) }
    ], now)).toEqual([]);
  });
});

describe("operator day", () => {
  it("adds it up", () => {
    const day = buildOperatorDay({
      tasks: [task("a", at(-10)), task("b", at(30), { leadId: "l2" })], leads, now,
      conversations: [{ id: "c", lastInboundAt: at(-20), lastOutboundAt: null }],
      mail: [{ id: "m", direction: "inbound", readAt: null, receivedAt: at(-5) }],
      calls: [{ startedAt: at(-30) }, { startedAt: at(-60 * 24) }]
    });
    expect([day.planned, day.late, day.done, day.newLeads, day.chats, day.emails]).toEqual([1, 1, 1, 1, 1, 1]);
    expect(day.next?.taskId).toBe("b");
  });

  it("the next call is the upcoming one; with only late calls, the oldest", () => {
    const day = buildOperatorDay({ tasks: [task("a", at(-10))], leads, conversations: [], mail: [], calls: [], now });
    expect(day.next?.taskId).toBe("a");
    expect(buildOperatorDay({ tasks: [], leads, conversations: [], mail: [], calls: [], now }).next).toBeNull();
  });
});
