# DossierFanta — Recap completo del progetto

Documento di passaggio: incollalo (o allega il file) all'inizio di una nuova
conversazione Claude per ripartire senza perdere contesto.

## Cos'è

Web-app per la preparazione dell'asta del fantacalcio, condivisa in tempo
reale tra due persone (l'utente e il suo compagno di lega). Gira come sito
statico (pensato per hosting su Netlify), con Supabase come backend
condiviso. Nessun account/login: la condivisione avviene tramite lo stesso
URL/file e le stesse credenziali Supabase incorporate nel codice.

Nome interno: **DossierFanta**.

---

## Stack tecnico

- **Frontend**: un unico file HTML (`dossier-fanta.html`, salvato localmente
  come `index.html` per il deploy) — vanilla JS, nessun framework, CSS
  scritto a mano (tema scuro verde-campo/ambra).
- **Backend dati**: **Supabase** (Postgres + REST + Realtime).
  - URL progetto: `https://ubiilhfedzodyyxrwbdq.supabase.co`
  - Chiave usata nel client (anon/publishable key, pensata per stare nel
    codice pubblico): `sb_publishable_rMIEJrNJ9rwBNn0T650WBQ_Q45iRMRg`
  - Tutte le tabelle hanno RLS abilitato con policy "public access" (lettura
    e scrittura aperte a chiunque abbia la chiave) — va bene per uso privato
    tra due persone, da rivedere se l'app viene condivisa più ampiamente.
  - Client JS caricato da CDN: `@supabase/supabase-js@2` (jsDelivr).
- **Sync in tempo reale**: Supabase Realtime (`postgres_changes`) su tutte
  le tabelle: se una persona modifica qualcosa, l'altra lo vede aggiornarsi
  da solo, senza refresh.
- **Autosave**: nei form di modifica, niente pulsante "salva" — autosave
  con debounce ~1.2s dopo l'ultima modifica.
- **PWA**: installabile come app (manifest.json + icone), utile per tenerla
  aperta in una finestra separata durante l'asta.

### Schema Supabase (SQL da eseguire una volta nel progetto)

```sql
create table players (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);
create table teams (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);
create table league_teams (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);
alter table players enable row level security;
alter table teams enable row level security;
alter table league_teams enable row level security;
create policy "public access" on players for all using (true) with check (true);
create policy "public access" on teams for all using (true) with check (true);
create policy "public access" on league_teams for all using (true) with check (true);
alter publication supabase_realtime add table players, teams, league_teams;
```

**Attenzione concettuale importante**: tre tabelle, tre significati diversi
di "squadra", da non confondere:
- `players` → giocatori del fantacalcio (persone).
- `teams` → **squadre reali di Serie A** (dossier tattici: baricentro,
  pressing, ecc. — non hanno budget/asta).
- `league_teams` → **squadre della LEGA del fantacalcio** (i partecipanti
  all'asta, inclusa "la propria"): budget, slot rosa, giocatori assegnati.
  Contiene anche una riga speciale con `id = '_settings'` che non è una
  squadra ma le impostazioni globali dell'asta (budget di default, slot per
  reparto, flag "Modalità Asta" ON/OFF).

---

## Modello dati

### `players.data` (per ogni giocatore)

Campi diretti (non in `custom`):
- `nome`, `eta`, `squadra` (nome squadra reale, testo libero con
  autocompletamento sulle squadre presenti in `teams`), `posFanta` (P/D/C/A)
- `posReale` (posizione reale nella squadra, testo libero)
- `spesaAnnoScorso`, `fmAnnoScorso`, `golAnnoScorso`, `assistAnnoScorso`,
  `xgAnnoScorso`, `tiriPartita`, `tocchiArea`, `noteAnnoScorso`
- `fragilita` (1-10), `noteFisico`
- `titolaritaVoto` (1-10), `titolaritaNote`
- `valutazioneSquadraNote` (note sul contesto squadra per quel giocatore)
- `golPrevisti`, `prezzoPrevisto` (testo libero), `noteVarie`, `priorita` (0-5)
- `tag`: array di stringhe, gestito con UI dedicata (chip + autocomplete),
  NON è più un campo di testo semplice
- `custom`: oggetto libero per campi personalizzati aggiunti dall'utente
  dall'editor, PIÙ campi usati internamente dagli script di arricchimento
  (vedi sotto: `apiFootballId`, `enrichStatus`, `enrichNote`, `fuoriSerieA`,
  `squadraFonte`)
- `asta`: `null` oppure `{team, prezzo, assegnatoDa, assegnatoAt}` — presente
  solo se il giocatore è stato assegnato durante l'asta
- `aiSummary`: riassunto AI generato (vedi sezione dedicata più sotto)
- `aiRequest`: stato coda riassunto async (`{status:'pending'|'error', ...}`)
- `updatedBy`, `updatedAt`: chi/quando ha modificato l'ultima volta (nome
  utente, oppure stringhe tipo `"auto-enrichment (...)"` quando a scrivere
  è stato uno script automatico — usato per distinguere modifiche umane da
  automatiche, vedi sezione arricchimento)

