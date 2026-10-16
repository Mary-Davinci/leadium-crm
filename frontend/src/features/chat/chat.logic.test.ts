import { describe, expect, it } from "vitest";
import {
  buildThreadItems,
  countConversationFilters,
  filterConversations,
  formatFileSize,
  getAttachmentFamily,
  getChatLayoutMode,
  getMessageStatusMeta,
  getReplyWindowState,
  isInfoPanelInitiallyOpen,
  mapChatError,
  normalizeNewChatPhone,
  renderTemplatePreview,
  getTemplateParameterError,
  shouldCloseListOnSelect,
  tokenizeMessageText,
  validateChatFile
} from "./chat.logic";
import type { Conversation, Message } from "./chat.types";

const NOW = new Date("2026-10-14T12:00:00Z");

function conversation(overrides: Partial<Conversation>): Conversation {
  return { id: "c", customerName: "Cliente", phone: "393331112222", unreadCount: 0, status: "open", assignedTo: "", ...overrides };
}

const inbox: Conversation[] = [
  conversation({ id: "old", customerName: "Mario Rossi", lastMessageAt: "2026-10-12T09:00:00Z", assignedTo: "anna" }),
  conversation({ id: "new", customerName: "Lucia Bianchi", phone: "+39 345 999 0000", lastMessageAt: "2026-10-14T11:00:00Z", unreadCount: 3 }),
  conversation({ id: "mid", customerName: "Paolo Verdi", lastMessageAt: "2026-10-13T10:00:00Z", status: "waiting_customer", assignedTo: "marco" }),
  conversation({ id: "done", customerName: "Sara Neri", lastMessageAt: "2026-10-10T10:00:00Z", status: "resolved" })
];

describe("conversation list", () => {
  it("orders conversations by last message, newest first", () => {
    const rows = filterConversations(inbox, { filter: "all", search: "", username: "marco" });
    expect(rows.map((row) => row.id)).toEqual(["new", "mid", "old", "done"]);
  });

  it("filters unread, mine, unassigned, waiting and resolved", () => {
    const ids = (filter: Parameters<typeof filterConversations>[1]["filter"]) =>
      filterConversations(inbox, { filter, search: "", username: "marco" }).map((row) => row.id);
    expect(ids("unread")).toEqual(["new"]);
    expect(ids("mine")).toEqual(["mid"]);
    // Resolved conversations are not a queue to pick up, even without an operator.
    expect(ids("unassigned")).toEqual(["new"]);
    expect(ids("waiting")).toEqual(["mid"]);
    expect(ids("resolved")).toEqual(["done"]);
  });

  it("searches by name and by phone digits regardless of formatting", () => {
    expect(filterConversations(inbox, { filter: "all", search: "lucia", username: "" }).map((row) => row.id)).toEqual(["new"]);
    expect(filterConversations(inbox, { filter: "all", search: "345999", username: "" }).map((row) => row.id)).toEqual(["new"]);
  });

  it("counts every filter for the chips", () => {
    expect(countConversationFilters(inbox, "marco")).toEqual({ all: 4, unread: 1, mine: 1, unassigned: 1, waiting: 1, resolved: 1 });
  });
});

describe("24h reply window", () => {
  it("is open with the remaining time while the window has not expired", () => {
    const state = getReplyWindowState(conversation({ hasOpenSession: true, replyWindowExpiresAt: "2026-10-14T17:30:00Z" }), NOW);
    expect(state.open).toBe(true);
    expect(state.label).toBe("Finestra aperta · 5 h");
    expect(state.urgent).toBe(false);
  });

  it("flags the last two hours as urgent", () => {
    const state = getReplyWindowState(conversation({ hasOpenSession: true, replyWindowExpiresAt: "2026-10-14T12:40:00Z" }), NOW);
    expect(state.urgent).toBe(true);
    expect(state.label).toBe("Finestra aperta · 40 min");
  });

  it("is closed when expired or never opened", () => {
    expect(getReplyWindowState(conversation({ hasOpenSession: true, replyWindowExpiresAt: "2026-10-14T11:00:00Z" }), NOW).open).toBe(false);
    expect(getReplyWindowState(conversation({ hasOpenSession: false }), NOW).open).toBe(false);
    expect(getReplyWindowState(null, NOW).open).toBe(false);
  });
});

