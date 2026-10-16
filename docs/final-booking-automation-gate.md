# FINAL BOOKING AUTOMATION GATE

Status: GO WITH WARNINGS per revisione e preparazione dei commit. Attivazione dei nuovi template e integrazione tenant 3CX ancora subordinate alle azioni esterne sotto indicate.

## Template readiness

10 testi PM definitivi in config, nessun bodyDraft:true. Variabili solo nei template 1, 2 e 5. Tutti manual_only e metaStatus locale pending. Stato remoto non interrogato: non si dichiara alcuna approvazione. [Piano completo con testi](whatsapp-meta-template-plan.md).

## UI smoke test

Smoke eseguito sul working tree completo prima della separazione dei commit. Frontend Vite localhost:5180, gateway localhost:4510 e servizi backend reali; database JSON fittizio separato, hook sessione disponibile solo NODE_ENV=test, credenziali Meta disabilitate.

| Verifica | 1440x900 | 1100x900 | 390x844 |
|---|---|---|---|
| Riepilogo automazione nella pratica | PASS | PASS | PASS |
| Sezione WhatsApp nella Chat | PASS | PASS | PASS |
| Impostazione e rimozione Non contattare dalla UI | PASS | PASS | PASS |
| Badge Non contattare nella pratica | PASS | PASS | PASS |
| Select template e campi nei template 1 e 2; nessun campo nel 3 | PASS | PASS | PASS |
| quote_ready: URL vuoto/non valido blocca, https valido abilita | PASS | PASS | PASS |
| Composer template: select, variabile, invio visibili e scoperti | PASS | PASS | PASS |
| Composer libero: emoji, allega, testo, template, invio simulato | PASS | PASS | PASS |
| Overflow orizzontale pagina e geometria controlli template | PASS | PASS | PASS |

Corretti durante il gate: riepilogo mancante nella pratica; validazione variabili lato client prima della creazione del job; restringimento grid del composer per evitare controlli tagliati a 390px; anteprima lunga con scroll verticale. Drawer a 1100 e 390px chiuso con il suo pulsante interno.

Evidenze versionate: [misure JSON](booking-automation-gate-evidence/smoke.json). Gli screenshot sono stati esaminati durante il gate e conservati fuori dal repository. Smoke con dati fittizi: non certifica autenticazione di produzione, tastiera virtuale di un dispositivo fisico, Mongo o invii esterni Meta. I controlli verificati sono quelli del flusso richiesto, non ogni controllo dell'intero CRM.

## WhatsApp continuity

Webhook server-to-server: POST /api/whatsapp/webhook, gateway -> whatsapp-service -> store. Nessuna dipendenza da browser acceso o sessione operatore per ricevere. Alla riapertura, storico dal backend e polling. Verificati nei test: firma valida/non valida, associazione identita, retry inbound, stop su risposta cliente, pricing solo da webhook, stato messaggi monotono, opt-out persistente dopo inbound.

WHATSAPP_APP_SECRET gia configurato in produzione e verificato tramite webhook firmati, come confermato dal responsabile del progetto. Non e un'attivita mancante. Nessuna nuova prova remota di produzione effettuata in questa sessione.

## 3CX readiness

Endpoint esatto nel codice: POST /api/3cx/webhook sul gateway pubblico, stesso origin del webhook WhatsApp esistente. URL completo: sostituire /api/whatsapp/webhook con /api/3cx/webhook nell'URL gia configurato. Il dominio pubblico effettivo non e presente nel repository verificato: non viene inventato. Inoltro: call-service /3cx/webhook -> lead-service /internal/call-events.

Header richiesto per accesso server-to-server senza sessione: X-Leadium-3CX-Secret, valore uguale a THREECX_WEBHOOK_SECRET del gateway. Content-Type: application/json. Secret mancante o errato non abilita accesso anonimo; una sessione CRM valida resta una via autorizzata distinta.

Payload minimo operativo con deduplicazione:

~~~json
{"callId":"tenantA:stable-call-id","from":"+393331234567","disposition":"no_answer"}
~~~

from deve essere SEMPRE il numero esterno cliente, anche per le chiamate outbound; in alternativa externalLeadId identifica la pratica. callId deve restare identico nei retry, distinto fra chiamate reali e tenant. Il CRM salva idempotencyKey = 3cx_ + callId e cerca la coppia leadId/idempotencyKey. Non usare l'ora di consegna del webhook o un UUID nuovo a ogni retry.

Idempotenza verificata: retry sequenziale stesso callId non duplica call log, attivita o tentativi. Senza callId il codice processa senza deduplicare. ATTENZIONE: il percorso e read-before-write, senza vincolo Mongo unico per questa coppia e senza transazione sulle attivita. Concorrenza simultanea/multi-processo e crash fra scritture non sono coperti dalla garanzia verificata. Prima di abilitare un connettore che puo produrre consegne concorrenti occorre serializzare/deduplicare nel connettore oppure irrobustire il backend.

