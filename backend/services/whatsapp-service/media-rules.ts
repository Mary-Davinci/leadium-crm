// Rules for media crossing the WhatsApp boundary, kept pure so they can be tested without Meta.

// Meta only accepts JPEG/PNG up to 5 MB as type "image"; anything else that is still a valid
// stored file (WEBP, HEIC, larger photos) has to go out as a "document" or Meta rejects it.
const META_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png"]);
export const META_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

export function resolveOutboundMediaType(mimeType: string, size?: number): "image" | "document" {
  const mime = String(mimeType || "").trim().toLowerCase();
  if (!META_IMAGE_MIME_TYPES.has(mime)) return "document";
  const bytes = Number(size || 0);
  if (bytes > META_IMAGE_MAX_BYTES) return "document";
  return "image";
}

export const ATTACHMENT_KINDS = new Set(["file", "quote", "practice_document"]);

export function normalizeAttachmentKind(value: unknown) {
  const kind = String(value || "").trim();
  return ATTACHMENT_KINDS.has(kind) ? kind : "file";
}

// Display/Content-Disposition name only (storage keys are built separately and already
// sanitized): strips path separators, control and quote characters so the name can't escape a
// header value or pretend to be a path.
export function sanitizeAttachmentFilename(value: unknown, fallback = "documento") {
  const cleaned = String(value || "")
    .replace(/[\u0000-\u001f\u007f"\\/<>:|?*]+/g, "_")
    .replace(/^[.\s_]+/, "")
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

// Inbound media proxied back to operators: only types a browser renders safely inline are served
// inline; everything else (office files, archives, unknown) is forced to download, and nosniff
// is always set by the caller so a mislabeled HTML/SVG body can never execute.
const INLINE_SAFE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "video/mp4"
]);

export function isInlineSafeMime(mimeType: string) {
  return INLINE_SAFE_MIME_TYPES.has(String(mimeType || "").split(";")[0].trim().toLowerCase());
}

export const INBOUND_MEDIA_MAX_BYTES = 16 * 1024 * 1024;