describe("thread", () => {
  it("inserts a date separator whenever the day changes", () => {
    const messages = [
      { id: "m1", direction: "inbound", text: "Ciao", createdAt: "2026-10-13T09:00:00Z" },
      { id: "m2", direction: "outbound", text: "Buongiorno", createdAt: "2026-10-14T08:00:00Z" },
      { id: "m3", direction: "inbound", text: "Grazie", createdAt: "2026-10-14T09:00:00Z" }
    ] as Message[];
    const items = buildThreadItems(messages, [], NOW);
    expect(items.map((item) => (item.type === "day" ? item.label : item.key))).toEqual(["Ieri", "m1", "Oggi", "m2", "m3"]);
  });

  it("turns only http(s) and www links into links", () => {
    const tokens = tokenizeMessageText("Vedi https://crocieriamo.com/offerta, oppure www.msc.it. Non javascript:alert(1)");
    expect(tokens.filter((token) => token.type === "link").map((token) => (token.type === "link" ? token.href : ""))).toEqual([
      "https://crocieriamo.com/offerta",
      "https://www.msc.it"
    ]);
  });

  it("describes local send states and WhatsApp delivery states", () => {
    expect(getMessageStatusMeta({ localState: "sending" })?.tone).toBe("pending");
    expect(getMessageStatusMeta({ localState: "failed", status: "sent" })?.tone).toBe("failed");
    expect(getMessageStatusMeta({ status: "read" })?.label).toBe("Letto");
    expect(getMessageStatusMeta({ status: "received" })).toBeNull();
  });
});

describe("attachments", () => {
  const MB = 1024 * 1024;

  it("accepts images, PDF, Word, Excel and CSV and derives the MIME from the extension", () => {
    expect(validateChatFile({ name: "foto.JPG", type: "image/jpeg", size: MB }, "image")).toEqual({ ok: true, mimeType: "image/jpeg" });
    expect(validateChatFile({ name: "preventivo.xlsx", type: "", size: MB }, "quote")).toEqual({
      ok: true,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    });
    // Windows reports CSV as an Excel MIME: the extension wins.
    expect(validateChatFile({ name: "passeggeri.csv", type: "application/vnd.ms-excel", size: 2000 }, "document")).toEqual({ ok: true, mimeType: "text/csv" });
    expect(validateChatFile({ name: "lista.xls", size: 2000 }, "document")).toMatchObject({ ok: true });
  });

  it("rejects unsupported, executable or markup files", () => {
    for (const name of ["virus.exe", "pagina.html", "logo.svg", "archivio.zip", "senza-estensione"]) {
      expect(validateChatFile({ name, size: 1000 }, "document").ok).toBe(false);
    }
  });

  it("rejects files above 8 MB and empty files", () => {
    expect(validateChatFile({ name: "grande.pdf", size: 9 * MB }, "document")).toMatchObject({ ok: false, error: expect.stringContaining("8 MB") });
    expect(validateChatFile({ name: "vuoto.pdf", size: 0 }, "document").ok).toBe(false);
  });

  it("restricts each menu option to its own formats", () => {
    expect(validateChatFile({ name: "contratto.pdf", size: 1000 }, "image").ok).toBe(false);
    expect(validateChatFile({ name: "foto.png", size: 1000 }, "quote").ok).toBe(false);
  });

  it("groups attachments by visual family", () => {
    expect(getAttachmentFamily({ mimeType: "application/pdf" })).toBe("pdf");
    expect(getAttachmentFamily({ filename: "q.xlsx" })).toBe("spreadsheet");
    expect(getAttachmentFamily({ mediaType: "image" })).toBe("image");
    expect(getAttachmentFamily({ filename: "x.bin" })).toBe("file");
    expect(formatFileSize(1536 * 1024)).toBe("1,5 MB");
  });
});

