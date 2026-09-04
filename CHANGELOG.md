# Changelog — DossierFanta

Storia condensata del progetto. Per dettagli tecnici vedere `ARCHITETTURA.md`.

---

## Stato attuale

L'app ha le tab: **Rosa, Squadre, Confronto, Asta, War Room** (sotto-sezioni Plancia/Acquisti/Formazione/Piano).

Funzionalità chiave operative:
- ✅ Kit v12-v17 + v20 (candidati + ricerca per slot) applicati.
- ✅ Kit v19 assorbito/sostituito dal v20.
- ✅ Oracolo (v15/v16): badge 🔮, modale proiezione, giudizio umano prioritario, euristica con pesi per presenze/età/contesto difensivo (Update-17-08).
- ✅ Fasce modificatore difesa: 8 scaglioni reali lega.
- ✅ Piano Rosa (v17): multi-piano per reparto, slot con fascia/budget/note/ricerca, budget tracking, evidenziazione 🎯 nella Rosa.
- ✅ Piano v2 (sessione recente): fork multi-anchor + edit inline + window WM minimizzabile.
- ✅ Drag & drop asta (desktop), sidebar asta, card dense PC.
- ✅ Riassunti AI: 3 modalità (OpenRouter / LM Studio / Ollama).
- ✅ Realtime sync su tutte le tabelle + refresh WM window del Piano.
- ✅ Codice morto del vecchio Piano Rosa legacy rimosso.
- ✅ Conflitto storico `__v20done` risolto (flag separati, IIFE isolate).

**Aperti / in sospeso**:
- Calibrazione temperatura di mercato lega-specifica: proposta (usare `spesaAnnoScorso` + listone 2025 per stimare quanto la lega devia dal listino ufficiale) discussa, non implementata in attesa di conferma della fonte del listone 2025.

---

## Kit di aggiornamento (v1 → v21)

Il progetto è cresciuto tramite "kit" — file HTML che, aperti nel browser, caricano `index.html` e applicano modifiche automatiche (find/replace). Tabella condensata:

