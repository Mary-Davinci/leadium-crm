// Contatti datati: who has had no contact for months and can be cleared out by an admin.
// Pure, so every rule can be checked without the page.

export type DatedLead = {
  status?: string; source?: string; notes?: string; closingOutcome?: string;
  createdAt?: string; lastContactAt?: string | null; nextActionAt?: string | null; callAttempts?: number;
};
export type DatedKind = "no-answer" | "never-contacted" | "worked";
export type SourceLabel = { channel: string; detail: string; file: string };

const MONTH_MS = 30 * 24 * 3600 * 1000;
export const DATED_MONTHS = [6, 12, 24] as const;
// A sale is never a candidate, whatever its stage.
const SALE_STATUSES = new Set(["vendita a rate", "primo acconto", "secondo acconto", "saldo", "vendita unica", "invio gadget", "invio biglietti", "pronta per chiusura", "chiusa 100%", "venduta"]);

const time = (value?: string | null) => { const at = Date.parse(String(value || "")); return Number.isFinite(at) ? at : 0; };
const normalized = (value?: string) => String(value || "").trim().toLowerCase();

/** The date the Excel file itself gave: the import keeps it only in the notes. */
export function originalLeadDate(lead: DatedLead) {
  const match = /Lead creata il:\s*([^\n]+)/.exec(lead.notes || "");
  return match ? time(match[1].trim()) : 0;
}

/** Last real contact; otherwise the lead's own age, not the day a file happened to be uploaded. */
export function lastActivityAt(lead: DatedLead) {
  const contact = time(lead.lastContactAt);
  if (contact) return contact;
  const loaded = time(lead.createdAt), original = originalLeadDate(lead);
  return original && (!loaded || original < loaded) ? original : loaded;
}

export function isDatedLead(lead: DatedLead, now: number, months: number) {
  const last = lastActivityAt(lead);
  if (!last || now - last <= months * MONTH_MS) return false;
  if (lead.closingOutcome === "won" || SALE_STATUSES.has(normalized(lead.status))) return false;
  // A callback still to come is work in progress, not a forgotten contact.
  return time(lead.nextActionAt) <= now;
}

export function datedKind(lead: DatedLead): DatedKind {
  if (!lead.lastContactAt && !lead.callAttempts) return "never-contacted";
  return normalized(lead.status) === "non risponde" && Number(lead.callAttempts || 0) >= 2 ? "no-answer" : "worked";
}

export function monthsAgoLabel(at: number, now: number) {
  const months = Math.floor((now - at) / MONTH_MS);
  return months < 1 ? "Meno di un mese fa" : months === 1 ? "1 mese fa" : `${months} mesi fa`;
}

const CHANNELS: Array<[RegExp, string]> = [
  [/^3cx/, "Chiamata in arrivo"], [/whatsapp/, "WhatsApp"], [/^(meta|facebook|instagram|fb)/, "Meta"],
  [/^(sito|site|web|form)/, "Sito"], [/^manual/, "Manuale"]
];

/** The file's name is what the import stores in `source`: excel_<name> or excel_import_<yyyymmdd>. */
export function describeSource(source?: string): SourceLabel {
  const value = normalized(source);
  if (value.startsWith("excel_")) {
    const dated = /^excel_import_(\d{4})(\d{2})(\d{2})$/.exec(value);
    const file = dated ? `Importazione del ${dated[3]}/${dated[2]}/${dated[1]}` : value.slice("excel_".length).replace(/_/g, " ");
    return { channel: "Excel", detail: file, file: value };
  }
  const known = CHANNELS.find(([pattern]) => pattern.test(value));
  if (known) return { channel: known[1], detail: "", file: "" };
  return { channel: value ? value.replace(/_/g, " ") : "Import", detail: "", file: "" };
}

export type LoadedFile = { source: string; label: string; count: number; loadedAt: number };

/** One entry per uploaded file, oldest first: the order in which an admin clears them out. */
export function loadedFiles(leads: Array<DatedLead>) {
  const files = new Map<string, LoadedFile>();
  for (const lead of leads) {
    const { file, detail } = describeSource(lead.source);
    if (!file) continue;
    const row = files.get(file) || { source: file, label: detail, count: 0, loadedAt: 0 };
    const loaded = time(lead.createdAt);
    row.count += 1;
    if (loaded && (!row.loadedAt || loaded < row.loadedAt)) row.loadedAt = loaded;
    files.set(file, row);
  }
  return [...files.values()].sort((a, b) => a.loadedAt - b.loadedAt || a.label.localeCompare(b.label, "it"));
}
