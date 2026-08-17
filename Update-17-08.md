# Changelog — fix di questa sessione

Tutte le correzioni sono state verificate con test automatici che simulano
davvero l'app in un browser (jsdom), non solo lette a occhio. Ogni test
riproduce lo scenario del bug, verifica che fallisse PRIMA del fix, e
conferma che passa DOPO.

---

## 1. Bug "il piano si chiude" (Ricerca per slot)

**Sintomo:** salvando i criteri di ricerca in uno slot del Piano Rosa, la
sezione Piano si svuotava e le chip dei candidati sparivano.

**Causa:** `savePlan()` cancellava temporaneamente il campo `id` dall'
oggetto piano **condiviso** (lo stesso oggetto dentro `rosterPlans`, non
una copia) prima di inviarlo a Supabase, e lo ripristinava solo dopo che
la chiamata di rete finiva. Nel frattempo, il refresh dell'interfaccia
chiamato subito dopo cercava il piano per `id` e non lo trovava più.

**Fix:** `savePlan()` ora costruisce una copia pulita del payload da
inviare, senza mai toccare l'oggetto originale in memoria.

---

## 2. Sovrascrittura totale dei dati (il bug "capita troppo spesso")

**Sintomo:** se tu e il tuo compagno modificavate campi diversi dello
stesso giocatore/squadra/piano quasi in contemporanea, chi salvava per
ultimo cancellava senza accorgersene le modifiche recenti dell'altro,
anche su campi completamente diversi.

**Causa:** ogni salvataggio riscriveva l'**intero** blob JSON della riga
(`data`), non solo i campi effettivamente cambiati.

**Fix — nuovo meccanismo di salvataggio "a fusione":**
- `computeChangedFields()`: confronta lo stato attuale con una "baseline"
  presa al momento dell'apertura della scheda, e produce solo i campi
  *davvero* cambiati (con normalizzazione numero/stringa per evitare falsi
  positivi tipo `"20"` vs `20`).
- `mergeSaveRow()`: prima di scrivere, rilegge il dato più fresco dal
  server, poi scrive sopra solo i campi cambiati — non l'intero oggetto.

**Dove è stato applicato:**
- Editor giocatore (mobile e desktop/Window Manager)
- Editor squadra (mobile e desktop/Window Manager)
- Lavagna tattica squadre
- Assegnazione/rimozione in asta
- Riassunto AI e richieste asincrone
- Proiezioni Oracolo (trend, variazione, nota)
- Impostazioni squadre lega (`persistLeagueTeam`)

**Bug secondario trovato durante il fix:** dopo un salvataggio, se il
sistema assorbiva un valore "fresco" del server per un campo non
toccato, ma il modulo a schermo non veniva aggiornato di conseguenza, un
salvataggio *successivo* poteva ri-inviare per errore il vecchio valore
visualizzato, cancellando di nuovo la modifica del compagno. Corretto
facendo avanzare la baseline solo sui campi realmente modificati
dall'utente, non su tutto il record.

---

## 3. Stesso bug, versione Piano Rosa (slot)

**Sintomo (potenziale, non ancora segnalato ma verificato in test):** se
tu e il tuo compagno modificavate slot diversi dello stesso piano (anche
nello stesso reparto) quasi in contemporanea, uno poteva sovrascrivere
lo slot dell'altro con una copia locale non aggiornata.

**Fix:** `savePlan()` ora riceve esplicitamente quale slot (reparto +
indice) è stato appena modificato, e aggiorna **solo quello** sopra il
dato fresco del server. Tutti gli altri slot, anche dello stesso
reparto, restano quelli più recenti letti dal server, mai quelli in
memoria locale.

---

## 4. Drag & drop asta

**Bug reale trovato:** se trascinavi un giocatore **già assegnato a una
squadra** su una **squadra diversa**, il form di conferma si apriva con
il prezzo pagato alla vecchia squadra ancora precompilato nel campo
prezzo. Durante un'asta dal vivo, con la fretta del momento, si rischiava
di confermare per sbaglio un prezzo che non era quello vero pattuito con
la nuova squadra.