| Kit | Descrizione |
|---|---|
| v1/v2 | posReale autocomplete |
| v3 | sorting/filtering migliorato, card fields custom, fix AI summaries (Ollama), abbinamenti portieri per squadra |
| v4 | fix card fields, split Priorità/Fasce, fasce unificate a 5 |
| v5 | direzione ordinamento (freccia ↑/↓) |
| v6 | riordino menù filtri |
| v6b/v7 | Fuori Serie A come campo personalizzato rimovibile |
| v8 | upgrade grafico + multitasking (window snapping, drag & drop, Alt+W) |
| v9 | drag & drop solo durante l'asta, sidebar asta, card dense PC |
| v10 | Dossier Design System (font, sfondo, restyling completo) |
| v11 | upgrade menu statistiche (sotto-sezioni con emoji) |
| v12 | Simulatore punteggio + formazioni salvate |
| v13 | War Room Dashboard (plancia con gauge, reparti, tavolo guerra, temperatura mercato, ticker, top valore) |
| v14 | War Room 2.0 Quartier Generale (sotto-sezioni Plancia/Acquisti/Formazione, lavagnetta tattica, simulatore con modificatore e roadmap, fusione tab Asta+War Room) |
| v15 | Oracolo (proiezioni giocatori con euristica automatica, badge 🔮 sulle card, modale proiezione, ordinamenti per proiezione, fasce modificatore difesa reali a 8 scaglioni) |
| v16 | Oracolo v2 (giudizio umano prioritario sull'euristica: `trendPrevisto` + `variazionePrevista`, fonte "✍️ la tua valutazione" vs "🤖 ipotesi automatica") |
| v17 | Piano Rosa (multi-piano su Supabase, slot per reparto con fascia/archetipo/budget/note, budget tracking, evidenziazione 🎯 nella Rosa, realtime sync su `roster_plans`) |
| v18 | Chip giocatore nel Piano (archetipo se corrisponde a un giocatore in rosa → chip ⚡ cliccabile; datalist autocomplete) |
| v19 | Candidati multi-chip (sostituito/assorbito dal v20) |
| v20a | Menu cliccabile + Candidati (sostituisce il datalist nativo con un menu a tendina custom su Candidati e Archetipo) |
| v20b | Ricerca per slot (pulsantino 🔍: builder con Ruolo reale multi + Fascia multi, conteggio live papabili, chip blu cliccabile, modale risultati) |
| v21 | Tentativo fallito di risolvere il conflitto `__v20done` tra v20a e v20b (pattern non trovati perché file già modificato a mano) |

---

## Sessioni di fix recenti

### Sessione agosto (Update-17-08 condensato)

Tutti i fix verificati con test automatici in jsdom.

- **Bug "il piano si chiude"**: `savePlan()` cancellava temporaneamente `id` dall'oggetto piano condiviso. Fix: costruisce una copia pulita del payload.
- **Sovrascrittura totale dati** (bug "capita troppo spesso"): ogni save riscriveva l'intero `data`. Fix: nuovo meccanismo "a fusione" — `computeChangedFields()` + `mergeSaveRow()` rilegge dal server, scrive solo i campi realmente cambiati. Applicato a editor giocatore/squadra/lavagna/asta/AI/proiezioni/impostazioni lega.
- **Drag & drop asta**: prezzo precompilato dal vecchio team quando si trascinava su squadra diversa. Fix: prezzo svuotato. Drag `draggable` attivato solo su desktop.
- **Sidebar asta spostata**: `margin-right:310px` rompeva il centraggio `margin:0 auto`. Fix: `padding-right:310px` sul body.
- **Tab Rosa**: "Fascia" nel menu "Ordina per" ordinava per priorità. Fix corretto. Debounce 150ms sulla ricerca live per evitare scatti.
- **Oracolo euristica**: tre fix metodologici — (1) presenze stagionali ora riducono il peso di "rendimento vs xG" e "gol previsti vs scorsi" quando < 20; (2) curva età separata per P; (3) nuovo fattore "Contesto difensivo squadra" per P/D. Resta comunque un'euristica basata su statistiche proxy, non un modello previsivo serio.
- **Conflitto `__v20done`**: già risolto dai fix manuali precedenti (flag separati `__v20candDone` / `__v20ricDone`). Verificato con test dedicato.
- **"Fuori Serie A" chip resta con flag false**: `custom.fuoriSerieA` veniva salvato come stringa `"false"` (sempre truthy in JS). Fix: `isFuoriSerieA(p)` interpreta correttamente booleano/stringa/assente.
- **Piano Rosa per reparto** (nuova funzionalità): 4 tab reparto (Por/Dif/Cen/Att), ognuna con proprio piano attivo. Piani storici "multi-reparto" auto-visibili come "(generico)".
- **Barra panoramica budget per reparto** (nuova): segmenti colorati, cliccabile, gestione sforamento budget.
- **Temperatura di mercato con FVM** (nuova): usa `prezzoPrevisto` se presente, altrimenti `custom.fvm` (FVM fantacalcio.it). Mix intelligente per previsione: con poche vendite mescola media mercato + FVM, con 4+ solo mercato reale.
- **Soglie temperatura configurabili**: ⚙️ Impostazioni asta → 🌡️ Soglie (default 1.15/0.85), validazione anti-valori assurdi, indicator "⚠️ ancora poco affidabile" con 2-3 vendite.
- **War Room refresh cieco rimosso**: `setInterval(2.5s)` che rirenderizzava Plancia/Acquisti rimosso; fix del vero bug: War Room non era inclusa in `handleRemoteChange`. Bug secondario: `const rec` dentro blocco `else` ma usato fuori (le finestre desktop non si aggiornavano mai in automatico).
- **Riordino sezioni scheda giocatore**: "Previsioni" e "Titolarità" ora subito dopo Anagrafica, prima delle statistiche storiche dettagliate.
- **Codice morto Piano Rosa legacy rimosso** (~250 righe, `prFormations`, `prSaveToSupabase`, MutationObserver + `setInterval(2000)`).

### Sessione luglio (Update-07-08 condensato)

Documentazione di passaggio: introduzione del concetto di tre tabelle con tre significati diversi di "squadra", conferma del modello dati completo (`players.data`, `teams.data`, `league_teams.data`, `roster_plans.data`), descrizione delle 5 fasce unificate, delle 8 fasce modificatore difesa, di tutti i kit applicati fino a quel punto, dei flussi di arricchimento A e B con LM Studio + Beledarian toolbox, della decisione di mantenere API-Football deprecato per eventuale futuro upgrade.

---

## Sessione recente — Piano Rosa v2

Funzionalità introdotte in questa sessione (post-Update-17-08).

### v2.0 — Riscrittura Piano (rimozione kit v20 monkey-patching)
- **Rimozione `archetipo`** dalla UI: campo ridondante (faceva da descrizione + pseudo-candidato). Migrazione automatica: se `archetipo` corrisponde a un nome giocatore, viene promosso a candidato libero.
- **Rimozione completa dei due IIFE kit v20** (CANDIDATI + RICERCA): ~570 righe di monkey-patching con MutationObserver + `setInterval(600ms)` rimosse. Sostituite con codice nativo in `wrRenderPiano`/`bindPianoEvents`.
- **Rimozione flag** `__v20candDone`, `__v20ricDone`, `__kitV20`, `__kitV20Applied`, `__v20chk`.
- **Funzioni migrate** (namespace `piano*`): `pianoFindPlayer`, `pianoFindPlayerById`, `pianoOpenPlayer`, `pianoAttachAutocomplete`, `pianoCountSearchMatches`, `pianoFindSearchMatches`, `pianoOpenSearchBuilder`, `pianoOpenSearchResults`, `pianoRefresh`.
- **Candidati liberi** riscritti: chip puliti con ✕, autocomplete con dropdown che mostra ruolo/squadra/fascia.
- **Ricerca per slot** spostata a icona 🔍 in cima ad ogni slot + chip blu che mostra criteri salvati + conteggio.
- **Confronto piani** aggiornato: mostra riepilogo `🔱 N · 🎯 N · ★ nomeForkAttivo` invece del vecchio archetipo.
- **Duplica piano** clona correttamente forks/ricerca (resetta `activeForkId` — utente decide se riattivarlo).
- **Badge Piano nella Rosa** aggiornato per gestire i fork attivi: bordo ambra per anchor, bordo verde per compatibili, badge 🔱 con nome fork + ruolo.

### v2.0 — Fork (scenari alternativi)
Per ogni slot del Piano, N fork. Ognuno:
- `nome` (testo libero)
- `anchors` (array di ID giocatori chiave alternativi "se prendo X oppure Y")
- `compatibili` (array di ID giocatori che ci stanno bene insieme)
- `note` (perché ci stanno bene)
- Toggle ◉/○ per attivarlo → nella tab Rosa, le ancore vengono evidenziate ambra + badge "ancora", i compatibili verde + badge "compatibile".

### v2.1 — Edit inline (no modale)
- **Nome fork** → `<input>` diretto, salva al blur o Enter.
- **Ancore** → chip ambra con ✕ per rimuovere + input sempre visibile "+ aggiungi ancora..." (autocomplete).
- **Compatibili** → chip blu con ✕ + input sempre visibile "+ aggiungi compatibile...".
- **Note** → `<textarea>` auto-resize, salva al blur.
- `pianoOpenForkEditor` (il vecchio modale) resta definito come dead-code fallback.

### v2.2 — Multi-anchor
- Modello dati: `fork.anchor` (singolo) → `fork.anchors` (array).
- Migrazione automatica: in `pianoGetSlot` ogni fork legacy con `anchor` viene promosso a `anchors: [anchor]` e il campo `anchor` viene cancellato.
- `checkPianoMatch` controlla l'array `anchors` (con fallback al vecchio `anchor` per fork non ancora migrati).
- `duplicatePlan` clona `anchors` e pulisce il campo legacy.

### v2.3 — Window WM minimizzabile "Piano"
- Pulsante 🪟 nell'header del Piano (desktop only, usa il WM esistente).
- `pianoOpenInWindow()`: crea una `WM.create({type:'piano'})` (~720×700, posizione basso-destra) con dentro `wrRenderPiano(container)`.
- Se già aperta → la porta in primo piano invece di duplicare.
- Trascinabile, ridimensionabile, minimizzabile (taskbar in basso).
- `pianoRefreshWindow` rirenderizza il contenuto quando arriva un update realtime su `roster_plans`.
- Subscription `roster_plans_rt` aggiornata per chiamare anche `pianoRefreshWindow` e refreshare il Piano nella War Room se visibile.

---

## Totale righe del file `index.html`

- Originale (pre-Piano v2): ~11.062 righe
- Dopo Piano v2.0 (rimozione kit v20): -570 righe
- Dopo Piano v2.1 + v2.2 + v2.3: ~12.000 righe (aggiunte CSS + funzioni `piano*` + bind)
