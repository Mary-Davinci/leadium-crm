import { describe, expect, it } from "vitest";
import { formatAttachmentSize, formatMailTime, groupThreads, lastInbound, replySubject, type MailMessage } from "./email.logic";

const mail = (id: string, receivedAt: string, extra: Partial<MailMessage> = {}): MailMessage => ({
  id, direction: "inbound", from: "mario@example.test", fromName: "Mario", to: "servizioclienti@crocieriamo.com", subject: "Preventivo", text: "testo", receivedAt, leadId: "l1", leadName: "Mario Rossi", attachments: [], readAt: null, sentBy: "", ...extra
});

describe("email threads", () => {
  it("one conversation per practice, oldest message first, newest conversation on top", () => {
    const threads = groupThreads([
      mail("b", "2026-11-04T10:00:00Z"),
      mail("a", "2026-11-03T10:00:00Z", { direction: "outbound", readAt: "2026-11-03T10:00:00Z" }),
      mail("c", "2026-11-04T11:00:00Z", { leadId: "l2", leadName: "Anna Bianchi" })
    ]);
    expect(threads.map(thread => thread.title)).toEqual(["Anna Bianchi", "Mario Rossi"]);
    expect(threads[1].messages.map(message => message.id)).toEqual(["a", "b"]);
    expect(threads[1].unread).toBe(1);
  });

  it("a sender without a practice stands alone and is named by the email", () => {
    const [thread] = groupThreads([mail("a", "2026-11-04T10:00:00Z", { leadId: null, leadName: "", fromName: "", from: "ignoto@example.test" })]);
    expect([thread.key, thread.title, thread.leadId]).toEqual(["from:ignoto@example.test", "ignoto@example.test", null]);
  });

  it("names the customer's address, also when the CRM wrote first", () => {
    const [first] = groupThreads([mail("a", "2026-11-04T10:00:00Z", { direction: "outbound", from: "servizioclienti@crocieriamo.com", to: "mario@example.test" })]);
    expect(first.from).toBe("mario@example.test");
    const [second] = groupThreads([mail("a", "2026-11-04T10:00:00Z", { direction: "outbound", from: "servizioclienti@crocieriamo.com", to: "mario@example.test" }), mail("b", "2026-11-04T11:00:00Z", { from: "privato@example.test" })]);
    expect(second.from).toBe("privato@example.test");
  });

  it("the reply answers the customer's last message, not the operator's", () => {
    const [thread] = groupThreads([mail("a", "2026-11-04T10:00:00Z"), mail("b", "2026-11-04T11:00:00Z", { direction: "outbound" })]);
    expect(lastInbound(thread)?.id).toBe("a");
  });
});

describe("email texts", () => {
  it("does not stack Re:", () => {
    expect(replySubject("Preventivo")).toBe("Re: Preventivo");
    expect(replySubject("R: Preventivo")).toBe("R: Preventivo");
    expect(replySubject("RE: Preventivo")).toBe("RE: Preventivo");
    expect(replySubject("")).toBe("Re: la tua richiesta");
  });

  it("shows Rome time and readable sizes", () => {
    expect(formatMailTime("2026-11-04T09:05:00Z")).toBe("04/11, 10:05");
    expect(formatAttachmentSize(2 * 1024 * 1024)).toBe("2.0 MB");
    expect(formatAttachmentSize(300)).toBe("1 KB");
  });
});
