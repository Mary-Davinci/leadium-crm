import { ChangeEvent, FormEvent, RefObject, useRef } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { FileText, FolderOpen, Image, LayoutTemplate, Paperclip, Receipt, SendHorizontal, Smile, X } from "lucide-react";
import { ATTACHMENT_ACCEPT, formatFileSize, getAttachmentFamily, getAttachmentKindLabel, getAttachmentTypeLabel } from "../chat.logic";
import type { DraftAttachment, MessageMode, PracticeDocumentOption, TemplateOption } from "../chat.types";

type FilePurpose = "image" | "document" | "quote";

type ComposerProps = {
  textAreaRef: RefObject<HTMLTextAreaElement | null>;
  mode: MessageMode;
  replyWindowOpen: boolean;
  templates: TemplateOption[];
  selectedTemplate: TemplateOption | null;
  text: string;
  drafts: DraftAttachment[];
  practiceDocuments: PracticeDocumentOption[];
  attachmentsDisabledReason: string;
  fileError: string;
  sending: boolean;
  onModeChange: (mode: MessageMode) => void;
  onTemplateChange: (templateKey: string) => void;
  onTextChange: (value: string) => void;
  onAddFiles: (files: File[], purpose: FilePurpose) => void;
  onPickPracticeDocument: (option: PracticeDocumentOption) => void;
  onRemoveDraft: (draftId: string) => void;
  onDismissFileError: () => void;
  onSubmit: () => void;
};

const EMOJIS = ["😊", "🙂", "😉", "😀", "😂", "🙏", "👍", "👌", "👋", "🤝", "👏", "💪", "❤️", "✨", "🎉", "✅", "📄", "📎", "📅", "⏰", "💶", "💳", "✈️", "🚢", "🌊", "☀️", "🏝️", "🧳", "📞", "📍", "❗", "❓"];

const MAX_TEXTAREA_PX = 140;

function DraftPreview({ draft, onRemove }: { draft: DraftAttachment; onRemove: () => void }) {
  const family = getAttachmentFamily({ mimeType: draft.mimeType, filename: draft.name });
  const kindLabel = getAttachmentKindLabel(draft.kind);
  return (
    <li className={`chat-draft ${draft.kind === "quote" ? "quote" : ""}`}>
      {draft.source === "upload" && draft.previewUrl ? (
        <img src={draft.previewUrl} alt="" className="chat-draft-thumb" />
      ) : (
        <span className={`chat-att-doc-icon ${family}`} aria-hidden="true">
          {draft.kind === "quote" ? <Receipt size={18} /> : <FileText size={18} />}
        </span>
      )}
      <span className="chat-draft-copy">
        <strong title={draft.name}>{draft.name}</strong>
        <span>
          {[kindLabel, getAttachmentTypeLabel({ mimeType: draft.mimeType, filename: draft.name }), formatFileSize(draft.size)].filter(Boolean).join(" · ")}
        </span>
        <span className="chat-draft-mime">{draft.mimeType}</span>
      </span>
      <button type="button" className="chat-icon-button small" onClick={onRemove} aria-label={`Rimuovi ${draft.name}`}>
        <X size={15} aria-hidden="true" />
      </button>
    </li>
  );
}