**Fix:** il prezzo si svuota automaticamente quando trascini su una
squadra diversa da quella attuale; resta precompilato solo se stai
ri-modificando l'assegnazione sulla stessa squadra (comportamento
corretto in quel caso, perché lì il prezzo è quello che si vuole
davvero modificare).

**Bug minore:** le card giocatore diventavano "trascinabili"
(`draggable="true"`) anche su mobile quando la Modalità Asta era attiva,
anche se il drag & drop è pensato solo per desktop (il resto del sistema,
sidebar inclusa, è già gestito come desktop-only). Su mobile questo non
faceva danni concreti ma poteva causare comportamenti strani del tocco
su alcuni browser. Corretto: ora `draggable` si attiva solo su desktop.

**Rifinitura minore:** se un trascinamento finiva in modo anomalo (es.
rilasciato fuori da una zona valida), il bordo di evidenziazione sulla
squadra target poteva restare "incollato" visivamente. Aggiunta una
pulizia di sicurezza a fine trascinamento.

**Verificato e OK, nessun intervento necessario:**
- Separazione tra le card trascinabili (tab Rosa) e le righe della
  Modalità Rapida (che usano markup diverso, non draggable) — nessuna
  interferenza tra i due sistemi.
- Le due zone di rilascio (sidebar asta desktop e card squadra nel tab
  Asta) si ricreano ad ogni render, quindi niente listener duplicati o
  doppie assegnazioni.
- Il meccanismo di rollback in caso di errore di rete durante
  l'assegnazione (introdotto in una sessione precedente) resta intatto.

---

## 5. Sidebar asta: schermata "spostata" e non centrata

**Sintomo:** attivando la Modalità Asta su desktop, tutta la pagina si
sposta verso destra e il contenuto (es. la lista Rosa) non risulta più
centrato.

**Causa:** quando la sidebar dell'asta si apre, il CSS riservava lo
spazio scrivendo `margin-right:310px` direttamente sull'elemento
`<main>`. Il problema è che `<main>` era già centrato con
`margin:0 auto` (margine sinistro e destro entrambi automatici, calcolati
dal browser per centrare il contenuto). Forzare SOLO il margine destro a
un valore fisso rompe questo equilibrio: il margine sinistro resta
"automatico" e assorbe tutto lo spazio rimanente, che su schermi larghi
è ben più di 310px, spostando visibilmente il contenuto verso destra
(più spazio vuoto a sinistra, meno a destra). Su un monitor di una
larghezza specifica l'effetto poteva non notarsi (per coincidenza i due
valori si equivalevano), ma su schermi più larghi o più stretti lo
spostamento diventava evidente — esattamente come descritto.

**Fix:** invece di alterare il margine di `<main>`, lo spazio per la
sidebar viene ora riservato con un padding sul `<body>`
(`padding-right:310px`). In questo modo `<main>` continua a centrarsi
correttamente con il suo `margin:0 auto`, semplicemente all'interno di
uno spazio disponibile più stretto (quello non coperto dalla sidebar) —
il centraggio resta sempre corretto, a qualunque larghezza di schermo.
Come effetto collaterale positivo, anche l'header (che prima si estendeva
a piena larghezza, finendo parzialmente coperto dalla sidebar) ora si
restringe in modo coerente con il resto della pagina.

---

## 6. Tab Rosa

**Bug reale — ordinamento "Fascia" rotto:** nel menu "Ordina per", le
opzioni **Fascia** e **Priorità** sono due voci distinte nel menu, ma nel
codice condividevano la stessa identica funzione: selezionare "Fascia"
in realtà ordinava per le stelline di priorità, non per la fascia
(Top/Semitop/Medio/Regolarista/Scommessa). Probabilmente un residuo di
codice copiato quando le due cose erano ancora legate (prima del kit v4,
che le ha rese volutamente indipendenti). Corretto: ora "Fascia" ordina
davvero per fascia, con l'ordine naturale Top → Semitop → Medio →
Regolarista → Scommessa, e i due ordinamenti danno risultati diversi
come ci si aspetta.