Sezioni del form nell'app (collassabili, `PLAYER_SECTIONS` in `index.html`):
Anagrafica → Storico e statistiche anno scorso → Fisico → Titolarità →
Valutazioni sulla squadra → Previsioni, note e meta. (Sono state unite più
volte su richiesta esplicita dell'utente: NON ripristinare la struttura
originaria più granulare senza chiedere.)

### `teams.data` (squadre reali di Serie A — dossier tattici)

`nome`, `baricentro` (basso/medio/alto), `offensivita` (1-10), `esterniAlti`
(no/si/a volte), `incentrataPunta` (no/si/parzialmente), `pressing`
(basso/medio/alto), `noteLibere`.

### `league_teams.data` (squadre della lega fantacalcio)

Riga normale: `nome`, `isMine` (bool, una sola squadra dovrebbe averlo a
true), `budgetTotale` (opzionale, sovrascrive il default).
Riga `_settings`: `budgetTotale` (default globale, es. 500), `slots`
(`{P,D,C,A}`, default 3/8/8/6), `modalitaAsta` (bool, condiviso).

---

## Funzionalità dell'app (tab per tab)

### Tab "Rosa"
- Ricerca **full-text** su tutti i campi testuali + tag + campi
  personalizzati + contenuto del riassunto AI (non solo nome/squadra).
- Filtro per ruolo (P/D/C/A).
- Filtro **completezza scouting**: ✅ Completo / ⚠️ Incompleto, calcolato
  su 10 campi "di lavoro" (`SCOUTING_FIELDS` in index.html: posReale,
  noteAnnoScorso, titolaritaVoto, titolaritaNote, valutazioneSquadraNote,
  golPrevisti, prezzoPrevisto, noteVarie, noteFisico, fragilita) — soglia
  60% di campi compilati per essere "completo". Badge percentuale su ogni
  card.
- Barra tag cliccabili (con conteggio) per filtrare per tag.
- Ogni card mostra: badge ruolo, nome, link alla squadra reale (se esiste
  un dossier), stelle priorità, badge completezza scouting, statistiche
  chiave, tag, badge asta (se assegnato, colore diverso se è la propria
  squadra), badge "🌍 Fuori Serie A" (se segnalato), chi/quando ha
  aggiornato per ultimo.
- Azioni per card: Apri/modifica, +Confronta, 🏷️ Assegna (solo se
  "Modalità Asta" è attiva, oppure sempre visibile se già assegnato),
  Elimina.

### Tab "Squadre" (dossier tattici squadre reali)
- Pulsante dedicato "+ Nuova squadra" in cima.
- Card con stile di gioco + conteggio giocatori collegati (cliccabile,
  filtra la Rosa per quella squadra).

### Tab "Confronto"
- Selezione fino a 3 giocatori (pillole).
- Tabella con **righe = campi, colonne = giocatori** (non più schede
  affiancate), raggruppata in sezioni collassabili (stesse sezioni del
  form). Sezione dedicata "Riassunto AI": mostra il riassunto per default,
  con un link "mostra note originali" per vedere il testo grezzo invece
  del riassunto (toggle unico per tutte le colonne).

### Tab "Asta"
- **Toggle "Modalità Asta" ON/OFF** (condiviso tra utenti). Quando OFF,
  nasconde: pulsante ⚡ fluttuante, pallino di stato budget, pulsanti
  "Assegna giocatore"/"Modalità rapida", bottone "Assegna" sulle card (a
  meno che il giocatore non sia già assegnato). Pensato per non intasare
  l'interfaccia fuori dai giorni d'asta veri e propri.
- ⚙️ Impostazioni asta: budget di default, slot per reparto, gestione
  squadre della lega (aggiungi/elimina, marca "è la mia").
- Panoramica squadre: card con budget speso/rimasto (barra colorata) e
  slot riempiti per reparto.
