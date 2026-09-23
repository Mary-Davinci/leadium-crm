// Cells starting with these characters can be interpreted as formulas by
// Excel/Sheets/LibreOffice when the CSV is opened (CSV/formula injection,
// e.g. a lead full name synced from an ad platform crafted as
// `=cmd|'/c calc'!A1`). Prefixing with a literal apostrophe forces the cell
// to be read as text -- the standard OWASP-recommended mitigation.
const FORMULA_TRIGGER_CHARS = new Set(["=", "+", "-", "@", "*"]);

export function csvEscape(value: unknown): string {
  let str = value === null || value === undefined ? "" : String(value);
  if (str.length && FORMULA_TRIGGER_CHARS.has(str[0])) {
    str = `'${str}`;
  }
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

/**
 * UTF-8 BOM + CRLF line endings so Excel on Windows opens the file with
 * correct accented-character rendering instead of prompting for an encoding.
 */
export function rowsToCsv(headers: string[], rows: Array<Array<string | number | null | undefined>>): string {
  const lines = [headers.map(csvEscape).join(","), ...rows.map((row) => row.map(csvEscape).join(","))];
  return `﻿${lines.join("\r\n")}`;
}
