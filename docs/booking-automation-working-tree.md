# Booking Automation: commit separation

Baseline: `86fc834180c331491ad888a0624c4993c12f4cf8`. La selezione e stata verificata sul diff staged prima di ciascun commit. I file sorgente originali del working tree sono byte-identici allo snapshot iniziale: nessuna modifica precedente persa o riscritta.

## Commit types

`41d60d2907d9003dd868a73247f33bce09084da7`

Dichiarazioni vite/client, lib ES2021, annotazione unknown per normalizeEmail e due assertion sugli allegati. Confronto TypeScript transpileModule: JavaScript emesso identico prima/dopo per entrambi i file TSX; typecheck della copia isolata dell'index superato. Nessun cambiamento runtime o nuova funzione.

## Commit backend Booking

`2d8c65c4f08e42c8861521cf36b48632d6396d90`

| File incluso | Scope |
|---|---|
| backend/.env.example | Booking backend e test pertinenti |
| backend/config/whatsapp-templates.json | Booking backend e test pertinenti |
| backend/package.json | Booking backend e test pertinenti |
| backend/services/api-gateway/authorization-rules.spec.ts | Booking backend e test pertinenti |
| backend/services/api-gateway/authorization-rules.ts | Booking backend e test pertinenti |
| backend/services/api-gateway/server.ts | Booking backend e test pertinenti |
| backend/services/common/callStore.ts | Booking backend e test pertinenti |
| backend/services/common/chatStore.ts | Booking backend e test pertinenti |
| backend/services/common/whatsapp-automation.spec.ts | Booking backend e test pertinenti |
| backend/services/common/whatsappAutomation.ts | Booking backend e test pertinenti |
| backend/services/lead-service/server.ts | Solo hunk automazione/3CX; esclusi importi e report |
| backend/services/lead-service/threecx-events.spec.ts | Booking backend e test pertinenti |
| backend/services/whatsapp-service/booking-automation.spec.ts | Booking backend e test pertinenti |
| backend/services/whatsapp-service/server.ts | Booking backend e test pertinenti |

Suite backend passata anche nella copia isolata dell'index: nessuna dipendenza dalla tranche precedente lasciata fuori.

## Commit UI Booking

`2e2f54d9c6e45e2f16abe93810bffd44872d25ad`

| File incluso | Scope |
|---|---|
| frontend/src/features/chat/ChatDecisionEngine.tsx | Booking UI e test pertinenti |
| frontend/src/features/chat/chat.logic.test.ts | Booking UI e test pertinenti |
| frontend/src/features/chat/chat.logic.ts | Booking UI e test pertinenti |
| frontend/src/features/chat/chat.types.ts | Booking UI e test pertinenti |
| frontend/src/features/chat/components/Composer.tsx | Booking UI e test pertinenti |
| frontend/src/features/chat/components/WhatsappAutomationSection.tsx | Booking UI e test pertinenti |
| frontend/src/features/chat/components/chat-components.test.tsx | Booking UI e test pertinenti |
| frontend/src/pages/chat-page.tsx | Booking UI e test pertinenti |
| frontend/src/pages/pratica-detail-page.tsx | Solo import WhatsappAutomationInfo, stato/fetch, badge e riepilogo WhatsApp |
| frontend/src/styles/chat-page.css | Booking UI e test pertinenti |
| frontend/src/styles/pratica-detail-page.css | Solo selettori pd-whatsapp-automation |

41 test frontend e typecheck passati nella copia isolata dell'index. Nessun import FormEvent, editor importi o controllo pagamento aggiunto dal commit UI.

## Tranche precedente conservata unstaged

| File | Modifiche escluse dai commit Booking |
|---|---|
| backend/services/common/csv.ts | Intero diff precedente conservato |
| backend/services/lead-service/booking-report.spec.ts | Intero diff precedente conservato |
| backend/services/lead-service/booking-report.ts | Intero diff precedente conservato |
| frontend/src/pages/booking-report-page.tsx | Intero diff precedente conservato |
| frontend/src/pages/leadboard-page.tsx | Intero diff precedente conservato |
| backend/services/lead-service/server.ts | DEFAULT_PAYMENT_ITEMS e commento, separatore CSV, export full=1 |
| frontend/src/pages/pratica-detail-page.tsx | FormEvent, importi iniziali, parser euro/date, editor importi, totale e pagamenti |
| frontend/src/styles/pratica-detail-page.css | Stili editor importi e azioni pagamenti |

## Documentazione e prove

Documentazione Booking, piano Meta completo, rapporto final gate, questo registro di separazione e smoke.json. Screenshot conservati fuori dal repository, nessun helper temporaneo o log di esecuzione versionato. Lo smoke browser del final gate e stato eseguito sul working tree completo prima della separazione; i controlli successivi sui contenuti isolati evitano che i test passino grazie a file non committati.

Nessun push, deploy o cambiamento Railway/Meta. I template restano manual_only e pending; valgono le riserve Meta/3CX documentate nel final gate.
