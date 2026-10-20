# Leadium – Risposta automatica 3CX (estensione Chrome)

Fa partire la chiamata con un solo clic su **Chiama** in Leadium: quando 3CX fa squillare il
client web per il richiamo, l'estensione preme Rispondi nella scheda 3CX. Le altre chiamate
(colleghi, clienti in arrivo) squillano normalmente.

Risponde solo se:
- in Leadium è stato cliccato **Chiama** negli ultimi 25 secondi, e
- la chiamata in arrivo nella scheda 3CX mostra **lo stesso numero** chiamato da Leadium.

Non è un'integrazione supportata da 3CX: preme il pulsante `button[data-qa="answer"]` del client
web (osservato a ottobre 2026). Se un aggiornamento di 3CX lo cambia, l'estensione smette di
rispondere da sola e la chiamata squilla come prima.

## Requisiti
- Chrome o Edge (anche su Mac). Non Safari.
- 3CX aperto come **scheda** del browser con il client web, non come app installata (PWA) né
  Softphone. Sull'interno deve esserci un solo dispositivo collegato, altrimenti Leadium chiede
  quale far squillare.
- Nella scheda 3CX va fatto almeno un clic dopo averla aperta (Chrome consente l'audio automatico
  solo nelle schede in cui si è già interagito).

## Installazione
1. Copiare questa cartella sul computer.
2. Aprire `chrome://extensions` (Edge: `edge://extensions`) e attivare **Modalità sviluppatore**.
3. **Carica estensione non pacchettizzata** → scegliere questa cartella.
4. Ricaricare la scheda di Leadium e la scheda 3CX.
5. Aprire l'icona dell'estensione: nel registro devono comparire «Collegata alla pagina Leadium»
   e «Collegata alla scheda 3CX». L'estensione parte già attiva; la **modalità diagnostica**
   (osserva senza rispondere) serve solo per capire un problema.

## Aggiornamento
Sostituire i file della cartella e premere ↻ sull'estensione in `chrome://extensions`, poi
ricaricare le due schede.

## Privacy
Legge solo la risposta del comando Chiama di Leadium (`/api/3cx/call`) e il riquadro della chiamata
in arrivo nella scheda 3CX. Il registro, locale al browser, mostra solo le ultime 3 cifre dei numeri.