**Miglioramento prestazioni:** la ricerca testuale ricostruiva l'intera
lista (fino a centinaia di giocatori, incluso il ricalcolo delle
proiezioni Oracolo su ogni card) ad **ogni singolo carattere digitato**,
senza alcun ritardo. Su un roster completo questo può causare scatti
percepibili mentre si scrive. Aggiunto un piccolo ritardo (150ms, lo
stesso tipo di pattern già usato altrove nell'app per il salvataggio
della lavagna tattica) prima di ricalcolare la lista.

**Verificato e OK, nessun intervento necessario:**
- La cache del testo di ricerca per giocatore (`_searchBlobCache`) viene
  correttamente invalidata ad ogni filtro, niente risultati stantii.
- I filtri per tag, tag squadra, ruolo reale e completezza scouting
  funzionano correttamente in combinazione (nessun bug, anche se
  combinare filtri molto specifici può dare "0 risultati" — comportamento
  atteso, non un bug).
- Le chip "candidato" nel Piano Rosa gestiscono già correttamente il
  caso di un giocatore eliminato nel frattempo (mostrano "👻 non più in
  rosa" invece di rompersi).
- Eliminare un giocatore pulisce correttamente la lista di confronto e
  chiude eventuali finestre aperte su di lui (desktop).
- Nessun listener duplicato nelle barre filtro (tag, tag squadra): si
  ricreano da zero ad ogni render.

---

## 7. Oracolo — euristica automatica delle proiezioni FM

**Contesto:** l'euristica automatica (quella marcata "🤖 ipotesi
automatica", usata solo quando NON hai impostato tu un trend/variazione
manuale) è stata segnalata come poco affidabile. Non è un singolo "bug"
in senso stretto — non c'è un errore che rompe qualcosa — ma tre difetti
metodologici concreti nel modo in cui calcola la stima, tutti verificati
con test mirati:

**1. Le presenze stagionali non venivano mai usate.** Un giocatore con
3 presenze e uno con 35, a parità di altri numeri, venivano trattati
identicamente. Questo rendeva i fattori "Rendimento vs xG" e "Gol
previsti vs scorsi" — che si basano su totali di stagione — inaffidabili
per chi ha giocato poco: pochi episodi casuali (es. 2 gol in 3 presenze
da un attaccante di riserva) generavano un impatto enorme sulla
proiezione, quanto quello di un titolare fisso con lo stesso scarto
gol/xG su tutta la stagione. **Fix:** ora il peso di questi due fattori
si riduce quando le presenze sono poche (sotto le 20, in modo
proporzionale, mai sotto il 20% del peso pieno), usando il campo
`presenzeAnnoScorso` già presente nei dati ma mai sfruttato.

**2. La curva età era identica per tutti i ruoli, portieri compresi.**
Un portiere trentaquattrenne veniva penalizzato nella proiezione tanto
quanto un attaccante trentaquattrenne, anche se nella realtà i portieri
tendono a rendere bene più a lungo. **Fix:** aggiunta una curva età
separata e più tollerante per il ruolo P.

**3. Mancava del tutto un fattore legato alla solidità difensiva della
squadra, per portieri e difensori.** Il dato esisteva già
(`fragilitaDifensiva`, usato altrove per gli abbinamenti attaccanti) ma
l'euristica lo ignorava per P/D, pur avendo già un fattore equivalente
("Contesto offensivo") per attaccanti e centrocampisti basato
sull'offensività della squadra. In un fantacalcio con bonus legati ai
clean sheet, questo è probabilmente uno dei driver più rilevanti per la
fantamedia di quei ruoli. **Fix:** aggiunto un fattore "Contesto
difensivo squadra" simmetrico a quello offensivo, con peso analogo.

**Un avviso onesto:** questi tre fix rendono la logica più solida e
meno ingannevole su casi concreti (campioni piccoli, portieri, difensori
di squadre forti/deboli) — ma restano comunque un'euristica basata su
una manciata di statistiche proxy, non un modello previsivo serio.
Prevedere la fantamedia di un giocatore per una stagione intera è un
problema difficile anche per chi fa analytics sportivo di professione
con molti più dati. Il sistema resta pensato come **suggerimento di
partenza**, non oracolo vero: il giudizio umano (trend/variazione
manuale) ha e deve continuare ad avere sempre la priorità, come già
progettato dal kit v16.

