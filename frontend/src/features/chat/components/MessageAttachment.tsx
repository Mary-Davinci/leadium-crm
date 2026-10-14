import { useEffect, useState } from "react";
import { Download, ExternalLink, File, FileImage, FileSpreadsheet, FileText, Receipt, RotateCcw, X } from "lucide-react";
import { getInboundMediaUrl, getStoredFileUrl } from "../chat-api";
import { formatFileSize, getAttachmentFamily, getAttachmentKindLabel, getAttachmentTypeLabel, mapChatError } from "../chat.logic";
import type { ChatAttachment } from "../chat.types";

type MessageAttachmentProps = {
  messageId: string;
  attachment: ChatAttachment;
  // Client-side file preview while an outbound message is still uploading/sending.
  localPreviewUrl?: string;
  onOpenPractice?: () => void;
};

function canResolve(messageId: string, attachment: ChatAttachment) {
  if (attachment.documentStorageKey) return true;
  return attachment.direction === "inbound" && Boolean(attachment.mediaId) && !messageId.startsWith("local_");
}

// Outbound files live in our Document Storage (signed URL, practice access re-checked by the
// gateway); inbound files are proxied from WhatsApp's Media API.
function resolveAttachmentUrl(messageId: string, attachment: ChatAttachment) {
  if (attachment.documentStorageKey) return getStoredFileUrl(attachment.documentStorageKey, attachment.filename);
  return getInboundMediaUrl(messageId);
}

function useAttachmentUrl(messageId: string, attachment: ChatAttachment, enabled: boolean) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled || !canResolve(messageId, attachment)) return;
    let cancelled = false;
    setError("");
    resolveAttachmentUrl(messageId, attachment)
      .then((value) => !cancelled && setUrl(value))
      .catch((err) => !cancelled && setError(mapChatError(err, "Anteprima non disponibile.")));
    return () => {
      cancelled = true;
    };
  }, [enabled, messageId, attachment.documentStorageKey, attachment.mediaId, attempt]);

  return { url, error, retry: () => setAttempt((value) => value + 1) };
}

function FamilyIcon({ family }: { family: ReturnType<typeof getAttachmentFamily> }) {
  if (family === "spreadsheet") return <FileSpreadsheet size={22} aria-hidden="true" />;
  if (family === "pdf" || family === "word") return <FileText size={22} aria-hidden="true" />;
  if (family === "image") return <FileImage size={22} aria-hidden="true" />;
  return <File size={22} aria-hidden="true" />;
}

export function MessageAttachment({ messageId, attachment, localPreviewUrl, onOpenPractice }: MessageAttachmentProps) {
  const family = getAttachmentFamily(attachment);
  const isImage = family === "image";
  const { url, error, retry } = useAttachmentUrl(messageId, attachment, isImage && !localPreviewUrl);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState("");
  const name = attachment.filename || (isImage ? "Immagine" : "Documento");
  const kindLabel = getAttachmentKindLabel(attachment.kind);
  const available = canResolve(messageId, attachment);
  const imageSrc = localPreviewUrl || url;

  async function openFile() {
    if (!available || opening) return;
    setOpening(true);
    setOpenError("");
    try {
      const target = url || (await resolveAttachmentUrl(messageId, attachment));
      window.open(target, "_blank", "noopener,noreferrer");
    } catch (err) {
      setOpenError(mapChatError(err, "Impossibile aprire il file."));
    } finally {
      setOpening(false);
    }
  }

  useEffect(() => {
    if (!lightboxOpen) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setLightboxOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightboxOpen]);

  if (isImage) {
    return (
      <div className="chat-att-image">
        {imageSrc ? (
          <button type="button" className="chat-att-image-button" onClick={() => setLightboxOpen(true)} aria-label={`Apri anteprima ${name}`}>
            <img src={imageSrc} alt={attachment.caption || name} loading="lazy" />
          </button>
        ) : (
          <div className="chat-att-image-placeholder">
            <FileImage size={26} aria-hidden="true" />
            {error ? (
              <>
                <span>{error}</span>
                <button type="button" className="chat-link-button" onClick={retry}>
                  <RotateCcw size={13} aria-hidden="true" /> Riprova
                </button>
              </>
            ) : (
              <span>{available ? "Caricamento immagine..." : "Immagine non disponibile"}</span>
            )}
          </div>
        )}
        {lightboxOpen && imageSrc ? (
          <div className="chat-lightbox" role="dialog" aria-modal="true" aria-label={name} onClick={() => setLightboxOpen(false)}>
            <div className="chat-lightbox-bar" onClick={(event) => event.stopPropagation()}>
              <span>{name}</span>
              <a href={imageSrc} download={name} className="chat-icon-button light" aria-label="Scarica immagine">
                <Download size={18} aria-hidden="true" />
              </a>
              <button type="button" className="chat-icon-button light" onClick={() => setLightboxOpen(false)} aria-label="Chiudi anteprima" autoFocus>
                <X size={18} aria-hidden="true" />
              </button>
            </div>
            <img src={imageSrc} alt={attachment.caption || name} onClick={(event) => event.stopPropagation()} />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className={`chat-att-doc ${attachment.kind === "quote" ? "quote" : ""}`}>
      {kindLabel ? (
        <span className="chat-att-kind">
          {attachment.kind === "quote" ? <Receipt size={12} aria-hidden="true" /> : null}
          {kindLabel}
        </span>
      ) : null}
      <div className="chat-att-doc-row">
        <span className={`chat-att-doc-icon ${family}`}>
          <FamilyIcon family={family} />
        </span>
        <div className="chat-att-doc-copy">
          <strong title={name}>{name}</strong>
          <span>{[getAttachmentTypeLabel(attachment), formatFileSize(attachment.size)].filter(Boolean).join(" · ")}</span>
        </div>
        <button
          type="button"
          className="chat-icon-button"
          onClick={() => void openFile()}
          disabled={!available || opening}
          aria-label={family === "pdf" || family === "audio" || family === "video" ? `Apri ${name}` : `Scarica ${name}`}
          title={available ? undefined : "File non disponibile"}
        >
          {family === "pdf" ? <ExternalLink size={17} aria-hidden="true" /> : <Download size={17} aria-hidden="true" />}
        </button>
      </div>
      {openError ? <span className="chat-att-error">{openError}</span> : null}
      {attachment.kind === "quote" && onOpenPractice ? (
        <button type="button" className="chat-link-button" onClick={onOpenPractice}>
          Apri pratica
        </button>
      ) : null}
    </div>
  );
}
