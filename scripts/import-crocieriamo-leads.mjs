import fs from "fs";
import path from "path";
import { createRequire } from "module";
import XLSX from "xlsx";

const require = createRequire(import.meta.url);
const { MongoClient } = require("../backend/node_modules/mongodb");

const DEFAULT_FULL_FILE = String.raw`C:\Users\DDO\Desktop\[MSC] LEADGEN OFFERTA SARDEGNA 26_Leads_2026-05-25_2026-05-26.xls`;
const DEFAULT_DB_FILE = String.raw`C:\Users\DDO\Desktop\lead crocieriamo che ci servono.xlsx`;
const DEFAULT_SOURCE = "excel_msc_sardegna_2026";
const DEFAULT_STATUS = "Da contattare";

function loadEnvFromFile() {
  const envCandidates = [
    path.join(process.cwd(), "backend", ".env"),
    path.join(process.cwd(), ".env"),
    path.join(path.dirname(new URL(import.meta.url).pathname), "..", "backend", ".env")
  ];
  const envPath = envCandidates.find((candidate) => fs.existsSync(candidate));
  if (!envPath) return;
  const content = fs.readFileSync(envPath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) continue;
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function parseArgs(argv) {
  const options = {
    fullFile: DEFAULT_FULL_FILE,
    dbFile: DEFAULT_DB_FILE,
    source: DEFAULT_SOURCE,
    status: DEFAULT_STATUS,
    apply: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) continue;
    if (key === "full-file") options.fullFile = next;
    if (key === "db-file") options.dbFile = next;
    if (key === "source") options.source = next;
    if (key === "status") options.status = next;
    i += 1;
  }

  return options;
}

function normalizePhone(phone) {
  return String(phone || "").replace(/\D+/g, "");
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function readRows(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: true });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) return [];
  const sheet = workbook.Sheets[firstSheetName];
  return XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
}

function buildContactKey(phone, email) {
  const normalizedPhone = normalizePhone(phone);
  if (normalizedPhone) return `phone::${normalizedPhone}`;
  const normalizedEmail = normalizeEmail(email);
  if (normalizedEmail) return `email::${normalizedEmail}`;
  return "";
}

