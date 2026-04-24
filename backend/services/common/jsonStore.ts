import fs from "fs";
import path from "path";

const DB_FILE_PATH = process.env.JSON_DB_FILE
  ? path.resolve(process.env.JSON_DB_FILE)
  : path.join(__dirname, "..", "..", "data", "db.json");
const EMPTY_DB = { leads: [], activities: [], tasks: [], callLogs: [] };

function ensureDbFile() {
  const dir = path.dirname(DB_FILE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DB_FILE_PATH)) fs.writeFileSync(DB_FILE_PATH, JSON.stringify(EMPTY_DB, null, 2), "utf8");
}

export function readDb() {
  ensureDbFile();
  const raw = fs.readFileSync(DB_FILE_PATH, "utf8");
  try {
    const parsed = JSON.parse(raw);
    return {
      leads: Array.isArray(parsed.leads) ? parsed.leads : [],
      activities: Array.isArray(parsed.activities) ? parsed.activities : [],
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      callLogs: Array.isArray(parsed.callLogs) ? parsed.callLogs : []
    };
  } catch {
    return { ...EMPTY_DB };
  }
}

export function writeDb(db: any) {
  ensureDbFile();
  fs.writeFileSync(DB_FILE_PATH, JSON.stringify(db, null, 2), "utf8");
}

export function newId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}