---

## 8. Conflitto storico `__v20done` (v20a candidati vs v20b ricerca)

**Richiesta:** verificare/sistemare il vecchio conflitto tra i due kit
v20, quello per cui il kit v21 (mai riuscito) doveva risolvere.

**Esito: già risolto, nessuna modifica necessaria.** Ho fatto una
verifica approfondita — non solo i nomi dei flag, ma tutta la catena di
iniezione — e confermato che il conflitto originale non esiste più nel
file attuale:

- Il conflitto storico riguardava `slotEl.__v20done`, una proprietà
  scritta da **entrambi** i kit sullo stesso elemento DOM per segnare
  "già potenziato". Nel codice attuale i due kit usano nomi **diversi**:
  `slotEl.__v20candDone` (candidati) e `slotEl.__v20ricDone` (ricerca) —
  zero sovrapposizione.
- Ho controllato anche gli altri "flag di sicurezza" usati dai due kit
  (`window.__kitV20` per i candidati, `window.__kitV20Applied` per la
  ricerca) — anche questi nomi sono diversi, nessuna collisione.
- Ho confrontato **tutti** i nomi di stato condiviso (proprietà su
  `slotEl.__*` e `window.__*`) usati nei due blocchi: l'intersezione è
  vuota, confermato via script.
- Ho verificato empiricamente (non solo leggendo il codice) che
  renderizzando il Piano **4 volte di seguito** — per simulare
  aggiornamenti realtime ravvicinati — compaiono sempre e solo **un**
  bottone "🔍 Ricerca" e **una** riga "🎯 Candidati" per slot: nessuna
  duplicazione, nessun elemento mancante.

Ho aggiunto un test automatico dedicato (`test_v20_conflict.js`) che
resta nel progetto di test per questa sessione, così se in futuro un
nuovo kit reintroducesse per sbaglio un nome condiviso, lo si scopre
subito invece di scoprirlo a bug già in produzione.

**Nota:** il conflitto era la causa *sospettata* nel vecchio Recap.md
per il bug "il piano si chiude", ma la causa *reale* di quel sintomo,
trovata e corretta in questa sessione (punto 1 del changelog), era
un'altra — la cancellazione temporanea dell'`id` in `savePlan()`. Il
conflitto `__v20done` era comunque un problema latente reale (i tuoi fix
manuali precedenti lo avevano già sistemato correttamente), semplicemente
non era la causa di quello specifico sintomo.

---

## 9. "Fuori Serie A" — la chip resta anche col flag disattivato

**Sintomo segnalato:** impostando il flag a `false` sulla scheda di un
giocatore, la chip "🌍 Fuori Serie A" continua comunque ad apparire.

**Causa:** `custom.fuoriSerieA` non ha una vera casella di spunta — si
modifica dall'editor generico dei "campi personalizzati", dove sia il
nome che il valore del campo sono semplici caselle di **testo libero**.
Se il valore viene scritto come testo `false` (invece di essere
rimosso), viene salvato come **stringa** `"false"`, e in JavaScript
qualunque stringa non vuota — `"false"` compresa — viene considerata
"vera". Il controllo che decide se mostrare la chip (`p.custom &&
p.custom.fuoriSerieA`) non se ne accorgeva, e continuava a mostrare la
chip anche col flag "spento" testualmente.

**Fix:**
- Aggiunta una funzione `isFuoriSerieA(p)` che interpreta correttamente
  tutti i modi in cui il valore può presentarsi: booleano `true`/`false`,
  stringa `"true"`/`"false"`/`"0"`/`"no"`, campo assente, stringa vuota.
  Usata ovunque al posto del controllo diretto (badge sulla card, elenco
  nel modale 🌍 di pulizia).
- Aggiunto un piccolo avviso nell'editor dei campi personalizzati,
  visibile solo sulla riga `fuoriSerieA`, che spiega come togliere
  davvero il flag: eliminare la riga con ✕, non scrivere "false" nel
  valore.

