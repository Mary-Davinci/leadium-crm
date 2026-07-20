# CRM Crocieriamo

CRM operativo per gestione lead, pratiche, task, chiamate e inbox WhatsApp.

## Stack
- `frontend`: React + Vite
- `backend`: microservizi Node/TypeScript
- `api-gateway`: ingresso unico per il frontend
- persistenza locale JSON o MongoDB

## Moduli principali
- Dashboard operativa
- Pratiche cliente
- Task board
- Chat WhatsApp inbox
- Workflow commerciale
- Analytics KPI

## Requisiti
- Node.js 18+
- npm

## Struttura progetto
```text
frontend/
backend/
docs/
design-system/
scripts/
```

## Design system
Le regole UI/UX operative del CRM sono in:

```text
design-system/MASTER.md
```

Prima di modificare pagine, modali, liste o dashboard, usare quel file come riferimento. Il progetto privilegia chiarezza operativa, densita leggibile e flussi guidati rispetto a decorazioni o componenti duplicati.

## Installazione
Installa le dipendenze nei due workspace:

```bash
npm --prefix frontend install
npm --prefix backend install
```

## Configurazione ambiente
Il progetto usa file locali non versionati.

Backend:
```bash
copy backend\\.env.example backend\\.env
```

Frontend:
```bash
copy frontend\\.env.example frontend\\.env
```

Poi compila le variabili reali dentro i file locali.

## Avvio rapido
Stack completo:

```bash
npm run dev
```

Avvio separato:

Backend:
```bash
npm run dev:backend
```

Frontend:
```bash
npm run dev:frontend
```

## URL locali
- Frontend: `http://localhost:5179`
- API Gateway: `http://localhost:4100`

## Architettura servizi backend
- `api-gateway` (`4100`)
- `lead-service` (`4301`)
- `workflow-service` (`4302`)
- `call-service` (`4303`)
- `analytics-service` (`4304`)
- `ingest-service` (`4305`)
- `whatsapp-service` (`4306`)

## Variabili backend importanti
- `PORT`
- `MONGODB_URI`
- `MONGODB_DB_NAME`
- `MONGODB_SERVER_SELECTION_TIMEOUT_MS`
- `AUTH_MONGO_TIMEOUT_MS`
- `META_VERIFY_TOKEN`
- `META_ACCESS_TOKEN`
- `WHATSAPP_VERIFY_TOKEN`
- `WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`
- `WHATSAPP_TEMPLATE_CONFIG_PATH`

## Variabili frontend importanti
- `VITE_3CX_DIAL_URL`
- `VITE_3CX_CALLBACK_PATH`

## Persistenza
In locale il backend puo usare file JSON dentro:

```text
backend/data/
```

In ambiente reale puo usare MongoDB tramite `MONGODB_URI`.

## Script root
```bash
npm run dev
npm run dev:backend
npm run dev:frontend
```

## Sicurezza
- Non committare mai `backend/.env` o `frontend/.env`
- Non committare token Meta, credenziali Mongo o account di fallback
- Se un token o una password reale sono stati salvati anche solo una volta in una repo o condivisi fuori ambiente sicuro, vanno revocati e rigenerati

## Stato repo prima di pubblicare
Checklist minima:
1. verificare che `.env` locali non siano tracciati
2. verificare che `backend/data/*.json` non siano tracciati
3. confermare che i `.env.example` siano completi
4. build frontend e backend verdi

## Build
Frontend:
```bash
npm --prefix frontend run build
```

Backend:
```bash
npm --prefix backend run build
```
