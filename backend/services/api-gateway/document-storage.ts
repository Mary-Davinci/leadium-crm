import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

function normalizeEndpoint(value: string) {
  const trimmed = String(value || "").trim().replace(/\/+$/g, "");
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

const B2_ENDPOINT = normalizeEndpoint(process.env.BACKBLAZE_B2_ENDPOINT || "");
const B2_REGION = String(process.env.BACKBLAZE_B2_REGION || "").trim();
const B2_BUCKET = String(process.env.BACKBLAZE_B2_BUCKET || "").trim();
const B2_KEY_ID = String(process.env.BACKBLAZE_B2_KEY_ID || "").trim();
const B2_APPLICATION_KEY = String(process.env.BACKBLAZE_B2_APPLICATION_KEY || "").trim();
const B2_PREFIX = String(process.env.BACKBLAZE_B2_PREFIX || "lead-documents").trim().replace(/^\/+|\/+$/g, "");
const UPLOAD_URL_TTL_SECONDS = Number(process.env.BACKBLAZE_B2_UPLOAD_URL_TTL_SECONDS || 900);
const DOWNLOAD_URL_TTL_SECONDS = Number(process.env.BACKBLAZE_B2_DOWNLOAD_URL_TTL_SECONDS || 600);

type SignedUploadInput = {
  leadId: string;
  documentKey: string;
  attachmentId: string;
  fileName: string;
  mimeType?: string;
};

type SignedDownloadInput = {
  storageKey: string;
  fileName?: string;
};

type DirectUploadInput = {
  leadId: string;
  documentKey: string;
  fileName: string;
  mimeType?: string;
  size: number;
  body: Buffer;
};

let client: S3Client | null = null;

export function isDocumentStorageEnabled() {
  return Boolean(B2_ENDPOINT && B2_REGION && B2_BUCKET && B2_KEY_ID && B2_APPLICATION_KEY);
}

function assertDocumentStorageEnabled() {
  if (!isDocumentStorageEnabled()) {
    throw new Error("Storage documenti non configurato.");
  }
}

function getClient() {
  assertDocumentStorageEnabled();
  if (!client) {
    client = new S3Client({
      region: B2_REGION,
      endpoint: B2_ENDPOINT,
      forcePathStyle: true,
      credentials: {
        accessKeyId: B2_KEY_ID,
        secretAccessKey: B2_APPLICATION_KEY
      }
    });
  }
  return client;
}

function sanitizeSegment(value: string, fallback: string) {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
  return cleaned || fallback;
}

function normalizeStorageKey(input: string) {
  return String(input || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/");
}

export function buildDocumentStorageKey(input: SignedUploadInput) {
  const leadId = sanitizeSegment(input.leadId, "lead");
  const documentKey = sanitizeSegment(input.documentKey, "document");
  const attachmentId = sanitizeSegment(input.attachmentId, "attachment");
  const fileName = sanitizeSegment(input.fileName, "documento");
  return normalizeStorageKey(`${B2_PREFIX}/${leadId}/${documentKey}/${attachmentId}-${fileName}`);
}

function validateStorageKey(storageKey: string) {
  const normalized = normalizeStorageKey(storageKey);
  if (!normalized) throw new Error("storageKey obbligatorio.");
  if (normalized.includes("..")) throw new Error("storageKey non valido.");
  if (B2_PREFIX && !normalized.startsWith(`${B2_PREFIX}/`) && normalized !== B2_PREFIX) {
    throw new Error("storageKey fuori dal prefix consentito.");
  }
  return normalized;
}

export async function createSignedUpload(input: SignedUploadInput) {
  const storageKey = buildDocumentStorageKey(input);
  const command = new PutObjectCommand({
    Bucket: B2_BUCKET,
    Key: storageKey,
    ContentType: String(input.mimeType || "application/octet-stream")
  });

  const url = await getSignedUrl(getClient(), command, { expiresIn: UPLOAD_URL_TTL_SECONDS });
  return {
    storageKey,
    upload: {
      url,
      method: "PUT" as const,
      headers: {
        "Content-Type": String(input.mimeType || "application/octet-stream")
      }
    }
  };
}

export async function uploadDocumentBuffer(input: DirectUploadInput) {
  const attachmentId = `doc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const storageKey = buildDocumentStorageKey({
    leadId: input.leadId,
    documentKey: input.documentKey,
    attachmentId,
    fileName: input.fileName,
    mimeType: input.mimeType
  });

  const command = new PutObjectCommand({
    Bucket: B2_BUCKET,
    Key: storageKey,
    Body: input.body,
    ContentType: String(input.mimeType || "application/octet-stream")
  });

  await getClient().send(command);

  return {
    id: attachmentId,
    name: String(input.fileName || "documento"),
    mimeType: String(input.mimeType || "application/octet-stream"),
    size: Number(input.size || input.body.length || 0),
    storageKey,
    storageProvider: "backblaze_b2",
    uploadedAt: new Date().toISOString()
  };
}

export async function createSignedDownload(input: SignedDownloadInput) {
  const storageKey = validateStorageKey(input.storageKey);
  const safeFileName = sanitizeSegment(input.fileName || "documento", "documento");
  const command = new GetObjectCommand({
    Bucket: B2_BUCKET,
    Key: storageKey,
    ResponseContentDisposition: `inline; filename="${safeFileName}"`
  });
  const url = await getSignedUrl(getClient(), command, { expiresIn: DOWNLOAD_URL_TTL_SECONDS });
  return { url };
}

export async function deleteStoredObject(storageKey: string) {
  const normalized = validateStorageKey(storageKey);
  const command = new DeleteObjectCommand({
    Bucket: B2_BUCKET,
    Key: normalized
  });
  await getClient().send(command);
}