Verificato con una batteria di 9 casi (booleano, stringa "false" — il
bug esatto segnalato —, stringa "0", "no", vuoto, assente, ecc.) più un
test end-to-end sul rendering reale della card: tutti passano.

---

## 10. Piano Rosa per reparto (nuova funzionalità)

**Richiesta:** poter avere più piani separati per reparto — vari piani
Difesa, vari piani Attacco, ecc. — invece di un unico piano con slot
per tutti e 4 i reparti insieme.

**Come funziona ora:**
- Nella War Room → 📋 Piano sono comparse 4 **tab reparto** (Por / Dif
  / Cen / Att), simili a quelle già usate altrove nell'app.
- Ogni reparto ha il **proprio** piano attivo e il proprio selettore: puoi
  avere "Piano Difesa aggressivo" e "Piano Difesa conservativo" entrambi
  disponibili sotto la tab Difensori, e scegliere quale tenere attivo,
  del tutto indipendente da cosa hai attivo sotto Attaccanti.
- "+ Nuovo piano" crea un piano già legato al reparto che stai guardando,
  con nome suggerito automaticamente (es. "Piano Difensori 2").
- Il budget allocato mostrato è quello del **solo reparto** che stai
  guardando, non più la somma di tutti e 4 insieme.
- Il badge 🎯 sulle card della Rosa continua a funzionare correttamente:
  ogni giocatore viene confrontato con il piano attivo del **proprio**
  reparto, indipendentemente da quale tab reparto hai aperto in quel
  momento nella War Room.

**I tuoi piani esistenti sono al sicuro:** i piani creati prima di
questa modifica (quelli "vecchio formato", con slot su più reparti
insieme) continuano a funzionare esattamente come prima — compaiono
automaticamente nella tab di ciascun reparto per cui hanno già slot
compilati, etichettati come "(generico)" nel selettore. Non è stata
fatta nessuna migrazione/conversione automatica dei dati esistenti:
nulla è stato spostato, rinominato o cancellato. Se un giorno vorrai
"spacchettare" un piano storico in piani separati per reparto, è
un lavoro che si può fare a parte, ma per ora convivono senza problemi
con quelli nuovi.

**Nota tecnica per chi legge il codice:** la struttura dati sotto al
cofano (`plan.slots` diviso per reparto) è rimasta **invariata** — ho
aggiunto solo un campo `plan.reparto` opzionale e riorganizzato
l'interfaccia sopra. Questo significa che tutto il codice dei kit v20
(candidati con menu cliccabile, ricerca per slot — circa 560 righe già
testate a fondo) non è stato toccato per niente: continua a funzionare
esattamente come prima, riducendo di molto il rischio di introdurre
bug nuovi in una modifica già di per sé grande.

Verificato con 8 controlli end-to-end dedicati: tab presenti, piano
storico visibile e intatto, creazione piano nuovo scoped al reparto
giusto, isolamento tra piani di reparti diversi (editare Attacco non
tocca Difesa), candidati/ricerca ancora funzionanti, badge 🎯 corretto
sulla Rosa indipendentemente dalla tab aperta in War Room.

---

## 11. Barra panoramica budget per reparto (nuova funzionalità)

**Richiesta:** una barra riassuntiva sopra le tab reparto, che mostri
"quanto budget porta via" ciascun reparto — colorata a segmenti, con le
percentuali — così da avere un colpo d'occhio su come si sta spalmando
il budget totale tra Portieri/Difensori/Centrocampisti/Attaccanti prima
ancora di entrare nel dettaglio di un singolo reparto.

**Cosa fa:**
- Una barra a segmenti in cima al Piano, un colore per reparto (stessi
  colori già usati altrove nell'app per P/D/C/A — niente di nuovo da
  imparare visivamente).
- Ogni segmento è largo in proporzione a quanto budget è allocato nel
  piano **attivo** di quel reparto, rispetto al budget totale dell'asta.
- Sotto la barra, una legenda con crediti esatti e percentuale per ogni
  reparto che ha un piano attivo.
- **Cliccabile**: clic su un segmento o su una voce della legenda salta
  direttamente a quella tab reparto.
