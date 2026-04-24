import { MongoClient } from "mongodb";

let client: MongoClient | null = null;
let db: any = null;
let indexesReady = false;

export function isMongoEnabled() {
  if (process.env.NODE_ENV === "test") return false;
  return Boolean(process.env.MONGODB_URI);
}

function getDbName() {
  return process.env.MONGODB_DB_NAME || "crocieriamo";
}

async function ensureIndexes(database: any) {
  if (indexesReady) return;
  const leads = database.collection("leads");
  const activities = database.collection("activities");
  const callLogs = database.collection("callLogs");
  await Promise.all([
    leads.createIndex({ phoneNormalized: 1 }),
    leads.createIndex({ emailNormalized: 1 }),
    leads.createIndex({ status: 1 }),
    leads.createIndex({ updatedAt: -1 }),
    activities.createIndex({ leadId: 1, createdAt: -1 }),
    callLogs.createIndex({ leadId: 1, startedAt: -1 })
  ]);
  indexesReady = true;
}

export async function getMongoDb() {
  if (!isMongoEnabled()) return null;
  if (db) return db;
  client = new MongoClient(process.env.MONGODB_URI as string, {
    maxPoolSize: 20,
    serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 5000)
  });
  await client.connect();
  db = client.db(getDbName());
  await ensureIndexes(db);
  return db;
}