- Tap su una squadra → dettaglio roster **slot per slot per reparto**
  (giocatore + prezzo, o "-- slot vuoto --"), con possibilità di rimuovere
  un'assegnazione.
- **Modalità Rapida (⚡)**: pannello **fluttuante globale** (non chiuso
  dentro la tab Asta — accessibile da qualunque schermata tramite il
  pulsante ⚡ in basso a sinistra o dal pallino di stato in alto a destra).
  Contiene: pillole squadre (con scorciatoia numerica), campo prezzo,
  ricerca giocatore con **assegnazione istantanea al tap** (nessuna
  conferma). Aggiornamenti **ottimistici** (l'interfaccia reagisce subito,
  il salvataggio Supabase avviene dopo in background, con rollback se
  fallisce).
  - Scorciatoie da tastiera (utili da PC): **Alt+1..9** cambia squadra
    attiva anche da dentro il campo di ricerca; **frecce ↑↓** navigano i
    risultati filtrati; **Invio** assegna il risultato evidenziato (o
    l'unico risultato se ce n'è uno solo); **Esc** pulisce la ricerca;
    **Ctrl/Cmd+Z** annulla l'ultima assegnazione (mostra anche un link
    "annulla" sempre visibile per l'ultima azione).
- **Pallino di stato fisso** (in alto a destra, visibile su tutte le tab
  quando la Modalità Asta è ON): budget rimasto + slot riempiti della
  propria squadra, tap per aprire la Modalità Rapida.

### Altro
- **⬆️ Importazione in blocco**: incolla JSON o carica un file `.json`
  (per import di centinaia di record, es. il listone iniziale). Supporta
  sia giocatori che squadre reali. In fondo al modale: link discreto
  "+ aggiungi un solo giocatore a mano" (creazione singola spostata qui,
  non più un pulsante FAB prominente — richiesta esplicita dell'utente
  perché "ormai li avremo quasi tutti" grazie alla sincronizzazione rosa).
- **🌍 Pulizia "Fuori Serie A"**: elenco dei giocatori segnalati (vedi
  sezione arricchimento), con checkbox (preselezionati) e avviso se un
  giocatore ha già note scritte sopra. Eliminazione **sempre manuale con
  conferma esplicita** — nessuno script cancella mai automaticamente un
  giocatore, solo lo segnala.
- **⚙️ AI**: impostazioni riassunto AI (vedi sotto).
- **👤**: nome utente (locale al dispositivo, per firmare le note/azioni).

---

## Riassunti AI per giocatore

Per ogni giocatore, tendina "Riassunto AI" (chiusa di default nel form
singolo giocatore) che estrae parole chiave + punti salienti da tutte le
note scritte (non riscrive le note, le condensa).

**Due modalità**, configurabili in ⚙️ AI (impostazioni **locali al
dispositivo**, mai sincronizzate — la chiave API non va condivisa):
1. **OpenRouter** (cloud): richiede una chiave API OpenRouter (gratis,
   modelli con suffisso `:free`) + nome modello.
2. **LM Studio** (locale): richiede che LM Studio sia acceso sullo stesso
   PC da cui si usa il sito (URL di default `http://localhost:1234/v1`),
   CORS abilitato nelle impostazioni del server LM Studio.

**Tre azioni disponibili per ogni giocatore**:
- ✨ Genera ora (sincrono, nella modalità attiva).
- 🕒 Richiedi async (solo se modalità = LM Studio): mette il giocatore "in
  coda" (`aiRequest.status = 'pending'`) senza chiamare nulla — utile da
  telefono. Un worker separato sul PC (`lmstudio_worker.py`) va lanciato a
  mano quando si vuole processare la coda: legge Supabase, chiama LM
  Studio in locale, scrive il risultato indietro. Se l'app è aperta con
  quel giocatore in modifica, il risultato appare in tempo reale.
- 🚨 Emergenza OpenRouter: bypassa la modalità corrente e forza una
  chiamata OpenRouter immediata (visibile solo se la chiave è configurata).

Il parser (sia lato browser che nel worker Python) **toglie automaticamente
i blocchi `<think>...</think>`** prima di interpretare il JSON, per
compatibilità con modelli "thinking" tipo Qwen3.

Prompt di sistema (usato sia da OpenRouter che da LM Studio) impone: solo
parole chiave/punti brevissimi (max 6-8 parole), mai inventare, output
JSON puro con `keywords`, `punti_giocatore`, `punti_squadra`,
`flag_rischio`. Il testo esatto è dentro `AI_SYSTEM_PROMPT` in
`index.html` e replicato in `lmstudio_worker.py`.