- Si aggiorna in tempo reale mentre modifichi un budget di uno slot,
  senza bisogno di ricaricare o cambiare tab.
- **Gestisce anche lo sforamento budget** (che nella lega è
  volutamente permesso, non è un errore): se il totale allocato supera
  il budget dell'asta, la barra si riempie tutta e passa a uno stile di
  avviso (bordo e percentuale in rosso, "· oltre budget" accanto al
  totale), invece di provare a disegnare percentuali che non hanno più
  senso.

Verificato con 5 controlli dedicati: totale e percentuale corretti,
segmenti presenti solo per i reparti con un piano attivo, proporzioni
corrette tra segmenti di importi diversi, clic sulla legenda che salta
di tab, e lo scenario di sforamento budget.

---

## 12. Temperatura di mercato e previsione prezzo — ora usa l'FVM (nuova funzionalità)

**Richiesta:** rifinire la Temperatura di mercato usando le fonti prezzo
disponibili, in particolare l'FVM di fantacalcio.it (adattato a 500
crediti) già presente per tutti i giocatori nel campo `custom.fvm`.

**Il problema che risolveva:** prima, sia la "Previsione automatica"
che la "Temperatura di mercato" funzionavano **solo** confrontando le
vendite reali dell'asta con `prezzoPrevisto` — un campo che devi
compilare **a mano, giocatore per giocatore**. Con 663 giocatori, in
pratica quasi nessuno lo aveva compilato, quindi durante l'asta questi
due strumenti restavano quasi sempre su "dati insufficienti", proprio
quando servirebbero di più (nelle prime vendite di ogni fascia).

**Come funziona ora:**
- Nuovo concetto di **"prezzo di riferimento"**: per ogni giocatore si
  usa la tua stima manuale se l'hai compilata (`prezzoPrevisto`, ha
  sempre priorità — stesso principio già usato per l'Oracolo, il tuo
  giudizio vince sull'automatico), altrimenti l'**FVM** già presente per
  tutti. Prima c'era solo la prima opzione, quindi il dato semplicemente
  mancava per la maggior parte dei giocatori.
- **Temperatura di mercato**: ora calcola con qualunque combinazione di
  vendite che abbiano un riferimento (manuale o FVM) — praticamente
  sempre disponibile, invece di richiedere che tu avessi già compilato
  a mano il prezzo previsto per gli specifici giocatori venduti.
  L'etichetta ora indica anche quante vendite su quante sono basate
  sulla tua stima vs sull'FVM, per trasparenza.
- **Previsione automatica prezzo**: usa un "mix" intelligente — con
  poche vendite reali nella fascia (2-3), mescola la media di mercato
  con l'FVM del giocatore specifico (più vendite reali ci sono, meno
  peso ha l'FVM); con 0-1 vendite, si affida del tutto all'FVM/tua
  stima invece di restare vuota; con 4+ vendite reali, si affida
  **solo** al mercato reale e ignora l'FVM (a quel punto il mercato
  effettivo è un segnale più affidabile). La stessa logica di "quanto
  fidarsi in base a quanti dati ho" già usata per l'Oracolo questa
  sessione.

Verificato con una batteria dedicata: priorità stima manuale su FVM,
fallback automatico quando il testo non è numerico, temperatura
calcolata anche con soli dati FVM, previsione con 1 sola vendita che
usa l'FVM del giocatore, e — importante — verificato che con
**abbastanza vendite reali il sistema ignori correttamente un FVM
fuorviante** piuttosto che lasciarsi influenzare da un singolo numero
non affidabile.

---

**Sul foglio xlsx che avevi caricato (`prezzi_asta_500crediti.xlsx`):**
non l'ho usato, e te lo dico chiaramente perché. L'ho analizzato prima
di scartarlo:
- Copre solo **200 giocatori su 663** del tuo listone, e in modo molto
  sbilanciato (76 attaccanti, appena 8 portieri) — proprio dove la
  Temperatura di mercato avrebbe più bisogno di copertura, questo file
  ne ha meno.
- Le 5 fonti che combina hanno coperture molto diverse tra loro (una
  arriva a coprire solo 22 giocatori su 200), quindi la "media" che
  calcola pesa in modo incoerente da un giocatore all'altro.
