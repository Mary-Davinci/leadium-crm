# Lead contact correction and duplicate matching

## Admin phone correction

`PATCH /api/leads/:id` with `{ phone }` (sent alone, optional `customerPhoneScope`).

- Admin / super admin only. The gateway takes the author from the session; the lead service
  trusts it only with the internal capability (see "Trust boundary" in
  `3cx-v2-native-call-control.md`).
- The corrected number must be international (`+CC…` or `00CC…`); a national number is refused as
  ambiguous.
- Conflicts (409, nothing written, nothing merged): another lead of a different identity
  (`phone_conflict_lead`) or another customer card (`phone_conflict_customer`) with the number.
- Customer card: if it belongs only to this lead and carries the same number, it is updated too.
  If it is shared with other leads or carries a different number, the admin must choose
  (`customer_choice_required`): `lead_and_customer` or `lead_only`. `lead_only` is a partial
  correction: inbound WhatsApp recognition goes through the customer card, so messages from the
  new number are not linked to this customer until the card is corrected; the UI and the audit say so.
- leadId, customerId, call logs and WhatsApp threads keep their links; nothing is moved.
- Writes are conditional (compare-and-set on the stored value) and compensated in reverse order.
  A compensation never overwrites a value changed meanwhile: if it cannot restore, the API answers
  500 `incoherent_state` with the record ids for manual review. No multi-document transaction is
  used (the deployment may be a standalone MongoDB).
- Audit: activity `lead_phone_changed` with author, timestamp, previous/new lead phone, customer id,
  whether the customer was updated and its previous phone. Technical logs mask numbers.

## Duplicate matching (creation and correction)

`common/phoneIdentity.ts`. `+CC` and `00CC` are equal; digits-only forms (e.g. WhatsApp wa_id)
match by digits. A national number (no prefix) is equated to `+39` only when the deployment sets
`PHONE_DEFAULT_COUNTRY_CODE=39` (the only supported value); the "3…/0…" shape alone never decides
the country. Without the setting national numbers are compared by digits only (previous behavior).
No existing data is migrated.

Lead creation: several open leads for one contact (e.g. phone -> A, email -> B) is a 409
`contact_conflict`. A practice in admin review/closed is never returned to or modified by a
non-admin creation (409 `duplicate_admin_reserved`, no data).

## Tests

- `npm test` (JSON store): `lead-service/lead-contact.spec.ts`, `api-gateway/permission-matrix.spec.ts`.
- MongoDB path, against a disposable loopback server only (the spec refuses any other URI and
  drops its database):

```bash
docker run -d --rm --name leadium-it-mongo -p 127.0.0.1:27999:27017 mongo:7
cd backend && LEADIUM_MONGO_IT_URI=mongodb://127.0.0.1:27999 npm run test:mongo
docker stop leadium-it-mongo
```
