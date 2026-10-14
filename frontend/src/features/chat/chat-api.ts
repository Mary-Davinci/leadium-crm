import { api } from "../../lib/api";
import { apiUrl } from "../../lib/api-url";
import { clearSession, getAuthToken } from "../../lib/auth";
import type { AttachmentKind } from "./chat.types";

export type StoredChatFile = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  storageKey: string;
};

function authHeaders(): Record<string, string> {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function readError(response: Response, fallback: string) {
  if (response.status === 401) clearSession();
  const raw = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(raw) as { error?: string };
    return new Error(parsed.error || fallback);
  } catch {
    return new Error(fallback);
  }
}

// Same Document Storage upload the Pratica page uses (lead-scoped B2 keys, lock checks); the
// chat only uses its own documentKeys so the gateway applies the chat format rules.
export async function uploadChatFile(leadId: string, file: File, mimeType: string, kind: Exclude<AttachmentKind, "practice_document">) {
  const query = new URLSearchParams({
    leadId,
    documentKey: kind === "quote" ? "chat_quote" : "chat_attachment",
    fileName: file.name
  });
  const response = await fetch(apiUrl(`/api/document-storage/upload?${query.toString()}`), {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": mimeType },
    body: file
  });
  if (!response.ok) throw await readError(response, "Caricamento del file non riuscito.");
  const payload = (await response.json()) as { attachment: StoredChatFile };
  return payload.attachment;
}

type CachedUrl = { url: string; expiresAt: number };
const signedUrlCache = new Map<string, CachedUrl>();
// The gateway signs download URLs for 10 minutes; reuse them for a bit less than that.
const SIGNED_URL_REUSE_MS = 8 * 60 * 1000;

export async function getStoredFileUrl(storageKey: string, fileName?: string) {
  const cached = signedUrlCache.get(storageKey);
  if (cached && cached.expiresAt > Date.now()) return cached.url;
  const payload = await api<{ url: string }>("/api/document-storage/presign-download", {
    method: "POST",
    body: JSON.stringify({ storageKey, fileName })
  });
  signedUrlCache.set(storageKey, { url: payload.url, expiresAt: Date.now() + SIGNED_URL_REUSE_MS });
  return payload.url;
}

const inboundMediaCache = new Map<string, Promise<string>>();

// Media a customer sent: bytes come from the authenticated whatsapp-service media proxy, kept as
// an object URL for the session so re-renders and polling don't download them again.
export function getInboundMediaUrl(messageId: string) {
  const cached = inboundMediaCache.get(messageId);
  if (cached) return cached;
  const request = fetch(apiUrl(`/api/whatsapp/messages/${encodeURIComponent(messageId)}/media`), { headers: authHeaders() }).then(
    async (response) => {
      if (!response.ok) throw await readError(response, "Allegato non disponibile.");
      return URL.createObjectURL(await response.blob());
    }
  );
  inboundMediaCache.set(messageId, request);
  // A failed download must not stay cached, otherwise "Riprova" could never succeed.
  request.catch(() => inboundMediaCache.delete(messageId));
  return request;
}