- I nomi sono scritti in modo incoerente (maiuscolo/minuscolo misto) e
  le squadre a volte abbreviate a volte no — un matching automatico
  contro i tuoi giocatori avrebbe prodotto inevitabilmente errori
  silenziosi.

Dato che l'FVM che avevi già in `custom.fvm` copre **tutti** i 663
giocatori con una fonte sola e coerente, è una base molto più solida
per questa funzionalità. Se in futuro vuoi comunque usare quel foglio
come "secondo parere" solo per i 200 giocatori che copre (es. un
avviso "questa fonte esterna dice un prezzo molto diverso dall'FVM,
occhio"), è fattibile come aggiunta separata — ma non l'ho costruito
ora per non appoggiare una funzionalità nuova su dati che tu stesso hai
detto di non trovare affidabili.

---

## 13. Temperatura di mercato — soglie configurabili e trasparenza sull'affidabilità

**Richiesta:** i punti 1 e 3 discussi con l'utente — rendere onesto
quando la temperatura si basa su pochissime vendite, e rendere le
soglie "caldo"/"freddo" (prima fisse a 1.15/0.85) meno arbitrarie.

**Soglie configurabili:** invece di inventare nuovi numeri "migliori"
(che sarebbero comunque arbitrari, solo diversi), le soglie sono ora
un'impostazione che si tocca da ⚙️ Impostazioni asta → 🌡️ Soglie
temperatura mercato, con i vecchi valori (1.15/0.85) tenuti come
default. Così la lega decide cosa intende per "caldo" in base a come
si comporta davvero la propria asta, invece di subire un numero
nascosto nel codice spacciato per oggettivo. Validazione inclusa: se si
salva un valore assurdo (es. soglia calda sotto 1, o soglia fredda
sopra 1), si torna automaticamente al default invece di salvare un
dato che romperebbe il calcolo.

**Trasparenza sull'affidabilità:** ogni volta che la temperatura si
basa su sole 2-3 vendite (contro le 4-5 quando il campione è più
solido), ora lo si vede: le celle della griglia 4×5 diventano
tratteggiate con un piccolo "?" e il tooltip dice esplicitamente "dato
indicativo", i box di testo (nel form del giocatore, nel pannello Asta)
aggiungono un "⚠️ ancora poco affidabile". L'informazione resta
visibile — è comunque meglio di niente — ma non finge una sicurezza
che i numeri non hanno.

Verificato: soglie che cambiano davvero il verdetto quando modificate,
validazione che scarta valori assurdi, indicatore di confidenza
correttamente basso con 2-3 vendite e alto con 4+.

---

## In sospeso — proposta calibrazione lega-specifica

Discusso con l'utente ma non ancora implementato: usare
`spesaAnnoScorso` (prezzo pagato nell'asta reale dell'anno scorso, già
presente) insieme al listone di agosto 2025 (da reperire — fonte da
confermare) per calcolare quanto la propria lega, storicamente, si
scosta dal listino ufficiale per fascia/reparto — un fattore di
calibrazione specifico invece di affidarsi all'FVM generico così com'è.
Idea validata come sensata, in attesa di sapere da dove arriverebbe il
dato del listone 2025 prima di costruirci sopra.

---

## 14. War Room — refresh completo della schermata ogni pochi secondi

**Sintomo segnalato:** la War Room rifaceva un refresh visibile dell'intera
schermata ogni pochi secondi, mentre si stava su Plancia o Acquisti.

**Causa:** un `setInterval` chiamava `renderWarRoom()` — un **rebuild
completo** della sezione — ogni 2.5 secondi, indipendentemente dal fatto
che qualcosa fosse davvero cambiato. Perché era stato messo lì? Trovata
la vera causa a monte: quando arriva un aggiornamento in tempo reale
(es. il compagno assegna un giocatore), il codice aggiornava già Rosa,
Confronto e Asta — ma **non la War Room**. Qualcuno probabilmente se
n'era accorto e aveva "rattoppato" il sintomo con un timer che rifà
tutto alla cieca, invece di sistemare il vero buco.

**Fix:** tolto il timer, e aggiunto l'aggiornamento della War Room
esattamente dove già avveniva per le altre tab — dentro i due gestori
degli eventi in tempo reale (`handleRemoteChange` per giocatori/squadre,
`handleLeagueTeamsChange` per budget/impostazioni). Così la War Room si
aggiorna **solo quando serve davvero** (qualcosa è effettivamente
cambiato), invece che alla cieca ogni 2.5 secondi.

**Bug preesistente scoperto per strada** (non introdotto in questa
sessione, ma mai emerso prima): dentro `handleRemoteChange`, la
variabile `rec` (il record aggiornato) veniva dichiarata con `const`
dentro il blocco `else`, ma poi usata anche **fuori** da quel blocco per
propagare l'aggiornamento alle finestre desktop aperte (Window
Manager) — cosa impossibile in JavaScript per come sono fatti gli
`const`/`let` dentro un blocco. Il risultato pratico: ogni singolo
aggiornamento in tempo reale falliva silenziosamente proprio
sull'ultimo pezzo, quindi **le finestre desktop aperte non si sono mai
davvero aggiornate in automatico quando il compagno modificava lo
stesso record altrove**. Sistemato spostando la dichiarazione fuori dal
blocco, con un `null` di sicurezza per il caso di eliminazione (dove
non esiste un "record" da propagare).

