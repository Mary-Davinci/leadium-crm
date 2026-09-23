import { getMongoDb, isMongoEnabled } from "./mongo";
import { newId, readDb, writeDb } from "./jsonStore";

export type PurchaseStatus = "completed" | "pending" | "cancelled" | "refunded";

export type PurchaseRecord = {
  id: string;
  customerId: string;
  leadId: string | null;
  amount: number;
  currency: string;
  status: PurchaseStatus;
  purchasedAt: string;
  product?: string | null;
  cruiseName?: string | null;
  source?: string | null;
  sourcePlatform?: string | null;
  sourceCampaignId?: string | null;
  note?: string | null;
  createdAt: string;
  updatedAt: string;
};

function toPurchaseDoc(purchase: PurchaseRecord) {
  return { ...purchase, _id: purchase.id };
}

function fromPurchaseDoc(doc: any): PurchaseRecord | null {
  if (!doc) return null;
  const purchase = { ...doc };
  if (!purchase.id) purchase.id = String(purchase._id);
  delete purchase._id;
  return purchase as PurchaseRecord;
}

export async function getPurchaseById(purchaseId: string): Promise<PurchaseRecord | null> {
  if (!purchaseId) return null;
  if (!isMongoEnabled()) {
    const db = readDb();
    return (db.purchases || []).find((item: any) => item.id === purchaseId) || null;
  }
  const db = await getMongoDb();
  const doc = await db.collection("purchases").findOne({ _id: purchaseId });
  return fromPurchaseDoc(doc);
}

export async function listPurchasesByCustomerId(customerId: string): Promise<PurchaseRecord[]> {
  if (!customerId) return [];
  if (!isMongoEnabled()) {
    const db = readDb();
    return (db.purchases || [])
      .filter((item: any) => item.customerId === customerId)
      .sort((a: PurchaseRecord, b: PurchaseRecord) => new Date(b.purchasedAt || 0).getTime() - new Date(a.purchasedAt || 0).getTime());
  }
  const db = await getMongoDb();
  const docs = await db.collection("purchases").find({ customerId }).sort({ purchasedAt: -1 }).toArray();
  return docs.map(fromPurchaseDoc).filter(Boolean) as PurchaseRecord[];
}

export async function listPurchasesByLeadId(leadId: string): Promise<PurchaseRecord[]> {
  if (!leadId) return [];
  if (!isMongoEnabled()) {
    const db = readDb();
    return (db.purchases || [])
      .filter((item: any) => item.leadId === leadId)
      .sort((a: PurchaseRecord, b: PurchaseRecord) => new Date(b.purchasedAt || 0).getTime() - new Date(a.purchasedAt || 0).getTime());
  }
  const db = await getMongoDb();
  const docs = await db.collection("purchases").find({ leadId }).sort({ purchasedAt: -1 }).toArray();
  return docs.map(fromPurchaseDoc).filter(Boolean) as PurchaseRecord[];
}

// Bulk read for report joins (e.g. the Booking activity report's "prodotto" column) -- avoids an
// N+1 listPurchasesByLeadId call per row.
export async function listAllPurchases(): Promise<PurchaseRecord[]> {
  if (!isMongoEnabled()) {
    const db = readDb();
    return (db.purchases || []).slice();
  }
  const db = await getMongoDb();
  const docs = await db.collection("purchases").find({}).toArray();
  return docs.map(fromPurchaseDoc).filter(Boolean) as PurchaseRecord[];
}

export async function createPurchase(input: Omit<PurchaseRecord, "id" | "createdAt" | "updatedAt">): Promise<PurchaseRecord> {
  const now = new Date().toISOString();
  const purchase: PurchaseRecord = {
    id: newId("purchase"),
    createdAt: now,
    updatedAt: now,
    ...input
  };
  if (!isMongoEnabled()) {
    const db = readDb();
    db.purchases = Array.isArray(db.purchases) ? db.purchases : [];
    db.purchases.push(purchase);
    writeDb(db);
    return purchase;
  }
  const db = await getMongoDb();
  await db.collection("purchases").insertOne(toPurchaseDoc(purchase));
  return purchase;
}

export async function savePurchase(purchase: PurchaseRecord): Promise<PurchaseRecord | null> {
  if (!isMongoEnabled()) {
    const db = readDb();
    const rows = Array.isArray(db.purchases) ? db.purchases : [];
    const index = rows.findIndex((item: any) => item.id === purchase.id);
    if (index === -1) return null;
    rows[index] = purchase;
    db.purchases = rows;
    writeDb(db);
    return purchase;
  }
  const db = await getMongoDb();
  await db.collection("purchases").replaceOne({ _id: purchase.id }, toPurchaseDoc(purchase), { upsert: false });
  return purchase;
}

export const LTV_CONTRIBUTING_STATUSES = new Set<PurchaseStatus>(["completed"]);

export function computeLtvFromPurchases(purchases: PurchaseRecord[]) {
  const valid = purchases.filter((purchase) => LTV_CONTRIBUTING_STATUSES.has(purchase.status));
  const ltv = valid.reduce((sum, purchase) => sum + Number(purchase.amount || 0), 0);
  const purchaseCount = valid.length;
  const averageOrderValue = purchaseCount ? ltv / purchaseCount : 0;
  const sortedDates = valid
    .map((purchase) => purchase.purchasedAt)
    .filter(Boolean)
    .sort();
  return {
    ltv,
    purchaseCount,
    averageOrderValue,
    firstPurchaseAt: sortedDates[0] || null,
    lastPurchaseAt: sortedDates[sortedDates.length - 1] || null
  };
}
