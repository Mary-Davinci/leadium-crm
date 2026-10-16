# WhatsApp Booking: template, automazioni, continuità e 3CX

## Stato commerciale e stato WhatsApp sono separati
Lo stato della pratica (`LEAD_STATUSES` in `backend/services/common/workflow.ts`) resta l'unica fonte per la trattativa. I template WhatsApp **non** aggiungono stati.

Lo stato WhatsApp del lead è **derivato** da dati che esistono già. Non viene salvato due volte:

| Campo esposto | Da dove viene |
|---|---|
| `firstContactSentAt` | messaggi template inviati (`wa_messages`, gruppo `first_contact`) |
| `lastTemplateKey` / `lastTemplateSentAt` | ultimo messaggio template non fallito |
| `followupStep` | numero di template di sequenza inviati |
| `customerRepliedAt` | `conversation.lastInboundAt` |
| `stoppedReason` | regole del motore (vedi sotto) |

Sul lead si salva solo ciò che non è derivabile:

- `doNotContact { active, reason, setAt, setBy }`: opt-out esplicito. **Un messaggio in arrivo non lo annulla**: lo rimuove solo un operatore.
- `whatsappAutomation { paused, stoppedAt, stoppedReason }`: pausa o stop manuale, oppure stop da esito 3CX "non interessato".
- `productInterest`: prodotto o destinazione, usato per `{{1}}` del primo contatto.
- `quoteUrl`: link del preventivo, usato per `{{1}}` di `quote_ready`. Accetta solo `http(s)`.

API: `GET /api/whatsapp/automation/state?conversationId=…` (oppure `?leadId=…`).

## Template
La configurazione è in `backend/config/whatsapp-templates.json`. I 7 template storici sono invariati. I 10 template Booking sono:

| Key | Variabili | Note |
|---|---|---|
| `lead_first_contact` | `{{1}}` prodotto/destinazione | una sola volta per lead (insieme a `primo_contatto_cliente`) |
| `lead_no_answer_followup` | — | sequenza: 24 h dopo il primo contatto senza risposta |
| `lead_qualification` | — | suggerito quando il cliente ha risposto |
| `call_no_answer` | — | suggerito dopo una chiamata senza risposta |
| `quote_ready` | `{{1}}` URL preventivo | non parte senza un URL valido |
| `quote_followup` | — | sequenza: 48 h dopo `quote_ready` |
| `budget_alternative` | — | stato "Fuori budget" |
| `interested_undecided` | — | stato "Contatto interessato" |
| `final_recovery` | — | una sola volta; sequenza: 72 h dopo il sollecito |
| `contact_closure` | — | una sola volta; chiude la sequenza |

Campi per template:

- `parameters`: la variabile Meta (`component: body | button_url`, `index`, `kind: text | url`, `source`: campo del lead usato come valore predefinito).
- `language`: lingua del template su Meta.
- `metaCategory`: categoria del template su Meta.
- `metaStatus`: `approved` oppure `pending`. Con `pending` la chat mostra "in approvazione Meta".
- `automationMode`: `manual_only` (predefinito) oppure `automatic_allowed`.
- `onceGroup`: invio una sola volta per lead.
- `sequence`: `{ after, afterHours }`.
- `endsSequence`: l'invio di questo template chiude la sequenza.
- `requiresQuote`: il template richiede un URL di preventivo.
- `eligibleStatuses`: stati commerciali in cui il template ha senso.

L'invio usa Cloud API `template.components`, per esempio `[{ type: "body", parameters: [{ type: "text", text: "…" }] }]`.

## Regole (motore in `backend/services/common/whatsappAutomation.ts`)
Ogni invio, manuale o automatico, passa da `checkTemplateSend`.

- **Opt-out:** nessun template, né manuale né automatico, e nessun suggerimento.
- **Template "una sola volta"** (primo contatto, `final_recovery`, `contact_closure`): lock in `wa_template_locks`, che regge anche con richieste concorrenti. Se Meta segnala che l'invio è fallito, il lock viene liberato.
- **Template preventivo:** serve un URL `http(s)`. Le variabili obbligatorie mancanti bloccano l'invio, e i valori non vengono mai inventati.
- **Solo automatico:** `WHATSAPP_AUTOMATION_ENABLED=true`, template `automatic_allowed`, nessuno stop attivo, stato commerciale compatibile.