Un banner giallo avvisa se le note sono state modificate dopo l'ultimo
riassunto generato (confronto tramite hash salvato in `aiSummary.sourceHash`).

---

## Arricchimento automatico dei dati — STORIA IMPORTANTE

**Tentativo 1 (fallito): API-Football gratuito.** Avevo costruito
`daily_enrichment.py` + workflow GitHub Actions (`.github/workflows/daily-enrichment.yml`)
per cercare automaticamente ogni giorno squadra/gol/assist mancanti via
API-Football, con sincronizzazione dell'intera rosa Serie A. **Non
funziona**: il piano gratuito di API-Football copre SOLO le stagioni
2022-2024, bloccato strutturalmente (non è un problema di configurazione,
league_id o season sbagliati — l'endpoint stesso rifiuta qualunque
richiesta sulla stagione corrente con errore esplicito
`"Free plans do not have access to this season, try from 2022 to 2024"`).
Questi due file **restano nel progetto ma sono da considerarsi non
funzionanti/deprecati** a meno che l'utente non decida di pagare
$19/mese per API-Football Pro (opzione discussa ma non scelta).

**Soluzione adottata: ibrida, locale, gratuita, con ricerca web reale.**
L'utente ha una GTX 3050 4GB + 16GB RAM e usa **LM Studio** con
**Beledarian's LM Studio Toolbox** (plugin reale, installabile dal LM
Studio Hub: dà al modello locale strumenti `web_search` (DuckDuckGo),
`read_file`/`save_file`, `fetch_web_content`, navigazione browser, ecc.)
e il modello **Gemma 4** (confermato compatibile col tool-calling del
plugin). Non è un'automazione silenziosa in background: l'utente apre LM
Studio quando vuole, il modello cerca online e scrive un file di output,
poi un piccolo script Python locale applica il risultato su Supabase.

Due flussi paralleli, **volutamente separati** (compiti diversi, per non
sovraccaricare un modello locale piccolo con un compito troppo lungo):

### Flusso A — arricchimento campi mancanti (squadra/gol/assist)
1. `export_missing_fields.py` (locale, solo Supabase, nessuna API a
   pagamento) → crea `players_todo.json` (max 40 giocatori a batch, quelli
   con `squadra`/`golAnnoScorso`/`assistAnnoScorso` mancanti).
2. Copiare il file nella workspace del plugin Beledarian.
3. In LM Studio, chat con Gemma 4 + toolbox attivo, incollare il prompt
   `prompt_arricchimento.txt` (già scritto, pronto all'uso: vieta di
   inventare dati, impone data corrente 14 luglio 2026 per dare priorità
   a notizie recenti, chiede output `players_result.json` con `id`
   preservato per matchare i record giusti).
4. Importare `players_result.json` con il pulsante ⬆️ già esistente
   nell'app (nessun nuovo codice necessario per questo passo: l'upsert
   basato su `id` aggiorna i record corretti).

### Flusso B — sincronizzazione rosa completa (nuovi giocatori + fuori Serie A)
1. `export_full_roster_context.py` → crea `current_roster.json` (id, nome,
   squadra di tutti i giocatori NON già segnalati fuori Serie A).
2. Prompt `prompt_sincronizzazione_rosa.txt`: il modello trova le 20
   squadre attuali di Serie A (senza usare un elenco a memoria, che
   potrebbe essere superato da promozioni/retrocessioni), apre le pagine
   Wikipedia delle rose (fonte gratuita scelta come compromesso
   affidabilità/costo), confronta con `current_roster.json`, e scrive
   **in modo incrementale** (salva dopo ogni squadra controllata, per non
   perdere lavoro se il modello si blocca a metà — un compito da 20
   squadre può richiedere più sessioni) `roster_sync_result.json` con due
   liste: `nuovi_giocatori` e `da_verificare_fuori_serie_a` (solo id).
3. `apply_roster_sync.py` (locale) applica i risultati in **scrittura
   sicura**: crea i nuovi giocatori normalmente, ma per "fuori Serie A"
   fa un **read-modify-write** che aggiunge SOLO il flag
   `custom.fuoriSerieA = true` senza toccare nessun altro campo — non usa
   l'importazione generica dell'app apposta, perché quella sovrascrive
   l'intero oggetto `data` e cancellerebbe le note esistenti.
   **Nessuna eliminazione automatica in nessun caso**: la cancellazione
   vera resta sempre manuale dal pulsante 🌍 nell'app, con conferma e
   avviso se un giocatore ha già note scritte sopra.

