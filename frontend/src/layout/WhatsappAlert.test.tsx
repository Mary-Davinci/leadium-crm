import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { formatWaitingPhone, WhatsappAlertCards, type WaitingChat } from "./WhatsappAlert";

const chat = (id: string): WaitingChat => ({ id, phone: "393331112222", lastInboundAt: null });
const cards = (chats: WaitingChat[], notice = "", busyId = "") =>
  renderToStaticMarkup(<WhatsappAlertCards chats={chats} busyId={busyId} notice={notice} onTake={() => {}} />);

describe("WhatsApp alert", () => {
  it("announces the number and the action", () => {
    const html = cards([chat("a")]);
    expect(html).toContain("Ti scrive +393331112222");
    expect(html).toContain("Clicca per rispondere");
  });

  it("keeps a plus already in the number", () => {
    expect(formatWaitingPhone("+39333")).toBe("+39333");
  });

  it("shows three customers and counts the others", () => {
    const html = cards(["a", "b", "c", "d", "e"].map(chat));
    expect(html.match(/wa-alert-card"/g)).toHaveLength(3);
    expect(html).toContain("Altri 2 in attesa");
  });

  it("says when a colleague was faster and blocks a double click", () => {
    expect(cards([], "Un collega ha gia preso questa chat.")).toContain("Un collega ha gia preso questa chat.");
    const busy = cards([chat("a")], "", "a");
    expect(busy).toContain("Apro la chat");
    expect(busy).toContain("disabled");
  });
});
