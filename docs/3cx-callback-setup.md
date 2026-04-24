# Setup Bridge 3CX

## Obiettivo
Usare una chiamata 3CX reale con ritorno nel CRM e salvataggio automatico dell'esito.

## Variabili frontend
Nel frontend configura almeno:

```env
VITE_3CX_DIAL_URL=threecx://call?number={phone}&leadId={leadId}&startedAt={startedAt}&requestKey={requestKey}&returnUrl={callbackUrl}
VITE_3CX_CALLBACK_PATH=/calls/bridge
```

Puoi copiare direttamente:

```text
frontend/.env.example -> frontend/.env
```

## Placeholder supportati
Il template `VITE_3CX_DIAL_URL` supporta:

- `{phone}`
- `{leadId}`
- `{startedAt}`
- `{requestKey}`
- `{callbackUrl}`

## Callback atteso
Il bridge frontend accetta questi query param sulla route callback:

- `leadId`
- `outcome` oppure `disposition` oppure `status`
- `startedAt`
- `requestKey`
- `note`
- `followUpAt`

Alias supportati:

- `leadId`, `lead_id`, `crmLeadId`, `crm_lead_id`
- `startedAt`, `started_at`, `callStartedAt`, `call_started_at`
- `requestKey`, `request_key`, `callRequestKey`, `call_request_key`
- `outcome`, `disposition`, `status`, `callOutcome`, `call_outcome`, `result`, `callResult`, `call_result`
- `note`, `notes`, `comment`, `description`
- `followUpAt`, `follow_up_at`, `callbackAt`, `callback_at`

Esempio:

```text
/calls/bridge?leadId=lead_123&outcome=call_back&startedAt=2026-04-10T10:15:00.000Z&requestKey=callreq_abc&followUpAt=2026-04-11T09:00
```

## Esiti supportati

- `completed`
- `no_answer`
- `busy`
- `call_back`
- `interested`
- `not_interested`

## Comportamento

Quando 3CX ritorna sul callback:

1. il bridge legge i parametri
2. salva l'esito su `/api/leads/:id/calls`
3. applica idempotenza via `requestKey`
4. reindirizza l'utente su `/pratiche`

## Nota importante
Questo bridge è generico. I nomi esatti dei parametri che 3CX può inviare dipendono dalla configurazione del vostro tenant / client.

Se 3CX usa nomi diversi, basta adattare il parser in:

- `frontend/src/lib/threecx.ts`
- `frontend/src/pages/call-bridge-page.tsx`

## Test locale senza 3CX
Puoi verificare il bridge direttamente da:

```text
/calls/bridge/test
```

Questa pagina genera callback finti con naming diversi, utili per validare:

- parser callback
- salvataggio esito
- idempotenza base
- redirect finale verso `Pratiche`
