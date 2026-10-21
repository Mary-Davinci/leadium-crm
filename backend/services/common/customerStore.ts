import { getMongoDb, isMongoEnabled } from "./mongo";
import { newId, readDb, writeDb } from "./jsonStore";
import { contactCompareAndSet, normalizeEmail, normalizePhone } from "./leadStore";
import { phoneMatchKeys } from "./phoneIdentity";

export type CustomerRecord = {
  id: string;
  fullName: string;
  phone: string;
  email: string;
  firstSeenAt: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
};

function toCustomerDoc(customer: CustomerRecord) {
  return {
    ...customer,
    _id: customer.id,
    phoneNormalized: normalizePhone(customer.phone),
    emailNormalized: normalizeEmail(customer.email)
  };
}

function fromCustomerDoc(doc: any): CustomerRecord | null {
  if (!doc) return null;
  const customer = { ...doc };
  if (!customer.id) customer.id = String(customer._id);
  delete customer._id;
  delete customer.phoneNormalized;
  delete customer.emailNormalized;
  return customer as CustomerRecord;
}

export async function getCustomerById(customerId: string): Promise<CustomerRecord | null> {
  if (!customerId) return null;
  if (!isMongoEnabled()) {
    const db = readDb();
    return (db.customers || []).find((item: any) => item.id === customerId) || null;
  }
  const db = await getMongoDb();
  const doc = await db.collection("customers").findOne({ _id: customerId });
  return fromCustomerDoc(doc);
}

export async function findCustomerByContact(phone: string, email: string): Promise<CustomerRecord | null> {
  const nPhone = normalizePhone(phone || "");
  const nEmail = normalizeEmail(email || "");
  if (!nPhone && !nEmail) return null;
  if (!isMongoEnabled()) {
    const db = readDb();
    return (
      (db.customers || []).find((customer: any) => {
        const samePhone = nPhone && normalizePhone(customer.phone) === nPhone;
        const sameEmail = nEmail && normalizeEmail(customer.email) === nEmail;
        return samePhone || sameEmail;
      }) || null
    );
  }
  const db = await getMongoDb();
  const or: any[] = [];
  if (nPhone) or.push({ phoneNormalized: nPhone });
  if (nEmail) or.push({ emailNormalized: nEmail });
  if (!or.length) return null;
  const doc = await db.collection("customers").findOne({ $or: or });
  return fromCustomerDoc(doc);
}

/** Compare-and-set of contact fields only; false when a stored value is no longer `expected`. */
export async function setCustomerContactIfUnchanged(customerId: string, expected: Partial<Record<"fullName" | "phone" | "email", string>>, next: Partial<Record<"fullName" | "phone" | "email", string>>, at: string) {
  if (!isMongoEnabled()) {
    const db = readDb();
    const customer = (db.customers || []).find((item: any) => item.id === customerId);
    if (!customer || Object.entries(expected).some(([key, value]) => String(customer[key] || "") !== value)) return false;
    Object.assign(customer, next, { updatedAt: at });
    writeDb(db);
    return true;
  }
  const db = await getMongoDb();
  const { filter, set } = contactCompareAndSet(expected, next, at);
  const result = await db.collection("customers").updateOne({ _id: customerId, ...filter }, { $set: set });
  return result.matchedCount === 1;
}

/** Every customer with this email (case-insensitive). Used for conflict detection only. */
export async function listCustomersByEmail(email: string, limit = 20): Promise<CustomerRecord[]> {
  const key = normalizeEmail(email);
  if (!key) return [];
  if (!isMongoEnabled()) {
    return (readDb().customers || []).filter((customer: any) => normalizeEmail(customer.email) === key).slice(0, limit);
  }
  const db = await getMongoDb();
  const docs = await db.collection("customers").find({ emailNormalized: key }).limit(limit).toArray();
  return docs.map(fromCustomerDoc).filter(Boolean) as CustomerRecord[];
}

/** Every customer whose phone matches (country-aware keys). Used for conflict detection only. */
export async function listCustomersByPhone(phone: string, limit = 20): Promise<CustomerRecord[]> {
  const keys = phoneMatchKeys(phone);
  if (!keys.length) return [];
  if (!isMongoEnabled()) {
    return (readDb().customers || []).filter((customer: any) => keys.includes(normalizePhone(customer.phone))).slice(0, limit);
  }
  const db = await getMongoDb();
  const docs = await db.collection("customers").find({ phoneNormalized: { $in: keys } }).limit(limit).toArray();
  return docs.map(fromCustomerDoc).filter(Boolean) as CustomerRecord[];
}

async function persistNewCustomer(customer: CustomerRecord) {
  if (!isMongoEnabled()) {
    const db = readDb();
    db.customers = Array.isArray(db.customers) ? db.customers : [];
    db.customers.push(customer);
    writeDb(db);
    return customer;
  }
  const db = await getMongoDb();
  await db.collection("customers").insertOne(toCustomerDoc(customer));
  return customer;
}

export async function saveCustomer(customer: CustomerRecord) {
  if (!isMongoEnabled()) {
    const db = readDb();
    const rows = Array.isArray(db.customers) ? db.customers : [];
    const index = rows.findIndex((item: any) => item.id === customer.id);
    if (index === -1) return null;
    rows[index] = customer;
    db.customers = rows;
    writeDb(db);
    return customer;
  }
  const db = await getMongoDb();
  await db.collection("customers").replaceOne({ _id: customer.id }, toCustomerDoc(customer), { upsert: false });
  return customer;
}

/**
 * Idempotent identity resolution: same phone/email always resolves to the same
 * Customer row, whether it already exists or needs to be created. Safe to call
 * repeatedly (e.g. from a backfill) without creating duplicates.
 */
export async function findOrCreateCustomerByContact(input: {
  phone?: string | null;
  email?: string | null;
  fullName?: string | null;
}): Promise<CustomerRecord | null> {
  const phone = String(input.phone || "").trim();
  const email = String(input.email || "").trim();
  if (!phone && !email) return null;
  const now = new Date().toISOString();
  const existing = await findCustomerByContact(phone, email);
  if (existing) {
    if (input.fullName && !existing.fullName) existing.fullName = String(input.fullName).trim();
    if (phone && !existing.phone) existing.phone = phone;
    if (email && !existing.email) existing.email = email;
    existing.lastSeenAt = now;
    existing.updatedAt = now;
    await saveCustomer(existing);
    return existing;
  }
  const customer: CustomerRecord = {
    id: newId("customer"),
    fullName: String(input.fullName || "").trim(),
    phone,
    email,
    firstSeenAt: now,
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now
  };
  return persistNewCustomer(customer);
}

export async function listCustomersByIds(ids: string[]): Promise<CustomerRecord[]> {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (!unique.length) return [];
  if (!isMongoEnabled()) {
    const db = readDb();
    const set = new Set(unique);
    return (db.customers || []).filter((item: any) => set.has(item.id));
  }
  const db = await getMongoDb();
  const docs = await db
    .collection("customers")
    .find({ _id: { $in: unique } })
    .toArray();
  return docs.map(fromCustomerDoc).filter(Boolean) as CustomerRecord[];
}

export { newId };