Verificato con test dedicati: il timer disturbante non c'è più, la War
Room si aggiorna comunque correttamente dopo un cambiamento remoto, e
il caso di eliminazione non genera più errori.

---

## 15. Scheda giocatore — riordino sezioni

**Richiesta:** trovare le cose importanti nella scheda giocatore ci
mette troppo tempo.

**Causa:** il pannello con `Fascia`, `Priorità`, `Valore effettivo
(tetto)`, `Prezzo previsto` e la `Previsione automatica`/`Temperatura
di mercato` — cioè esattamente le cose che si consultano più spesso
durante l'asta — era agganciato in fondo alla sezione "Previsioni,
note e meta", che era l'**ultima** sezione del form, dopo Anagrafica,
7 sotto-sezioni di statistiche storiche molto dettagliate (Produzione
offensiva, Qualità del voto, Continuità, Disciplina, Fisico, Contesto,
Note) e Titolarità.

**Fix:** riordinate le sezioni — "Previsioni, note e meta" e
"Titolarità" ora vengono subito dopo Anagrafica, prima delle
statistiche storiche dettagliate. Nuovo ordine: **Anagrafica →
Previsioni (Fascia/Priorità/tetto/prezzo previsto/temperatura) →
Titolarità → Statistiche storiche dettagliate → Valutazioni sulla
squadra**.

Non ho toccato il contenuto di nessuna sezione, né creato/eliminato
sezioni — solo riordinato i blocchi esistenti, per rispettare la
scelta di design già presa in passato di non ri-frammentare il form.
Verificato che l'ordine sia coerente sia sull'editor mobile sia sulla
finestra desktop (Window Manager), dato che condividono la stessa
struttura dati.

---

## Verificato ma NON toccato

- **Conflitto storico `__v20done`** tra i kit v20a/v20b: risultava già
  risolto dai tuoi fix manuali precedenti (flag separati, IIFE isolate).
  Nessun intervento necessario.
- **Vecchio sistema "Piano Rosa" legacy** (`prFormations`,
  `prSaveToSupabase`, righe ~6290-6320 dell'area formazioni): è codice
  morto, il pulsante che lo attiverebbe è commentato e non più raggiungibile
  dall'interfaccia. Non causa bug attivi, ma è ~250 righe di codice inutile
  se un giorno vuoi ripulire il file.

## Cosa NON è stato affrontato in questa sessione

Non ho fatto un giro sistematico sulle altre tab (Rosa, Confronto,
Squadre, drag&drop asta, Modalità Rapida, arricchimento AI). Il lavoro di
questa sessione si è concentrato sui bug che avevi segnalato esplicitamente
(piano che si chiude, sovrascrittura dati). Se vuoi, posso continuare con
un giro sulle altre parti dell'app.