Configurazione concreta da fare nel tenant:

1. In Admin Console > Integrations > CRM predisporre un template personalizzato server-side con scenario ReportCall e abilitare Call Journaling; verificare disponibilita nella versione/licenza del tenant. Non basta il link click-to-call del browser.
2. Configurare URL gateway, header segreto e POST JSON. Il secret 3CX non e WHATSAPP_APP_SECRET. Disponibilita/valore di THREECX_WEBHOOK_SECRET in produzione non verificati e non modificati.
3. Mappare Number -> from, Agent -> agent, CallStartTimeUTC -> startedAt ISO UTC, CallEndTimeUTC -> endedAt ISO UTC e DurationTimespan.TotalSeconds -> durationSeconds numerico. CallType Missed/Notanswered -> no_answer; Inbound/Outbound risposte -> completed. busy solo se la sorgente lo distingue davvero.
4. Mappare l'ID chiamata stabile esposto dalla sorgente a callId. La documentazione ReportCall consultata non espone una variabile CallId standard: non promettere [CallId]. Se indisponibile, il connettore deve costruire una chiave deterministica da tenant + numero esterno + Agent + CallDirection + CallStartTimeUTCMillis, verificandone unicita e stabilita sui retry nel tenant, oppure usare un ID CDR verificato. Non inviare nuovi ID a ogni consegna.
5. Richiamo: callbackAt ISO valido; senza data il CRM non inventa una scadenza. Esiti commerciali richiedono input agente: agentDisposition:true; not_interested richiede anche lossReason per cambiare stato, ma ferma comunque i solleciti. ReportCall da solo non conosce queste decisioni: restano nel CRM salvo connettore esplicito.
6. Fare chiamate reale risposta/mancata risposta, richiamo, non interessato e retry dello stesso evento; verificare pratica, call log, task e timeline. Tenant mai modificato o provato in questa sessione.

Fonti ufficiali: [3CX CRM integration](https://www.3cx.com/docs/crm-integration/), [XML e variabili ReportCall](https://www.3cx.com/docs/crm-template-xml-description/).

## Security

Test backend passati: firma webhook, rotte protette senza sessione, identita operatore dalla sessione, secret 3CX, blocco rotte interne WhatsApp sul gateway, validazione upload, permission matrix. Diagnostica WhatsApp limitata agli admin. Nessun secret copiato nelle evidenze. I servizi interni vanno esposti solo alla rete privata prevista dall'architettura: questo gate non e un audit della topologia Railway.

## Tests

- Backend: suite completa PASS, build tsc inclusa.
- Frontend: 41 test PASS.
- Frontend build: PASS; avviso preesistente eval nella dipendenza lottie-web.
- Typecheck backend e frontend: PASS.
- git diff --check: PASS al controllo conclusivo.

Correzioni typecheck preesistenti, confermate in HEAD e separabili: dichiarazioni vite/client (ImportMeta e PNG), lib ES2021 per replaceAll, normalizeEmail con input unknown, narrowing allegati nella pratica. Non rappresentano nuove funzioni Booking.

## Working tree separation

[Matrice completa e selezione hunk](booking-automation-working-tree.md). Separazione per contenuto rispetto al baseline del gate. Gli hunk Booking dei file misti sono selezionati per i commit dedicati; report, leadboard, CSV/Excel e importi/pagamenti restano nel working tree.

## External actions still required

- Creare/sottoporre i 10 template su Meta, verificare categoria/lingua/variabili e ottenere approvazione effettiva prima di aggiornare metaStatus o usarli con clienti.
- Configurare e verificare il connettore tenant 3CX, la chiave stabile e la strategia contro consegne concorrenti; confermare URL pubblico e secret 3CX gia presenti o da predisporre.
- Qualunque futura attivazione automatica richiede decisione esplicita: oggi tutti manual_only e default globale spento.

WHATSAPP_APP_SECRET non manca. Nessuna modifica Railway o Meta. I commit locali sono autorizzati nella fase successiva al gate; nessun push o deploy.

## Recommended commit split

1. Correzioni typecheck preesistenti: vite-env, tsconfig, normalizeEmail, due hunk allegati pratica.
2. Backend Booking WhatsApp/3CX: motore, template PM, persistenza/audit, endpoint, security, test e script suite; selezionare solo hunk Booking di lead-service/server.ts.
3. Frontend Booking: Chat, variabili e validazione, sezioni automazione, badge pratica, CSS composer e riepilogo pratica; escludere importi/pagamenti preesistenti.
4. Documentazione gate, piano Meta, matrice e misure browser JSON; nessuno screenshot o artefatto temporaneo versionato.
5. Tranche precedente separata: report CSV/Excel, leadboard, importi e pagamenti pratica. Non includerla nei commit Booking.