function cleanName(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function cleanPhone(value) {
  return String(value || "").trim();
}

function cleanEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function buildMetadataMap(fullRows) {
  const metadataMap = new Map();
  for (const row of fullRows) {
    const contactKey = buildContactKey(row.phone_number, row["lascia qui la tua email per ricevere il preventivo"]);
    if (!contactKey) continue;
    metadataMap.set(contactKey, row);
  }
  return metadataMap;
}

function buildLeadCandidate(row, metadataRow, source, status) {
  const fullName = cleanName(row["lascia qui il tuo nome e cognome per ricevere il preventivo"]);
  const phone = cleanPhone(row.phone_number);
  const email = cleanEmail(row["lascia qui la tua email per ricevere il preventivo"]);
  if (!fullName || (!phone && !email)) return null;

  const notesParts = [
    `Import Excel: ${source}`
  ];
  if (metadataRow?.campaign_name) notesParts.push(`Campagna: ${metadataRow.campaign_name}`);
  if (metadataRow?.ad_name) notesParts.push(`Annuncio: ${metadataRow.ad_name}`);
  if (metadataRow?.platform) notesParts.push(`Piattaforma: ${metadataRow.platform}`);
  if (metadataRow?.created_time) notesParts.push(`Lead creata il: ${metadataRow.created_time}`);
  if (metadataRow?.id) notesParts.push(`Lead esterna ID: ${metadataRow.id}`);
  if (metadataRow?.form_name) notesParts.push(`Form: ${metadataRow.form_name}`);

  return {
    fullName,
    phone,
    email,
    source,
    assignedTo: "",
    status,
    notes: notesParts.join("\n")
  };
}

async function findExistingLead(collection, candidate) {
  const phoneNormalized = normalizePhone(candidate.phone);
  const emailNormalized = normalizeEmail(candidate.email);
  const or = [];
  if (phoneNormalized) or.push({ phoneNormalized });
  if (emailNormalized) or.push({ emailNormalized });
  if (!or.length) return null;
  return collection.findOne({ $or: or }, { projection: { _id: 1, fullName: 1, phone: 1, email: 1, source: 1, status: 1 } });
}

function buildId(prefix = "lead") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function toLeadDoc(lead) {
  return {
    ...lead,
    _id: lead.id,
    phoneNormalized: normalizePhone(lead.phone),
    emailNormalized: normalizeEmail(lead.email)
  };
}

function buildActivity(leadId, type, text, meta = null) {
  return {
    id: buildId("act"),
    leadId,
    type,
    text,
    actor: "excel_import",
    meta,
    createdAt: new Date().toISOString()
  };
}

async function main() {
  loadEnvFromFile();
  const options = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(options.fullFile)) {
    throw new Error(`File completo non trovato: ${options.fullFile}`);
  }
  if (!fs.existsSync(options.dbFile)) {
    throw new Error(`File DB non trovato: ${options.dbFile}`);
  }
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI mancante. Controlla backend/.env.");
  }

  const fullRows = readRows(options.fullFile);
  const dbRows = readRows(options.dbFile);
  const metadataMap = buildMetadataMap(fullRows);
  const dedupedCandidates = new Map();
  const skippedInvalid = [];

  for (const row of dbRows) {
    const contactKey = buildContactKey(
      row.phone_number,
      row["lascia qui la tua email per ricevere il preventivo"]
    );
    if (!contactKey) {
      skippedInvalid.push({ reason: "missing_contact", row });
      continue;
    }
    if (dedupedCandidates.has(contactKey)) continue;
    const candidate = buildLeadCandidate(row, metadataMap.get(contactKey), options.source, options.status);
    if (!candidate) {
      skippedInvalid.push({ reason: "missing_name_or_contact", row });
      continue;
    }
    dedupedCandidates.set(contactKey, candidate);
  }

  const client = new MongoClient(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 5000)
  });
  await client.connect();
  const db = client.db(process.env.MONGODB_DB_NAME || "crocieriamo");
  const leadsCollection = db.collection("leads");
  const activitiesCollection = db.collection("activities");

  const candidates = Array.from(dedupedCandidates.values());
  const existing = [];
  const toInsert = [];

  for (const candidate of candidates) {
    const existingLead = await findExistingLead(leadsCollection, candidate);
    if (existingLead) {
      existing.push({
        candidate,
        existingLead: {
          id: String(existingLead._id || ""),
          fullName: String(existingLead.fullName || ""),
          phone: String(existingLead.phone || ""),
          email: String(existingLead.email || ""),
          source: String(existingLead.source || ""),
          status: String(existingLead.status || "")
        }
      });
      continue;
    }
    toInsert.push(candidate);
  }

  const summary = {
    mode: options.apply ? "apply" : "dry-run",
    source: options.source,
    status: options.status,
    files: {
      full: path.basename(options.fullFile),
      db: path.basename(options.dbFile)
    },
    totals: {
      fullRows: fullRows.length,
      dbRows: dbRows.length,
      uniqueCandidates: candidates.length,
      invalidRows: skippedInvalid.length,
      alreadyExisting: existing.length,
      readyToInsert: toInsert.length
    },
    existingPreview: existing.slice(0, 5).map((item) => ({
      incoming: {
        fullName: item.candidate.fullName,
        phone: item.candidate.phone,
        email: item.candidate.email
      },
      existing: item.existingLead
    })),
    insertPreview: toInsert.slice(0, 5)
  };

  if (!options.apply) {
    console.log(JSON.stringify(summary, null, 2));
    await client.close();
    return;
  }

  const now = new Date().toISOString();
  const leadDocs = [];
  const activities = [];
  for (const candidate of toInsert) {
    const lead = {
      id: buildId("lead"),
      fullName: candidate.fullName,
      phone: candidate.phone,
      email: candidate.email,
      source: candidate.source,
      budget: "",
      assignedTo: candidate.assignedTo,
      status: candidate.status,
      notes: candidate.notes,
      documents: { items: [] },
      payments: { items: [] },
      callAttempts: 0,
      nextActionAt: null,
      createdAt: now,
      updatedAt: now
    };
    leadDocs.push(toLeadDoc(lead));
    activities.push(
      buildActivity(lead.id, "lead_created", "Lead creata da import Excel.", {
        source: candidate.source,
        importedFrom: path.basename(options.dbFile)
      }),
      buildActivity(lead.id, "lead_imported", "Lead importata da file Excel.", {
        source: candidate.source,
        importedFrom: path.basename(options.dbFile)
      })
    );
  }

  if (leadDocs.length) {
    await leadsCollection.insertMany(leadDocs, { ordered: false });
    await activitiesCollection.insertMany(activities, { ordered: false });
  }

  console.log(
    JSON.stringify(
      {
        ...summary,
        inserted: leadDocs.length
      },
      null,
      2
    )
  );

  await client.close();
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
