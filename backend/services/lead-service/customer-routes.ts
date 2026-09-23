import http from "http";
import { getLeadById, listLeads, saveLead } from "../common/leadStore";
import { findCustomerByContact, findOrCreateCustomerByContact, getCustomerById } from "../common/customerStore";
import {
  computeLtvFromPurchases,
  createPurchase,
  getPurchaseById,
  listPurchasesByCustomerId,
  listPurchasesByLeadId,
  savePurchase,
  PurchaseRecord,
  PurchaseStatus
} from "../common/purchaseStore";

function routeMatch(pathname: string, pattern: string) {
  const pathSegments = pathname.split("/").filter(Boolean);
  const patternSegments = pattern.split("/").filter(Boolean);
  if (pathSegments.length !== patternSegments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternSegments.length; i += 1) {
    const current = patternSegments[i];
    const value = pathSegments[i];
    if (current.startsWith(":")) params[current.slice(1)] = decodeURIComponent(value);
    else if (current !== value) return null;
  }
  return params;
}

function parseBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(new Error("Body too large"));
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

const VALID_PURCHASE_STATUSES: PurchaseStatus[] = ["completed", "pending", "cancelled", "refunded"];

function safePurchase(purchase: PurchaseRecord) {
  return {
    id: purchase.id,
    customerId: purchase.customerId,
    leadId: purchase.leadId || null,
    amount: Number(purchase.amount || 0),
    currency: purchase.currency || "EUR",
    status: purchase.status,
    purchasedAt: purchase.purchasedAt,
    product: purchase.product || null,
    cruiseName: purchase.cruiseName || null,
    source: purchase.source || null,
    sourcePlatform: purchase.sourcePlatform || null,
    sourceCampaignId: purchase.sourceCampaignId || null,
    note: purchase.note || null,
    createdAt: purchase.createdAt,
    updatedAt: purchase.updatedAt
  };
}

function leadSummaryForCustomer(lead: any) {
  return {
    id: lead.id,
    fullName: lead.fullName || "",
    phone: lead.phone || "",
    email: lead.email || "",
    status: lead.status || "",
    closingOutcome: lead.closingOutcome || "open",
    lossReason: lead.lossReason || null,
    assignedTo: lead.assignedTo || "",
    source: lead.source || "",
    nextActionAt: lead.nextActionAt || null,
    createdAt: lead.createdAt || null,
    updatedAt: lead.updatedAt || null
  };
}

/**
 * Ensures a lead has a customerId, resolving/creating a Customer from its
 * phone/email if missing. Idempotent: a lead that already has a customerId is
 * returned unchanged. This is the on-demand counterpart to the bulk backfill
 * script for leads touched individually before the backfill has run.
 */
