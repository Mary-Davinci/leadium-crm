# CRM Target Map

Questa mappa serve a chiarire la direzione del CRM Crocieriamo partendo da:

- blueprint storico Zoho basato quasi solo su stati
- workflow attuale del progetto
- integrazioni gia presenti per lead ingest, task, WhatsApp e Meta

Riferimenti attuali:

- stati e transizioni: `backend/services/common/workflow.ts`
- automazioni cambio stato: `backend/services/common/automation.ts`
- ingest lead da sorgenti esterne: `backend/services/lead-service/server.ts`
- webhook Meta e WhatsApp: `backend/services/ingest-service/server.ts`

## Obiettivo

Separare chiaramente:

1. `stato commerciale`
2. `task operativi`
3. `timeline attivita`
4. `checklist documenti/pagamenti`
5. `metadati sorgente lead`

Il vecchio modello Zoho metteva quasi tutto dentro il campo stato. Il CRM attuale e gia piu evoluto e deve continuare in questa direzione.

## 1. Stati Commerciali Target

Questi sono gli stati da mantenere come veri step del funnel.

### Primo contatto

- `Da contattare`
- `Richiamo concordato`
- `Non risponde`
- `Contattato non interessato`
- `Fuori budget`
- `Contatto interessato`

### Trattativa e vendita

- `Vendita unica`
- `Vendita a rate`
- `Primo acconto`
- `Secondo acconto`
- `Saldo`
- `Venduta`

### Chiusura

- `Pronta per chiusura`
- `Chiusa 100%`
- `Persa`

## 2. Stati Da Trasformare In Task O Eventi

Questi elementi non dovrebbero essere stati commerciali principali.

- `Ricontattare`
  - va trasformato in task con `dueAt` o `nextActionAt`
- `1 rata`
  - assorbito da `Primo acconto`
- `2 rata`
  - assorbito da `Secondo acconto`
- `Saldo effettuato`
  - meglio come evento/timeline o chiusura task pagamento
- `Invio gadget`
  - meglio come task post-vendita, eventualmente con stato dedicato solo se serve reporting semplice
- `Invio biglietti`
  - meglio come task post-vendita, eventualmente con stato dedicato solo se serve reporting semplice
- `Annulla flusso`
  - meglio come esito operativo/eccezione, non come stato commerciale ordinario

## 3. Task Operativi Target

Questi task rappresentano il lavoro quotidiano degli operatori.

### Contatto

- primo contatto lead
- richiamo concordato
- richiamo dopo non risposta
- follow-up trattativa

### Documenti

- documenti mancanti
- verifica documenti ricevuti

### Pagamenti

- sollecito primo acconto
- sollecito secondo acconto
- sollecito saldo
- verifica pagamento ricevuto

### Post-vendita

- invio gadget
- invio biglietti
- chiusura pratica

### Chat e comunicazione

- follow-up WhatsApp
- invio template documenti
- invio template pagamento

## 4. Timeline Eventi Target

La timeline deve raccontare i fatti, non sostituire lo stato.

Eventi da tracciare:

- `lead_created`
- `lead_ingested`
- `lead_deduplicated`
- `status_changed`
- `note_added`
- `call_logged`
- `whatsapp_opened`
- `whatsapp_received`
- `task_created`
- `task_completed`
- `document_uploaded`
- `document_verified`
- `payment_logged`
- `payment_verified`

## 5. Campi Lead Target

### Anagrafica base

- `id`
- `fullName`
- `phone`
- `email`
- `status`
- `assignedTo`
- `notes`

### Governance commerciale

- `priority`
- `nextActionAt`
- `lastContactAt`
- `lastAttemptAt`
- `callAttempts`
- `firstContactAt`
- `assignedAt`
- `slaDueAt`

### Esito e qualificazione

- `closingOutcome`
  - `won | lost | disqualified | open`
- `lossReason`
- `lossDetail`
- `budgetDeclared`
- `budgetGap`

### Sorgente lead strutturata

- `source`
- `sourceChannel`
- `sourcePlatform`
- `sourceCampaignId`
- `sourceCampaignName`
- `sourceAdId`
- `sourceAdName`
- `sourceFormId`
- `sourceFormName`
- `sourceLeadId`
- `sourceCreatedAt`

### Meta integration

- `metaLeadgenId`
- `metaEventSync`
  - ultimo sync inviato
  - eventuale errore
  - timestamp ultimo tentativo

## 6. Mappa Vecchio Zoho -> CRM Target

| Zoho storico | CRM target |
| --- | --- |
| None | nessuno stato, evento di creazione |
| Da contattare | Da contattare |
| Richiamo concordato | Richiamo concordato |
| Ricontattare | task operativo |
| Non risponde | Non risponde |
| Contattato non interessato | Contattato non interessato |
| Fuori budget | Fuori budget |
| Contatto interessato | Contatto interessato |
| Rateizzazione | Vendita a rate |
| Primo acconto | Primo acconto |
| Secondo acconto | Secondo acconto |
| 1 rata | assorbito in Primo acconto |
| 2 rata | assorbito in Secondo acconto |
| Saldo | Saldo |
| Venduta a rate | Vendita a rate + Venduta |
| Venduta unica | Vendita unica + Venduta |
| Venduta | Venduta |
| Invio gadget | task post-vendita |
| Invio biglietti | task post-vendita |
| Persa | Persa |
| Annulla flusso | eccezione operativa / stop flusso |

## 7. Gap Principali Da Chiudere

### Gap 1: separazione tra stato e operativita

Da fare:

- usare lo stato solo per il funnel commerciale
- usare task e `nextActionAt` per richiami, documenti, pagamenti, post-vendita

### Gap 2: sorgente lead strutturata

Da fare:

- salvare i dati Meta in campi veri, non solo in `notes` e `raw`

### Gap 3: ownership e SLA

Da fare:

- introdurre campi assegnazione e tempi di presa in carico
- generare task automatici di primo contatto

### Gap 4: post-vendita piu pulito

Da fare:

- spostare gadget e biglietti nella logica task
- lasciare `Venduta` come esito commerciale

### Gap 5: motivi di perdita e uscita

Da fare:

- loss reason obbligatorio per `Persa`
- dettaglio perdita per analisi marketing/commerciale

## 8. Meta CRM Integration Target

Il progetto ha gia la parte webhook lead in ingresso.

Manca la parte di ritorno verso Meta per inviare gli eventi CRM del funnel.

Target:

- inviare un evento Meta quando il lead entra nel CRM
- inviare un evento Meta a ogni cambio stato commerciale rilevante
- usare `leadgen_id` come riferimento principale

Campi minimi richiesti da Meta per la CRM integration:

- `event_name`
- `event_time`
- `action_source=system_generated`
- `user_data.lead_id`
- `custom_data.event_source=crm`
- `custom_data.lead_event_source=<nome crm>`

## 9. Ordine Consigliato Di Implementazione

### Fase 1

- consolidare la mappa stati definitiva
- definire i campi nuovi del lead

### Fase 2

- strutturare i metadati Meta nel lead
- migliorare deduplica e ownership

### Fase 3

- rifinire task post-vendita
- aggiungere motivi perdita

### Fase 4

- inviare eventi CRM a Meta Conversions API
- aggiungere logging, retry e monitoraggio sync

## 10. Decisioni Gia Raccomandate

- tenere gli stati commerciali attuali principali
- non reintrodurre `Ricontattare` come stato
- non trattare `1 rata` e `2 rata` come stati separati
- trasformare parte del post-vendita in task
- strutturare i campi sorgente lead prima di fare la sync completa con Meta
