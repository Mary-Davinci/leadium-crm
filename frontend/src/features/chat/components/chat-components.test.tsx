import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DraftAttachment, Message, TemplateOption } from "../chat.types";
import { ChatHeader } from "./ChatHeader";
import { Composer } from "./Composer";
import { ConversationList, type ConversationRow } from "./ConversationList";
import { MessageBubble } from "./MessageBubble";

const noop = () => undefined;
const counts = { all: 2, unread: 1, mine: 0, unassigned: 1, waiting: 0, resolved: 0 };

function row(overrides: Partial<ConversationRow>): ConversationRow {
  return {
    id: "c1",
    customerName: "Lucia Bianchi",
    phone: "393451112222",
    lastMessagePreview: "Ciao, ho una domanda",
    lastMessageAt: new Date().toISOString(),
    unreadCount: 0,
    status: "open",
    assignedTo: "",
    operational: { pendingPaymentCount: 0, missingDocumentCount: 0 },
    ...overrides
  };
}

function renderList(props: Partial<Parameters<typeof ConversationList>[0]> = {}) {
  return renderToStaticMarkup(
    <ConversationList
      rows={[row({ id: "c1", unreadCount: 4 }), row({ id: "c2", customerName: "Mario Rossi", assignedTo: "marco" })]}
      counts={counts}
      filter="all"
      search=""
      selectedId="c2"
      authUsername="marco"
      loading={false}
      error=""
      onFilterChange={noop}
      onSearchChange={noop}
      onSelect={noop}
      onRetry={noop}
      onStartChat={async () => ""}
      {...props}
    />
  );
}

describe("ConversationList", () => {
  it("renders each conversation with unread badge, assignee and the open one highlighted", () => {
    const html = renderList();
    expect(html).toContain("Lucia Bianchi");
    expect(html).toContain('aria-label="4 messaggi non letti"');
    expect(html).toContain("Da assegnare");
    expect(html).toMatch(/class="chat-conv active[^"]*"[^>]*aria-current="true"/);
    expect(html).toContain(">Tu<");
  });

  it("shows skeleton rows while loading and a filter-specific empty state", () => {
    expect(renderList({ rows: [], loading: true })).toContain("chat-conv-skeleton");
    expect(renderList({ rows: [], filter: "unread" })).toContain("Nessuna conversazione da leggere.");
    expect(renderList({ rows: [], search: "zzz" })).toContain("Nessun risultato per");
  });
});