**Ordine consigliato se si fanno entrambi i flussi**: prima B (sincro
rosa, così i nuovi giocatori esistono), poi A (arricchimento, che a quel
punto include anche i nuovi appena aggiunti).

**Regola di sicurezza trasversale a tutti gli script di arricchimento**:
non sovrascrivono mai un campo già compilato — ECCEZIONE intenzionale per
`squadra`: se l'ha scritta l'automatismo stesso l'ultima volta
(`updatedBy` contiene `"auto-enrichment"`), viene ricontrollata ad ogni
esecuzione contro trasferimenti/rose più recenti (utile durante il
calciomercato); se l'ha scritta un umano a mano, resta protetta per
sempre.

---

## Elenco completo dei file consegnati

| File | Cosa fa |
|---|---|
| `dossier-fanta.html` (deploy come `index.html`) | L'app intera. Da caricare su Netlify insieme a manifest.json e le due icone. |
| `manifest.json`, `icon-192.png`, `icon-512.png` | PWA — rendono l'app installabile come finestra separata. |
| `import_giocatori_listone_2026.json` | Import iniziale one-off del listone ufficiale (663 giocatori, campi essenziali: nome, posFanta, eta, fmAnnoScorso, spesaAnnoScorso). Già usato, tenerlo solo come riferimento storico. |
| `lmstudio_worker.py` | Worker che processa la coda di riassunti AI async (`aiRequest.status='pending'`) chiamando LM Studio in locale. Da lanciare a mano quando si vuole smaltire la coda. |
| `daily_enrichment.py` | **Deprecato/non funzionante**: arricchimento via API-Football, bloccato dal piano gratuito (solo stagioni 2022-2024). Tenuto per eventuale futuro upgrade a piano a pagamento. |
| `.github/workflows/daily-enrichment.yml` | Workflow GitHub Actions collegato a `daily_enrichment.py` — stesso stato: inutilizzabile finché non si paga un piano API-Football superiore. |
| `export_missing_fields.py` | Flusso A, step 1: esporta giocatori con buchi (squadra/gol/assist) per l'agente LM Studio. |
| `prompt_arricchimento.txt` | Flusso A, step 2: prompt pronto da incollare in LM Studio (Gemma 4 + Beledarian toolbox). |
| `export_full_roster_context.py` | Flusso B, step 1: esporta la rosa attuale come riferimento per il confronto. |
| `prompt_sincronizzazione_rosa.txt` | Flusso B, step 2: prompt per trovare nuovi giocatori e segnalare chi non è più in Serie A. |
| `apply_roster_sync.py` | Flusso B, step 3: applica i risultati in scrittura sicura (mai sovrascrive, mai cancella). |
| `RECAP_PROGETTO.md` | Questo file. |

---

## Decisioni di design da NON invertire senza che l'utente lo chieda esplicitamente

- Niente cancellazioni automatiche di giocatori, mai — solo flag + conferma manuale.
- La chiave OpenRouter/impostazioni AI sono personali per dispositivo, mai sincronizzate su Supabase condiviso.
- Il campo `squadra` del giocatore va lasciato inserire all'utente / agli script di arricchimento — non fa parte dell'import "essenziale" originario (l'utente l'aveva esplicitamente escluso da un import iniziale).
- Sezioni del form giocatore: già consolidate su richiesta esplicita (vedi sopra), non extra-frammentare.
- Pulsante creazione singolo giocatore: volutamente nascosto dentro il modale di importazione, non un FAB prominente.
- "Modalità Asta" (tab Asta) nasconde gli strumenti di assegnazione quando OFF — è uno stato condiviso tra i due utenti, non locale.
- Import in blocco (⬆️) fa un **upsert che sovrascrive l'intero oggetto `data`** per l'id dato — mai usarlo per aggiornamenti parziali/flag, solo per creazione o sostituzione completa di un record. Per aggiornamenti parziali sicuri, sempre pattern read-modify-write come negli script Python.

---

## Prossimi passi aperti / idee non ancora implementate

- Nessuna richiesta pendente al momento di scrivere questo recap.
- Possibile idea futura scartata/in sospeso: unire i due flussi di
  arricchimento (A e B) in un unico prompt — l'utente ha detto di
  preferirli separati per ora.