describe("error messages", () => {
  it("keeps operator-readable backend messages", () => {
    expect(mapChatError(new Error("Il file supera il limite di 8 MB."))).toBe("Il file supera il limite di 8 MB.");
  });

  it("never shows raw provider payloads or stack traces", () => {
    expect(mapChatError(new Error('Meta send failed (400): {"error":{"code":131047}}'))).not.toContain("{");
    expect(mapChatError(new Error("TypeError: Cannot read properties of undefined"))).toBe("Operazione non riuscita. Riprova tra qualche secondo.");
  });

  it("explains network failures and closed windows", () => {
    expect(mapChatError(new Error("Failed to fetch"))).toContain("Connessione");
    expect(mapChatError(new Error("La finestra di risposta WhatsApp e chiusa. Usa un template approvato."))).toContain("template approvato");
    expect(mapChatError(new Error("Storage documenti non configurato."))).toContain("allegati");
  });
});

describe("responsive layout", () => {
  it("maps the viewport to the four chat layouts", () => {
    expect([1440, 1280, 1279, 1024, 1023, 768, 767, 375].map(getChatLayoutMode)).toEqual([
      "wide",
      "wide",
      "medium",
      "medium",
      "narrow",
      "narrow",
      "mobile",
      "mobile"
    ]);
  });

  it("collapses the contact panel below 1280px and the list below 1024px", () => {
    expect(isInfoPanelInitiallyOpen("wide")).toBe(true);
    expect(isInfoPanelInitiallyOpen("medium")).toBe(false);
    expect(shouldCloseListOnSelect("medium")).toBe(false);
    expect(shouldCloseListOnSelect("narrow")).toBe(true);
    expect(shouldCloseListOnSelect("mobile")).toBe(true);
  });
});

describe("new chat phone", () => {
  it("normalizes to international digits and adds 39 to bare Italian mobiles", () => {
    expect(normalizeNewChatPhone("+39 333 123 4567").phone).toBe("393331234567");
    expect(normalizeNewChatPhone("0039 333 1234567").phone).toBe("393331234567");
    expect(normalizeNewChatPhone("333 1234567").phone).toBe("393331234567");
    expect(normalizeNewChatPhone("+44 7700 900123").phone).toBe("447700900123");
  });

  it("rejects empty or implausible numbers", () => {
    expect(normalizeNewChatPhone("").error).not.toBe("");
    expect(normalizeNewChatPhone("12345").error).not.toBe("");
    expect(normalizeNewChatPhone("1234567890123456").error).not.toBe("");
  });
});

describe("template preview", () => {
  const template = {
    body: "Ciao, abbiamo ricevuto la tua richiesta per {{1}}.",
    parameters: [{ name: "destination", label: "Prodotto / destinazione", component: "body" as const, index: 1 }]
  };

  it("replaces {{1}} with the operator value", () => {
    expect(renderTemplatePreview(template, { destination: "Fiordi" })).toBe("Ciao, abbiamo ricevuto la tua richiesta per Fiordi.");
  });

  it("shows the missing field label instead of an empty variable", () => {
    expect(renderTemplatePreview(template, {})).toContain("[Prodotto / destinazione]");
  });

  it("leaves legacy templates without variables unchanged", () => {
    expect(renderTemplatePreview({ body: "Testo fisso" }, {})).toBe("Testo fisso");
  });
});

describe("required Meta variables before sending", () => {
  const template = { key: "quote_ready", name: "quote_ready", label: "Preventivo", body: "{{1}}", category: "utility" as const,
    parameters: [{ name: "quote_url", label: "Link preventivo", component: "body" as const, index: 1, kind: "url" as const, required: true }] };
  it("blocks empty, malformed and unsafe quote URLs", () => {
    for (const quote_url of ["", "preventivo.pdf", "javascript:alert(1)", "https://"]) {
      expect(getTemplateParameterError(template, { quote_url })).not.toBe("");
    }
    expect(getTemplateParameterError(template, { quote_url: "https://example.com/quote" })).toBe("");
  });
  it("requires destination only when declared by the selected template", () => {
    const destination = { ...template, parameters: [{ ...template.parameters[0], name: "destination", kind: "text" as const }] };
    expect(getTemplateParameterError(destination, {})).not.toBe("");
    expect(getTemplateParameterError(destination, { destination: "Fiordi" })).toBe("");
    expect(getTemplateParameterError({ ...template, parameters: [] }, {})).toBe("");
  });
});