Stop della sequenza, in ordine di precedenza: opt-out → stop manuale o 3CX → pausa → vendita o prenotazione → non interessato, perso o annullato → `contact_closure` inviato → risposta del cliente dopo il primo contatto.

**Idempotenza:**
- il retry dal browser riusa la stessa `idempotencyKey` (indice unico), quindi nessun doppio invio, log o attività;
- il retry del webhook di Meta è deduplicato sul `providerMessageId`;
- il pricing è sovrascritto (`$set`), mai accodato;
- gli stati vanno solo avanti (sent → delivered → read).

**Automazione:** lo scheduler esistente del lead-service (`SLA_TASK_INTERVAL_MS`) chiama `POST /internal/automation/tick` del whatsapp-service solo se `WHATSAPP_AUTOMATION_ENABLED=true`. Il gateway blocca `/api/whatsapp/internal/*`. **Default: tutto disattivato e tutti i template `manual_only`.**

## Audit e costi
Ogni template inviato salva su `wa_messages`:

- `leadId`, `conversationId`;
- `templateKey` / `templateName`, `metaCategory`, `templateParams`;
- `providerMessageId` (id messaggio Meta), `createdAt`, `status` (sent/delivered/read/failed più `statusError`);
- `trigger` (`manual` | `automation`) e `agentName` (l'operatore, preso dalla sessione).

Il campo `pricing { billable, category, pricingModel, type }` e `metaConversation` vengono salvati **solo se Meta li invia** nel webhook di stato. Il CRM non stima costi. La timeline del lead riceve un'attività `whatsapp_template_sent`.

## Continuità WhatsApp (verificata)
- Il webhook `POST /api/whatsapp/webhook` è servito da api-gateway → whatsapp-service su Railway: è un processo server, non dipende da nessun browser.
- Logout o PC spento dell'operatore: nessun effetto. L'inbound viene salvato in Mongo (`wa_messages`, `wa_conversations`) e associato al lead anche senza utenti collegati. Lo vedi alla riapertura della chat (polling ogni 15 secondi).
- Token: `WHATSAPP_ACCESS_TOKEN` è letto solo lato server. Il frontend non contiene token: le uniche variabili `VITE_*` sono 3CX e base URL API.
- Firma del webhook: `WHATSAPP_APP_SECRET` (X-Hub-Signature-256). **Gi? configurata in produzione e verificata tramite webhook firmati (conferma del responsabile del progetto).**
- Diagnostica (solo admin): `GET /api/whatsapp/diagnostics` restituisce la presenza della configurazione (mai i valori), `lastWebhookAt`, `lastInboundAt`, `lastOutboundOkAt` e `lastMetaError { at, stage, code, metaCode }`.

## 3CX
Flusso attuale (invariato): clic sul telefono → URI 3CX con `{callbackUrl}` → `/calls/bridge` nel browser → `POST /api/leads/:id/calls` (idempotente su `requestKey`).

Nuovo flusso server-to-server, senza browser: 3CX → `POST /api/3cx/webhook` con l'header `X-Leadium-3CX-Secret: <THREECX_WEBHOOK_SECRET>` → call-service → lead-service `/internal/call-events`. Senza il secret configurato, l'endpoint richiede la sessione come prima.

Payload: `callId` (per l'idempotenza), `from`, `disposition`, `startedAt`, `endedAt`, `durationSeconds`, `callbackAt`, `note`, `agent`, `agentDisposition`, `lossReason`.

| Evento 3CX | Effetto |
|---|---|
| `no_answer` / `missed` | stato "Non risponde", tentativo +1, attività con `suggestedTemplate: call_no_answer` |
| `busy` | registrata, stato invariato |
| `callback` con `callbackAt` | "Richiamo concordato", `nextActionAt` e task di richiamo |
| `callback` senza data | registrata, stato invariato (nessuna data inventata) |
| `interested` | cambia stato solo con `agentDisposition: true` |
| `not_interested` | ferma sempre i solleciti WhatsApp; chiude come "Contattato non interessato" solo con `agentDisposition: true` e `lossReason` |

Il CallLog salva: lead, data e ora (`startedAt`), operatore (`agent`), esito, `durationSeconds`, `callbackAt` e note.

## Final gate e piano Meta

Vedi `whatsapp-meta-template-plan.md` per tutti i testi definitivi PM, categorie proposte, variabili e stati locali. `pending` non certifica che un template sia stato creato o sottoposto a Meta.
