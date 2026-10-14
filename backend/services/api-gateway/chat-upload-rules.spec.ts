import assert from "node:assert/strict";
import { detectFileFamily, isAllowedChatUploadMime, isChatDocumentKey, validateChatUpload } from "./chat-upload-rules";

const PDF = Buffer.from("%PDF-1.7\n1 0 obj");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 20, 0]);
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]);
const CSV = Buffer.from("﻿nome;cognome;cabina\nMario;Rossi;1234\n", "utf8");
const HTML = Buffer.from("<!doctype html><script>alert(1)</script>");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function run(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

run("solo le documentKey della chat usano le regole chat", () => {
  assert.equal(isChatDocumentKey("chat_attachment"), true);
  assert.equal(isChatDocumentKey("chat_quote"), true);
  assert.equal(isChatDocumentKey("identity_document"), false);
});

run("la chat accetta anche Excel e CSV, mai HTML/SVG/eseguibili", () => {
  assert.equal(isAllowedChatUploadMime(XLSX), true);
  assert.equal(isAllowedChatUploadMime("application/vnd.ms-excel"), true);
  assert.equal(isAllowedChatUploadMime("text/csv"), true);
  assert.equal(isAllowedChatUploadMime("text/html"), false);
  assert.equal(isAllowedChatUploadMime("image/svg+xml"), false);
  assert.equal(isAllowedChatUploadMime("application/x-msdownload"), false);
});

run("riconosce la firma dei formati ammessi", () => {
  assert.equal(detectFileFamily(PDF), "pdf");
  assert.equal(detectFileFamily(PNG), "png");
  assert.equal(detectFileFamily(JPEG), "jpeg");
  assert.equal(detectFileFamily(ZIP), "ooxml");
  assert.equal(detectFileFamily(OLE), "ole");
  assert.equal(detectFileFamily(CSV), "csv");
  assert.equal(detectFileFamily(HTML), null);
  assert.equal(detectFileFamily(SVG), null);
});

run("accetta file coerenti tra MIME, estensione e contenuto", () => {
  assert.deepEqual(validateChatUpload({ fileName: "preventivo.pdf", mimeType: "application/pdf", body: PDF }), { ok: true });
  assert.deepEqual(validateChatUpload({ fileName: "offerta.xlsx", mimeType: XLSX, body: ZIP }), { ok: true });
  assert.deepEqual(validateChatUpload({ fileName: "vecchio.xls", mimeType: "application/vnd.ms-excel", body: OLE }), { ok: true });
  // Windows reports .csv as application/vnd.ms-excel.
  assert.deepEqual(validateChatUpload({ fileName: "passeggeri.csv", mimeType: "application/vnd.ms-excel", body: CSV }), { ok: true });
  assert.deepEqual(validateChatUpload({ fileName: "foto.JPG", mimeType: "image/jpeg", body: JPEG }), { ok: true });
});

run("rifiuta MIME falsificati, estensioni incoerenti e markup", () => {
  assert.equal(validateChatUpload({ fileName: "fattura.pdf", mimeType: "application/pdf", body: HTML }).ok, false);
  assert.equal(validateChatUpload({ fileName: "logo.png", mimeType: "image/png", body: SVG }).ok, false);
  assert.equal(validateChatUpload({ fileName: "foto.png", mimeType: "image/png", body: PDF }).ok, false);
  assert.equal(validateChatUpload({ fileName: "pagina.html", mimeType: "text/csv", body: CSV }).ok, false);
  assert.equal(validateChatUpload({ fileName: "dati.csv", mimeType: "text/csv", body: HTML }).ok, false);
  assert.equal(validateChatUpload({ fileName: "offerta.xlsx", mimeType: XLSX, body: PDF }).ok, false);
  assert.equal(validateChatUpload({ fileName: "senza-estensione", mimeType: "application/pdf", body: PDF }).ok, false);
});

console.log("All chat-upload-rules checks passed.");
