import "../../loadEnv";
import { isMongoEnabled } from "../common/mongo";
import { findOrCreateCustomerByContact } from "../common/customerStore";
import { listLeads, saveLead } from "../common/leadStore";

/**
 * Idempotent backfill: gives every existing Lead a customerId, resolving or
 * creating a Customer from its phone/email. Safe to re-run — leads that
 * already have a customerId are left untouched, and repeated runs resolve to
 * the same Customer for the same contact (findOrCreateCustomerByContact is
 * itself idempotent).
 *
 * Refuses to run against a remote MongoDB unless explicitly forced, per the
 * project's rule against writing to real/remote data from an automated pass.
 */
async function main() {
  if (isMongoEnabled() && process.env.ALLOW_REMOTE_BACKFILL !== "true") {
    console.error(
      "MONGODB_URI e impostato (destinazione remota). Backfill annullato per sicurezza.\n" +
        "Per eseguirlo comunque, imposta ALLOW_REMOTE_BACKFILL=true dopo aver verificato che sia sicuro."
    );
    process.exitCode = 1;
    return;
  }

  const leads = await listLeads();
  let linked = 0;
  let skipped = 0;

  for (const lead of leads) {
    if (lead.customerId) {
      skipped += 1;
      continue;
    }
    const customer = await findOrCreateCustomerByContact({ phone: lead.phone, email: lead.email, fullName: lead.fullName });
    if (!customer) {
      skipped += 1;
      continue;
    }
    lead.customerId = customer.id;
    lead.updatedAt = new Date().toISOString();
    await saveLead(lead);
    linked += 1;
  }

  console.log(`Backfill completato: ${linked} lead collegati a un customer, ${skipped} lead saltati (gia collegati o privi di contatto).`);
}

main().catch((error) => {
  console.error("Backfill fallito:", error);
  process.exitCode = 1;
});
