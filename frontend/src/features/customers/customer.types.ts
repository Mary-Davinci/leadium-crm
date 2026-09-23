export type Customer = {
  id: string;
  fullName: string;
  phone: string;
  email: string;
  firstSeenAt: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
};

export type PurchaseStatus = "completed" | "pending" | "cancelled" | "refunded";

export type Purchase = {
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

export type CustomerLeadSummary = {
  id: string;
  fullName: string;
  phone: string;
  email: string;
  status: string;
  closingOutcome: "open" | "won" | "lost" | "disqualified";
  lossReason: string | null;
  assignedTo: string;
  source: string;
  nextActionAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type CustomerLtv = {
  ltv: number;
  purchaseCount: number;
  averageOrderValue: number;
  firstPurchaseAt: string | null;
  lastPurchaseAt: string | null;
};

export type CustomerDetail = {
  customer: Customer;
  ltv: CustomerLtv;
  purchases: Purchase[];
  leads: CustomerLeadSummary[];
  activeLead: CustomerLeadSummary | null;
};
