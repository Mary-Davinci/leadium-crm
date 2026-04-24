import { getMongoDb, isMongoEnabled } from "./mongo";
import { newId, readDb, writeDb } from "./jsonStore";

export function normalizePhone(phone: string) {
  return String(phone || "").replace(/\D+/g, "");
}

export function normalizeEmail(email: string) {
  return String(email || "").trim().toLowerCase();
}

function escapeRegex(value: string) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toLeadDoc(lead: any) {
  return {
    ...lead,
    _id: lead.id,
    phoneNormalized: normalizePhone(lead.phone),
    emailNormalized: normalizeEmail(lead.email)
  };
}

function fromLeadDoc(doc: any) {
  if (!doc) return null;
  const lead = { ...doc };
  if (!lead.id) lead.id = String(lead._id);
  delete lead._id;
  delete lead.phoneNormalized;
  delete lead.emailNormalized;
  return lead;
}

export async function listLeads(query: Record<string, string> = {}) {
  if (!isMongoEnabled()) {
    let rows = readDb().leads;
    if (query.status) rows = rows.filter((item: any) => item.status === query.status);
    if (query.assignedTo) rows = rows.filter((item: any) => (item.assignedTo || "") === query.assignedTo);
    if (query.search) {
      const q = String(query.search).toLowerCase();
      rows = rows.filter(
        (item: any) =>
          (item.fullName || "").toLowerCase().includes(q) ||
          (item.phone || "").toLowerCase().includes(q) ||
          (item.email || "").toLowerCase().includes(q)
      );
    }
    return rows.sort((a: any, b: any) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }
  const db = await getMongoDb();
  const filter: any = {};
  if (query.status) filter.status = query.status;
  if (query.assignedTo) filter.assignedTo = query.assignedTo;
  if (query.search) {
    const regex = new RegExp(escapeRegex(query.search), "i");
    filter.$or = [{ fullName: regex }, { phone: regex }, { email: regex }];
  }
  const docs = await db.collection("leads").find(filter).sort({ updatedAt: -1 }).toArray();
  return docs.map(fromLeadDoc);
}

export async function getLeadById(leadId: string) {
  if (!isMongoEnabled()) return readDb().leads.find((item: any) => item.id === leadId) || null;
  const db = await getMongoDb();
  const doc = await db.collection("leads").findOne({ _id: leadId });
  return fromLeadDoc(doc);
}

export async function getTimelineByLeadId(leadId: string) {
  if (!isMongoEnabled()) return readDb().activities.filter((item: any) => item.leadId === leadId);
  const db = await getMongoDb();
  return db.collection("activities").find({ leadId }).sort({ createdAt: 1 }).toArray();
}

export async function createLead(lead: any, activities: any[] = []) {
  if (!isMongoEnabled()) {
    const db = readDb();
    db.leads.push(lead);
    db.activities.push(...activities);
    writeDb(db);
    return lead;
  }
  const database = await getMongoDb();
  await database.collection("leads").insertOne(toLeadDoc(lead));
  if (activities.length) await database.collection("activities").insertMany(activities);
  return lead;
}

export async function appendActivities(activities: any[] = []) {
  if (!activities.length) return;
  if (!isMongoEnabled()) {
    const db = readDb();
    db.activities.push(...activities);
    writeDb(db);
    return;
  }
  const database = await getMongoDb();
  await database.collection("activities").insertMany(activities);
}

export async function saveLead(lead: any) {
  if (!isMongoEnabled()) {
    const db = readDb();
    const index = db.leads.findIndex((item: any) => item.id === lead.id);
    if (index === -1) return null;
    db.leads[index] = lead;
    writeDb(db);
    return lead;
  }
  const database = await getMongoDb();
  await database.collection("leads").replaceOne({ _id: lead.id }, toLeadDoc(lead), { upsert: false });
  return lead;
}

export async function findLeadByContact(phone: string, email: string) {
  if (!isMongoEnabled()) {
    const db = readDb();
    const nPhone = normalizePhone(phone);
    const nEmail = normalizeEmail(email);
    return (
      db.leads.find((lead: any) => {
        const samePhone = nPhone && normalizePhone(lead.phone) === nPhone;
        const sameEmail = nEmail && normalizeEmail(lead.email) === nEmail;
        return samePhone || sameEmail;
      }) || null
    );
  }
  const db = await getMongoDb();
  const nPhone = normalizePhone(phone);
  const nEmail = normalizeEmail(email);
  const or: any[] = [];
  if (nPhone) or.push({ phoneNormalized: nPhone });
  if (nEmail) or.push({ emailNormalized: nEmail });
  if (!or.length) return null;
  const doc = await db.collection("leads").findOne({ $or: or });
  return fromLeadDoc(doc);
}

export async function findLeadByExternalOrPhone(externalId: string | null, incomingNumber: string) {
  if (!isMongoEnabled()) {
    const db = readDb();
    return (
      db.leads.find((item: any) => item.id === externalId) ||
      db.leads.find((item: any) => item.phone && item.phone.includes(incomingNumber || "")) ||
      null
    );
  }
  const db = await getMongoDb();
  if (externalId) {
    const byId = await db.collection("leads").findOne({ _id: externalId });
    if (byId) return fromLeadDoc(byId);
  }
  const nPhone = normalizePhone(incomingNumber);
  if (!nPhone) return null;
  const regex = new RegExp(`${escapeRegex(nPhone)}$`);
  const doc = await db.collection("leads").findOne({ phoneNormalized: regex });
  return fromLeadDoc(doc);
}

export { newId };
