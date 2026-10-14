// Upload rules for files an operator attaches from the WhatsApp chat. They go to the same
// Document Storage (Backblaze B2, same lead-scoped storage keys) as Pratica documents -- only the
// accepted formats differ: the chat also needs spreadsheets (quotes, passenger lists).
// Pratica uploads keep their own, narrower whitelist untouched.

export const CHAT_DOCUMENT_KEYS = new Set(["chat_attachment", "chat_quote"]);

export function isChatDocumentKey(documentKey: string) {
  return CHAT_DOCUMENT_KEYS.has(String(documentKey || "").trim());
}

type FileFamily = "pdf" | "jpeg" | "png" | "webp" | "heic" | "ooxml" | "ole" | "csv";

// Declared MIME -> the file family its bytes must belong to. Windows browsers commonly report a
// .csv as application/vnd.ms-excel, so that MIME accepts either a real legacy .xls or CSV text.
const MIME_FAMILIES: Record<string, FileFamily[]> = {
  "application/pdf": ["pdf"],
  "image/jpeg": ["jpeg"],
  "image/png": ["png"],
  "image/webp": ["webp"],
  "image/heic": ["heic"],
  "image/heif": ["heic"],
  "application/msword": ["ole"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ["ooxml"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ["ooxml"],
  "application/vnd.ms-excel": ["ole", "csv"],
  "text/csv": ["csv"]
};

const EXTENSION_FAMILIES: Record<string, FileFamily[]> = {
  pdf: ["pdf"],
  jpg: ["jpeg"],
  jpeg: ["jpeg"],
  png: ["png"],
  webp: ["webp"],
  heic: ["heic"],
  heif: ["heic"],
  doc: ["ole"],
  docx: ["ooxml"],
  xls: ["ole"],
  xlsx: ["ooxml"],
  csv: ["csv"]
};

export const CHAT_UPLOAD_FORMAT_ERROR =
  "Formato non supportato. Puoi inviare immagini (JPG, PNG, WEBP, HEIC), PDF, Word, Excel o CSV.";

function normalizeMime(mimeType: string) {
  return String(mimeType || "").split(";")[0].trim().toLowerCase();
}

function getExtension(fileName: string) {
  const match = String(fileName || "").toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  return match ? match[1] : "";
}

function startsWith(buffer: Buffer, bytes: number[], offset = 0) {
  if (buffer.length < offset + bytes.length) return false;
  return bytes.every((byte, index) => buffer[offset + index] === byte);
}

function ascii(text: string) {
  return Array.from(text).map((char) => char.charCodeAt(0));
}

function looksLikeCsvText(buffer: Buffer) {
  const sample = buffer.subarray(0, 4096);
  if (sample.includes(0)) return false;
  // A CSV never starts with markup; refusing "<" keeps an HTML/SVG body from being stored as text.
  const firstVisible = sample.toString("utf8").replace(/^﻿/, "").trimStart().charAt(0);
  return firstVisible !== "<";
}

export function detectFileFamily(buffer: Buffer): FileFamily | null {
  if (!buffer || !buffer.length) return null;
  if (startsWith(buffer, ascii("%PDF-"))) return "pdf";
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(buffer, ascii("RIFF")) && startsWith(buffer, ascii("WEBP"), 8)) return "webp";
  if (startsWith(buffer, ascii("ftyp"), 4)) return "heic";
  if (startsWith(buffer, [0x50, 0x4b, 0x03, 0x04])) return "ooxml";
  if (startsWith(buffer, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "ole";
  if (looksLikeCsvText(buffer)) return "csv";
  return null;
}

export function isAllowedChatUploadMime(mimeType: string) {
  return Boolean(MIME_FAMILIES[normalizeMime(mimeType)]);
}

/**
 * Declared MIME, file extension and actual leading bytes must all agree. The declared
 * Content-Type alone is client-controlled, so this is what stops e.g. an HTML file renamed to
 * .pdf, or an SVG sent as image/png, from being stored and later forwarded to a customer.
 */
export function validateChatUpload(input: { fileName: string; mimeType: string; body: Buffer }): { ok: true } | { ok: false; error: string } {
  const mimeFamilies = MIME_FAMILIES[normalizeMime(input.mimeType)];
  const extensionFamilies = EXTENSION_FAMILIES[getExtension(input.fileName)];
  if (!mimeFamilies || !extensionFamilies) return { ok: false, error: CHAT_UPLOAD_FORMAT_ERROR };
  const detected = detectFileFamily(input.body);
  if (!detected || !mimeFamilies.includes(detected) || !extensionFamilies.includes(detected)) {
    return { ok: false, error: "Il contenuto del file non corrisponde al formato dichiarato." };
  }
  return { ok: true };
}