async function ensureCustomerForLead(lead: any) {
  if (lead.customerId) return lead.customerId as string;
  const customer = await findOrCreateCustomerByContact({ phone: lead.phone, email: lead.email, fullName: lead.fullName });
  if (!customer) return null;
  lead.customerId = customer.id;
  lead.updatedAt = new Date().toISOString();
  await saveLead(lead);
  return customer.id;
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

/**
 * Handles /customers/*, /leads/:leadId/purchases and /purchases/:id routes.
 * Returns true if the request was handled (response already sent), false if
 * the caller should keep looking for a matching route.
 */
export async function tryHandleCustomerRoutes(
  method: string,
  pathname: string,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<boolean> {
  const customerParams = routeMatch(pathname, "/customers/:customerId");
  if (customerParams && method === "GET") {
    const customer = await getCustomerById(customerParams.customerId);
    if (!customer) {
      sendJson(res, 404, { error: "Cliente non trovato." });
      return true;
    }
    const [purchases, customerLeads] = await Promise.all([
      listPurchasesByCustomerId(customer.id),
      listLeads({ customerId: customer.id })
    ]);
    const leads = customerLeads.map(leadSummaryForCustomer);
    const activeLead = leads.find((lead) => lead.closingOutcome === "open") || null;
    sendJson(res, 200, {
      customer,
      ltv: computeLtvFromPurchases(purchases),
      purchases: purchases.map(safePurchase),
      leads,
      activeLead
    });
    return true;
  }

  const leadPurchasesParams = routeMatch(pathname, "/leads/:leadId/purchases");
  if (leadPurchasesParams && method === "GET") {
    const lead = await getLeadById(leadPurchasesParams.leadId);
    if (!lead) {
      sendJson(res, 404, { error: "Lead non trovato." });
      return true;
    }
    const purchases = await listPurchasesByLeadId(lead.id);
    sendJson(res, 200, purchases.map(safePurchase));
    return true;
  }

  if (leadPurchasesParams && method === "POST") {
    const body = await parseBody(req);
    const lead = await getLeadById(leadPurchasesParams.leadId);
    if (!lead) {
      sendJson(res, 404, { error: "Lead non trovato." });
      return true;
    }
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      sendJson(res, 400, { error: "amount deve essere un numero maggiore di zero." });
      return true;
    }
    const customerId = await ensureCustomerForLead(lead);
    if (!customerId) {
      sendJson(res, 400, { error: "Impossibile determinare il cliente: lead privo di telefono ed email." });
      return true;
    }
    const status: PurchaseStatus = VALID_PURCHASE_STATUSES.includes(body.status) ? body.status : "completed";
    const purchase = await createPurchase({
      customerId,
      leadId: lead.id,
      amount,
      currency: String(body.currency || "EUR"),
      status,
      purchasedAt: body.purchasedAt ? String(body.purchasedAt) : new Date().toISOString(),
      product: body.product ? String(body.product) : null,
      cruiseName: body.cruiseName || lead.cruiseName || null,
      source: lead.source || null,
      sourcePlatform: lead.sourcePlatform || null,
      sourceCampaignId: lead.sourceCampaignId || null,
      note: body.note ? String(body.note) : null
    });
    sendJson(res, 201, safePurchase(purchase));
    return true;
  }

  const purchaseParams = routeMatch(pathname, "/purchases/:purchaseId");
  if (purchaseParams && method === "PATCH") {
    const body = await parseBody(req);
    const purchase = await getPurchaseById(purchaseParams.purchaseId);
    if (!purchase) {
      sendJson(res, 404, { error: "Acquisto non trovato." });
      return true;
    }
    if (Object.prototype.hasOwnProperty.call(body, "amount")) {
      const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        sendJson(res, 400, { error: "amount deve essere un numero maggiore di zero." });
        return true;
      }
      purchase.amount = amount;
    }
    if (Object.prototype.hasOwnProperty.call(body, "status") && VALID_PURCHASE_STATUSES.includes(body.status)) {
      purchase.status = body.status;
    }
    if (Object.prototype.hasOwnProperty.call(body, "purchasedAt")) purchase.purchasedAt = String(body.purchasedAt);
    if (Object.prototype.hasOwnProperty.call(body, "product")) purchase.product = body.product ? String(body.product) : null;
    if (Object.prototype.hasOwnProperty.call(body, "cruiseName")) purchase.cruiseName = body.cruiseName ? String(body.cruiseName) : null;
    if (Object.prototype.hasOwnProperty.call(body, "note")) purchase.note = body.note ? String(body.note) : null;
    purchase.updatedAt = new Date().toISOString();
    await savePurchase(purchase);
    sendJson(res, 200, safePurchase(purchase));
    return true;
  }

  return false;
}

export type LeadAssociationResolution = {
  customerId: string | null;
  leadId: string | null;
  ambiguous: boolean;
  candidateLeadIds: string[];
};

/**
 * Deterministic WhatsApp-conversation-to-lead resolution for a phone number. A Customer can now
 * have N leads, so "same phone -> always the same lead" no longer holds; this never picks an
 * opportunity arbitrarily:
 *   - no Customer for this phone yet -> caller should fall back to its own create/ingest flow.
 *   - exactly one Lead for the Customer (any state) -> that one.
 *   - more than one Lead, but exactly one with closingOutcome "open" -> that active one.
 *   - anything else (0 active among 2+, or 2+ active) -> ambiguous, no leadId picked.
 * Read-only: never creates a Customer or a Lead.
 */
export async function resolveLeadAssociationForPhone(phone: string): Promise<LeadAssociationResolution> {
  const customer = await findCustomerByContact(phone, "");
  if (!customer) return { customerId: null, leadId: null, ambiguous: false, candidateLeadIds: [] };

  const leads = await listLeads({ customerId: customer.id });
  if (!leads.length) return { customerId: customer.id, leadId: null, ambiguous: false, candidateLeadIds: [] };
  if (leads.length === 1) {
    return { customerId: customer.id, leadId: leads[0].id, ambiguous: false, candidateLeadIds: [leads[0].id] };
  }

  const activeLeads = leads.filter((lead: any) => String(lead.closingOutcome || "open") === "open");
  if (activeLeads.length === 1) {
    return { customerId: customer.id, leadId: activeLeads[0].id, ambiguous: false, candidateLeadIds: [activeLeads[0].id] };
  }

  const candidates = activeLeads.length ? activeLeads : leads;
  return { customerId: customer.id, leadId: null, ambiguous: true, candidateLeadIds: candidates.map((lead: any) => lead.id) };
}

export { ensureCustomerForLead };