describe("MessageBubble", () => {
  const base: Message = { id: "m1", direction: "outbound", text: "Ecco il link https://crocieriamo.com", createdAt: "2026-10-14T10:05:00Z", status: "delivered" };

  it("renders text with clickable links and delivery status", () => {
    const html = renderToStaticMarkup(<MessageBubble message={base} />);
    expect(html).toContain('href="https://crocieriamo.com"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("Consegnato");
  });

  it("shows a failed send with retry and discard actions", () => {
    const html = renderToStaticMarkup(
      <MessageBubble message={{ ...base, localState: "failed", localError: "Connessione assente." }} onRetry={noop} onDiscard={noop} />
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Connessione assente.");
    expect(html).toContain("Riprova");
    expect(html).toContain("Elimina");
  });

  it("renders a quote attachment as a highlighted document card", () => {
    const html = renderToStaticMarkup(
      <MessageBubble
        message={{
          ...base,
          text: "preventivo.pdf",
          attachment: { direction: "outbound", mediaType: "document", filename: "preventivo.pdf", mimeType: "application/pdf", size: 204800, kind: "quote", documentStorageKey: "lead-documents/l1/chat_quote/x-preventivo.pdf" }
        }}
        onOpenPractice={noop}
      />
    );
    expect(html).toContain("chat-att-doc quote");
    expect(html).toContain("Preventivo");
    expect(html).toContain("PDF · 200 KB");
    expect(html).toContain("Apri pratica");
    // The file name is in the card, not repeated as message text.
    expect(html).not.toContain("chat-msg-text");
  });
});

const templates: TemplateOption[] = [{ key: "request_documents", name: "request_documents", label: "Richiesta documenti", body: "Ci servono i documenti.", category: "utility" }];

function renderComposer(props: Partial<Parameters<typeof Composer>[0]> = {}) {
  return renderToStaticMarkup(
    <Composer
      textAreaRef={createRef<HTMLTextAreaElement>()}
      mode="text"
      replyWindowOpen
      templates={templates}
      selectedTemplate={templates[0]}
      text=""
      drafts={[]}
      practiceDocuments={[]}
      attachmentsDisabledReason=""
      fileError=""
      sending={false}
      onModeChange={noop}
      onTemplateChange={noop}
      onTextChange={noop}
      onAddFiles={noop}
      onPickPracticeDocument={noop}
      onRemoveDraft={noop}
      onDismissFileError={noop}
      onSubmit={noop}
      {...props}
    />
  );
}

describe("Composer", () => {
  it("offers emoji, attachments and a disabled send button while empty", () => {
    const html = renderComposer();
    expect(html).toContain('aria-label="Inserisci emoji"');
    expect(html).toContain('aria-label="Allega"');
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""[^>]*aria-label="Invia messaggio"/);
  });

  it("previews pending attachments with name, type, size, MIME and a remove button", () => {
    const drafts: DraftAttachment[] = [
      {
        id: "d1",
        source: "upload",
        kind: "quote",
        file: {} as File,
        name: "offerta.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        size: 3 * 1024 * 1024
      }
    ];
    const html = renderComposer({ drafts });
    expect(html).toContain("offerta.xlsx");
    expect(html).toContain("Preventivo · XLSX · 3,0 MB");
    expect(html).toContain("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(html).toContain('aria-label="Rimuovi offerta.xlsx"');
    expect(html).not.toMatch(/<button type="submit"[^>]*disabled=""/);
  });

  it("shows file validation errors", () => {
    expect(renderComposer({ fileError: '"virus.exe": formato non supportato.' })).toContain("formato non supportato");
  });

  it("disables attachments with a reason when the chat has no practice", () => {
    const html = renderComposer({ attachmentsDisabledReason: "Per inviare allegati la conversazione deve essere collegata a una pratica." });
    expect(html).toMatch(/aria-label="Allega"[^>]*disabled=""|disabled=""[^>]*aria-label="Allega"/);
    expect(html).toContain("collegata a una pratica");
  });

  it("switches to template-only mode when the 24h window is closed", () => {
    const html = renderComposer({ mode: "template", replyWindowOpen: false });
    expect(html).toContain("Finestra di 24 ore chiusa");
    expect(html).toContain("Richiesta documenti");
    expect(html).toContain("Ci servono i documenti.");
    expect(html).not.toContain("Torna al testo libero");
    expect(html).not.toContain('aria-label="Allega"');
  });
});

describe("ChatHeader", () => {
  const header = (assignedTo: string) =>
    renderToStaticMarkup(
      <ChatHeader
        conversation={{ id: "c1", assignedTo, status: "open" }}
        displayName="Lucia Bianchi"
        displayPhone="+39 345 111 2222"
        replyWindow={{ open: true, expiresAt: null, label: "Finestra aperta · 5 h", urgent: false }}
        authUsername="marco"
        busy={false}
        infoOpen
        hasLinkedPractice={false}
        onBack={noop}
        onToggleInfo={noop}
        onAssignToMe={noop}
        onRelease={noop}
        onMarkUnread={noop}
        onSetStatus={noop}
        onOpenPractice={noop}
        onCopyPhone={noop}
      />
    );

  it("shows identity, 24h window and an assign action for unassigned chats", () => {
    const html = header("");
    expect(html).toContain("Lucia Bianchi");
    expect(html).toContain("Finestra aperta · 5 h");
    expect(html).toContain("Da assegnare");
    expect(html).toContain("Prendi in carico");
    expect(html).toContain('aria-label="Azioni conversazione"');
    expect(html).toMatch(/aria-label="Apri pratica"[^>]*title="Nessuna pratica collegata"|disabled=""[^>]*aria-label="Apri pratica"/);
  });

  it("hides the assign shortcut once the chat is mine", () => {
    const html = header("marco");
    expect(html).toContain("In carico a te");
    expect(html).not.toContain("Prendi in carico</span>");
  });
});