export function Composer({
  textAreaRef,
  mode,
  replyWindowOpen,
  templates,
  selectedTemplate,
  text,
  drafts,
  practiceDocuments,
  attachmentsDisabledReason,
  fileError,
  sending,
  onModeChange,
  onTemplateChange,
  onTextChange,
  onAddFiles,
  onPickPracticeDocument,
  onRemoveDraft,
  onDismissFileError,
  onSubmit
}: ComposerProps) {
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const documentInputRef = useRef<HTMLInputElement | null>(null);
  const quoteInputRef = useRef<HTMLInputElement | null>(null);
  const canSendText = Boolean(text.trim()) || drafts.length > 0;

  function handleFiles(event: ChangeEvent<HTMLInputElement>, purpose: FilePurpose) {
    const files = Array.from(event.target.files || []);
    // Reset so picking the same file again (after removing it) still fires a change event.
    event.target.value = "";
    if (files.length) onAddFiles(files, purpose);
  }

  function insertEmoji(emoji: string) {
    const node = textAreaRef.current;
    if (!node) {
      onTextChange(`${text}${emoji}`);
      return;
    }
    const start = node.selectionStart ?? text.length;
    const end = node.selectionEnd ?? text.length;
    onTextChange(`${text.slice(0, start)}${emoji}${text.slice(end)}`);
    window.requestAnimationFrame(() => {
      node.focus();
      node.setSelectionRange(start + emoji.length, start + emoji.length);
    });
  }

  function autoGrow(node: HTMLTextAreaElement) {
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, MAX_TEXTAREA_PX)}px`;
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit();
  }

  if (mode === "template") {
    return (
      <form className="chat-composer template" onSubmit={submit}>
        <div className="chat-template-head">
          <LayoutTemplate size={15} aria-hidden="true" />
          <span>
            {replyWindowOpen
              ? "Messaggio da template approvato"
              : "Finestra di 24 ore chiusa: puoi inviare solo un template approvato. La finestra si riapre quando il cliente risponde."}
          </span>
          {replyWindowOpen ? (
            <button type="button" className="chat-link-button" onClick={() => onModeChange("text")}>
              Torna al testo libero
            </button>
          ) : null}
        </div>
        <div className="chat-template-row">
          <label className="sr-only" htmlFor="chat-template-select">
            Template
          </label>
          <select id="chat-template-select" value={selectedTemplate?.key || ""} onChange={(event) => onTemplateChange(event.target.value)}>
            {templates.map((template) => (
              <option key={template.key} value={template.key}>
                {template.label}
              </option>
            ))}
          </select>
          <button type="submit" className="chat-send-button" disabled={sending || !selectedTemplate} aria-label="Invia template">
            <SendHorizontal size={19} aria-hidden="true" />
          </button>
        </div>
        {selectedTemplate?.body ? <p className="chat-template-preview">{selectedTemplate.body}</p> : null}
      </form>
    );
  }

  const attachDisabled = Boolean(attachmentsDisabledReason);

  return (
    <form className="chat-composer" onSubmit={submit}>
      {drafts.length ? (
        <ul className="chat-drafts" aria-label="Allegati da inviare">
          {drafts.map((draft) => (
            <DraftPreview key={draft.id} draft={draft} onRemove={() => onRemoveDraft(draft.id)} />
          ))}
        </ul>
      ) : null}
      {fileError ? (
        <div className="chat-inline-alert error" role="alert">
          <span>{fileError}</span>
          <button type="button" className="chat-icon-button small" onClick={onDismissFileError} aria-label="Chiudi avviso">
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      ) : null}
      <div className="chat-composer-row">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button type="button" className="chat-icon-button" aria-label="Inserisci emoji">
              <Smile size={21} aria-hidden="true" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="chat-menu chat-emoji-menu" side="top" align="start" sideOffset={8}>
              {EMOJIS.map((emoji) => (
                <DropdownMenu.Item
                  key={emoji}
                  className="chat-emoji"
                  onSelect={(event) => {
                    // Keep the picker open so several emoji can be added in a row.
                    event.preventDefault();
                    insertEmoji(emoji);
                  }}
                >
                  {emoji}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>

        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className="chat-icon-button"
              aria-label="Allega"
              disabled={attachDisabled}
              title={attachmentsDisabledReason || "Allega"}
            >
              <Paperclip size={20} aria-hidden="true" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="chat-menu" side="top" align="start" sideOffset={8}>
              <DropdownMenu.Label className="chat-menu-label">Allega</DropdownMenu.Label>
              <DropdownMenu.Item className="chat-menu-item" onSelect={() => imageInputRef.current?.click()}>
                <Image size={16} aria-hidden="true" /> Foto o immagine
              </DropdownMenu.Item>
              <DropdownMenu.Item className="chat-menu-item" onSelect={() => documentInputRef.current?.click()}>
                <FileText size={16} aria-hidden="true" /> Documento
                <span className="chat-menu-hint">PDF, Word, Excel, CSV</span>
              </DropdownMenu.Item>
              <DropdownMenu.Item className="chat-menu-item" onSelect={() => quoteInputRef.current?.click()}>
                <Receipt size={16} aria-hidden="true" /> Preventivo
              </DropdownMenu.Item>
              <DropdownMenu.Sub>
                <DropdownMenu.SubTrigger className="chat-menu-item">
                  <FolderOpen size={16} aria-hidden="true" /> Documento pratica
                </DropdownMenu.SubTrigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.SubContent className="chat-menu chat-practice-docs" sideOffset={6}>
                    {practiceDocuments.length ? (
                      practiceDocuments.map((option) => (
                        <DropdownMenu.Item key={option.attachment.storageKey} className="chat-menu-item stacked" onSelect={() => onPickPracticeDocument(option)}>
                          <strong>{option.attachment.name}</strong>
                          <span>{option.documentLabel}</span>
                        </DropdownMenu.Item>
                      ))
                    ) : (
                      <DropdownMenu.Item className="chat-menu-item" disabled>
                        Nessun documento caricato nella pratica
                      </DropdownMenu.Item>
                    )}
                  </DropdownMenu.SubContent>
                </DropdownMenu.Portal>
              </DropdownMenu.Sub>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>

        <label className="sr-only" htmlFor="chat-message-input">
          Messaggio
        </label>
        <textarea
          id="chat-message-input"
          ref={textAreaRef}
          className="chat-input"
          value={text}
          rows={1}
          placeholder={drafts.length ? "Aggiungi una didascalia (facoltativa)" : "Scrivi un messaggio"}
          onChange={(event) => {
            onTextChange(event.target.value);
            autoGrow(event.target);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <button
          type="button"
          className="chat-icon-button"
          onClick={() => onModeChange("template")}
          aria-label="Usa un template"
          title="Usa un template"
        >
          <LayoutTemplate size={19} aria-hidden="true" />
        </button>
        <button type="submit" className="chat-send-button" disabled={sending || !canSendText} aria-label="Invia messaggio">
          <SendHorizontal size={19} aria-hidden="true" />
        </button>
      </div>
      {attachDisabled ? <p className="chat-composer-hint">{attachmentsDisabledReason}</p> : null}
      <input ref={imageInputRef} type="file" hidden multiple accept={ATTACHMENT_ACCEPT.image} onChange={(event) => handleFiles(event, "image")} />
      <input ref={documentInputRef} type="file" hidden multiple accept={ATTACHMENT_ACCEPT.document} onChange={(event) => handleFiles(event, "document")} />
      <input ref={quoteInputRef} type="file" hidden accept={ATTACHMENT_ACCEPT.quote} onChange={(event) => handleFiles(event, "quote")} />
    </form>
  );
}
