# Test Manuale Flusso Chiamate Pratiche

## Obiettivo
Verificare coerenza operativa del flusso chiamate tra:
- modal esito chiamata
- card pratica
- dettaglio rapido
- dettaglio pratica
- filtri esito chiamata
- automazioni stato / next action / task

## Prerequisiti
- frontend e backend avviati
- almeno una pratica selezionabile in `/pratiche`
- utente autenticato

## Caso 1 - Esito `call_back`
1. Apri `Pratiche`
2. Seleziona una pratica aperta
3. Clicca `Chiama`
4. In modal scegli `Da richiamare`
5. Imposta una data follow-up
6. Salva

Verifiche attese:
- la pratica resta aperta
- lo stato diventa coerente con `Richiamo concordato`
- `nextActionAt` è valorizzata
- in timeline compare chiamata + task automatico
- il quick detail mostra la prossima azione aggiornata
- il badge ultima chiamata in lista mostra `Da richiamare`
- filtrando per esito `Da richiamare` la pratica compare

## Caso 2 - Esito `no_answer`
1. Apri una pratica
2. Clicca `Chiama`
3. In modal scegli `Nessuna risposta`
4. Salva

Verifiche attese:
- lo stato diventa coerente con `Non risponde`
- viene creato richiamo automatico per domani
- `nextActionAt` è presente e futura
- in timeline compare chiamata + richiamo automatico
- quick detail aggiornato
- filtro esito `Nessuna risposta` trova la pratica

## Caso 3 - Esito `interested`
1. Apri una pratica
2. Clicca `Chiama`
3. In modal scegli `Interessato`
4. Salva

Verifiche attese:
- lo stato diventa coerente con `Contatto interessato` / trattativa
- se mancava una prossima azione, viene creato follow-up automatico
- la pratica non resta senza `nextActionAt` se deve proseguire
- il badge lista e quick detail riflettono l’esito

## Caso 4 - Esito `not_interested`
1. Apri una pratica
2. Clicca `Chiama`
3. In modal scegli `Non interessato`
4. Salva

Verifiche attese:
- lo stato diventa coerente con chiusura negativa
- non resta una `nextActionAt` inutile
- la modal non forza follow-up
- timeline e badge esito si aggiornano

## Test Idempotenza
1. Apri una pratica
2. Esegui un salvataggio esito chiamata
3. Ripeti immediatamente lo stesso submit, oppure simula doppio click rapido

Verifiche attese:
- nessun doppio `callLog`
- nessun doppio task automatico
- nessun doppio cambio stato

## Test Quick Action `Registra chiamata`
1. Apri menu `...` di una pratica
2. Clicca `Registra chiamata`

Verifiche attese:
- la timeline si aggiorna subito
- il quick detail mostra la nuova chiamata
- il badge ultima chiamata in card si aggiorna

## Test Filtro Esito Chiamata
1. Registra almeno due esiti diversi
2. Usa il filtro `Tutti gli esiti chiamata`

Verifiche attese:
- `Completata` mostra solo pratiche con ultima chiamata completata
- `Nessuna risposta` mostra solo pratiche con ultimo esito no answer
- `Interessato` mostra solo pratiche con ultimo esito interessato

## Test Callback 3CX
Se usi il bridge callback:
1. configura `VITE_3CX_DIAL_URL` con `{phone}` e `{callbackUrl}`
2. avvia una chiamata da `Pratiche`
3. fai rientrare il browser su `/calls/bridge?...`

Verifiche attese:
- il bridge salva l’esito
- la pratica risulta aggiornata al ritorno in `/pratiche`
- nessun doppio inserimento se il callback viene richiamato due volte con lo stesso `requestKey`
