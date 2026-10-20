import assert from "node:assert/strict";
import { composeDialNumber } from "./phoneDial";

const cases: Array<[string, boolean, string, string, string]> = [
  // stored, whatsappIdentity, expected destination, expected rule, why
  ["+39 333 1234567", false, "3331234567", "it_plus", "+39 mobile -> national"],
  ["+39 06 1234567", false, "061234567", "it_plus", "+39 landline keeps the leading 0"],
  ["0039 333 1234567", false, "3331234567", "it_00", "0039 -> national"],
  ["393331234567", true, "3331234567", "it_whatsapp", "WhatsApp wa_id (E.164 without +) -> national"],
  ["393331234567", false, "393331234567", "unchanged", "39… without + and without WhatsApp evidence is ambiguous: unchanged"],
  ["3931234567", false, "3931234567", "unchanged", "an Italian national number starting with 393 is not stripped"],
  ["3931234567", true, "3931234567", "unchanged", "10-digit national 393… is not a wa_id: unchanged even with WhatsApp evidence"],
  ["3331234567", false, "3331234567", "unchanged", "already national"],
  ["333 123 4567", false, "333 123 4567", "unchanged", "already national, formatting left to the existing normalizer"],
  ["+44 7911 123456", false, "+44 7911 123456", "unchanged", "foreign number unchanged"],
  ["0044 7911 123456", false, "0044 7911 123456", "unchanged", "foreign 00 number unchanged"],
  ["447911123456", true, "447911123456", "unchanged", "foreign WhatsApp identity unchanged"],
  ["+39 12345", false, "+39 12345", "unchanged", "+39 followed by a non-Italian-shaped number is not converted"],
  ["+3912345678901234", false, "+3912345678901234", "unchanged", "too long for an Italian number"]
];
for (const [stored, whatsappIdentity, destination, rule, why] of cases) {
  assert.deepEqual(composeDialNumber(stored, { whatsappIdentity }), { destination, rule }, why);
}
console.log(`PASS dial composition: ${cases.length} cases (Italian +39/0039/wa_id -> national; national, ambiguous and foreign unchanged)`);
console.log("All phone-dial checks passed.");
