# Architettura — DossierFanta

Documento tecnico di riferimento: schema dati, modelli, meccanismi chiave, decisioni di design non-invertibili. Da leggere quando si deve toccare il codice.

Vedi anche: [`README.md`](./README.md) per overview + workflow, [`CHANGELOG.md`](./CHANGELOG.md) per storia.

---

## Schema Supabase (SQL da eseguire una volta)

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
create table creator_opinions (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);
create table player_videos (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);
create table calendario_serie_a (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);
create table roster_plans (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);

alter table players enable row level security;
alter table teams enable row level security;
alter table league_teams enable row level security;
alter table creator_opinions enable row level security;
alter table player_videos enable row level security;
alter table calendario_serie_a enable row level security;
alter table roster_plans enable row level security;

create policy "public access" on players for all using (true) with check (true);
create policy "public access" on teams for all using (true) with check (true);
create policy "public access" on league_teams for all using (true) with check (true);
create policy "public access" on creator_opinions for all using (true) with check (true);
create policy "public access" on player_videos for all using (true) with check (true);
create policy "public access" on calendario_serie_a for all using (true) with check (true);
create policy "public access" on roster_plans for all using (true) with check (true);

alter publication supabase_realtime add table players, teams, league_teams,
  creator_opinions, player_videos, calendario_serie_a, roster_plans;
```

---

## Tabelle — attenzione concettuale

**Tre tabelle, tre significati diversi di "squadra"**, da non confondere:

- `players` → giocatori del fantacalcio (persone).
- `teams` → **squadre reali di Serie A** (dossier tattici: baricentro, pressing, pericolosità offensiva, ecc. — non hanno budget/asta).
- `league_teams` → **squadre della LEGA del fantacalcio** (i partecipanti all'asta, inclusa "la propria"): budget, slot rosa, giocatori assegnati. Contiene anche una riga speciale con `id = '_settings'` che non è una squadra ma le impostazioni globali dell'asta (budget di default, slot per reparto, flag "Modalità Asta" ON/OFF).
- `roster_plans` → piani rosa per l'asta (slot pianificati con fascia, fork, candidati, ricerche).
- `creator_opinions`, `player_videos`, `calendario_serie_a` → estensioni opzionali, poco usate.

---

## Modello dati

### `players.data`

**Campi diretti (non in `custom`):**

```
nome, eta, squadra (testo libero con autocomplete su teams), posFanta (P/D/C/A)
posReale (testo libero con AUTOCOMPLETE sui ruoli già usati da altri giocatori dello stesso ruolo fanta)
spesaAnnoScorso, fmAnnoScorso, golAnnoScorso, assistAnnoScorso
xgAnnoScorso, tiriPartita, tocchiArea, noteAnnoScorso
percVotoSufficiente, percPartiteBonus, percVotoInsufficiente (affidabilità del voto)
ammonizioniAnnoScorso, espulsioniAnnoScorso, rigorista, autogolAnnoScorso (bonus/malus)
xaAnnoScorso, golPerTiri, passaggiChiave (rendimento avanzato)
mediaVotoUltime5, trendNote, rendimentoBigMatch (trend e forma)
fragilita (1-10), noteFisico, infortuniNumero, infortuniGiorniTotali, cambioSquadraGennaio, cambioAllenatoreNote, ruoliDiversiNote (fisico, infortuni, contesto)
titolaritaVoto (1-10), titolaritaNote
valutazioneSquadraNote
golPrevisti, prezzoPrevisto (testo/numero libero), noteVarie, priorita (0-5 stelle)
fascia (una delle 5 fasce unificate, vedi sotto)
trendPrevisto (select: forte_crescita / crescita / stabile / calo / forte_calo) — giudizio umano (Oracolo v16)
variazionePrevista (numero, es. +0.3 / -0.2) — aggiustamento manuale FM (Oracolo v16)
proiezione (oggetto {nota, twist, by, at}) — modale proiezione
tag: array di stringhe (UI dedicata chip + autocomplete)
custom: oggetto libero per campi personalizzati + campi interni arricchimento (apiFootballId, enrichStatus, enrichNote, fuoriSerieA, squadraFonte, fvm)
asta: null oppure {team, prezzo, assegnatoDa, assegnatoAt} — solo se assegnato
aiSummary: riassunto AI generato
aiRequest: stato coda async {status:'pending'|'error', ...}
updatedBy, updatedAt: chi/quando ha modificato
```

**Sezioni del form** (collassabili, `PLAYER_SECTIONS` in `index.html`):
Anagrafica → Previsioni (Fascia/Priorità/tetto/prezzo previsto/temperatura) → Titolarità → Statistiche storiche dettagliate (sotto-sezioni: ⚽ Produzione offensiva, 📊 Qualità del voto, 🏃 Continuità, 🟨 Disciplina, 🩺 Fisico, 🧭 Contesto e trend, 📝 Note) → Valutazioni sulla squadra. NON ripristinare la struttura originaria più granulare senza chiedere.

**Fasce (unificate, kit v4)**: 5 fasce UGUALI per tutti i ruoli (P, D, C, A): `Top, Semitop, Medio, Regolarista, Scommessa`. Definite in `FASCE_PER_RUOLO`. NON tornare alle fasce per-ruolo.

**Priorità (separata dalla fascia, kit v4)**: `priorita` è select 0-5 con stelle. NON derivarla dalla fascia. Le stelle in alto-destra della card mostrano la priorita; la fascia è mostrata come badge/pill.

**posReale**: autocomplete con datalist. NON è un campo select fisso.

**SCOUTING_FIELDS** (per badge completezza, soglia 60%): posReale, noteAnnoScorso, titolaritaVoto, titolaritaNote, valutazioneSquadraNote, golPrevisti, prezzoPrevisto, noteVarie, noteFisico, fragilita.

### `teams.data` (squadre reali Serie A — dossier tattici)

```
nome, baricentro (basso/medio/alto), offensivita (1-10), esterniAlti (no/si/a volte),
incentrataPunta (no/si/parzialmente), pressing (basso/medio/alto),
pericolosita (per abbinamenti portieri), fragilitaDifensiva (per abbinamenti attaccanti),
noteLibere, tag
```

### `league_teams.data` (squadre lega fantacalcio)

Riga normale:
```
nome, isMine (bool, una sola dovrebbe essere true), budgetTotale (opzionale, sovrascrive default)
```

Riga `_settings` (impostazioni globali asta):
```
budgetTotale (default, es. 500), slots ({P,D,C,A}, default 3/8/8/6), modalitaAsta (bool, condiviso),
sogliaCaldo, sogliaFreddo (soglie temperatura mercato, default 1.15/0.85)
```

### `roster_plans.data` (piani rosa)

```
name: nome del piano
reparto: 'P' | 'D' | 'C' | 'A' | null (null = piano "generico" storico multi-reparto)
slots: { P: [...], D: [...], C: [...], A: [...] }
```

**Struttura di un singolo slot** (`plan.slots[rep][idx]`):

```js
{
  fascia: "Top" | "Semitop" | "Medio" | "Regolarista" | "Scommessa" | "",
  budget: number,
  note: string,
  candidati: ["id1", "id2"],            // candidati liberi (osservati, non legati a fork)
  forks: [                               // scenari alternativi (Piano v2)
    {
      id: "fork_...",
      nome: "Bastoni + Dimarco (costruzione)",
      anchors: ["id_bastoni", "id_acerbi"],  // giocatori chiave alternativi "se prendo X oppure Y"
      compatibili: ["id_dimarco"],            // chi ci sta bene insieme
      note: "Costruzione bassa,lettura difensiva simile"
    }
  ],
  activeForkId: "fork_..." | null,        // id del fork attivo (evidenzia anchor+compatibili nella Rosa)
  ricerca: { posReali: [...], fasce: [...] } | null  // filtro salvato per slot
}
```

**Migrazione**: i fork legacy con campo singolo `anchor` (stringa) vengono automaticamente migrati a `anchors: [anchor]` in `pianoGetSlot`. Il campo `archetipo` legacy (vecchio testo libero) viene automaticamente promosso a candidato libero in `wrRenderPiano` se corrisponde a un nome giocatore.

---

## Piano Rosa v2 — dettaglio

### Render
`wrRenderPiano(sec)` renderizza il Piano. Per ogni slot:
- HEAD: badge slot, fascia (select), budget (input), pulsante 🔍 ricerca
- NOTE: textarea
- CHIP RICERCA (se salvata): mostra criteri + numero papabili, cliccabile → modale risultati
- SEZIONE FORK: lista fork + pulsante "+ Aggiungi fork"
- SEZIONE CANDIDATI LIBERI: chip + input add

### Render fork (`pianoRenderForkCard`)
- HEAD: input nome (editabile inline), badge "Attivo" se attivo, toggle ◉/○, pulsante 🗑
- "Se prendo": chip ambra per ogni `anchor` (con ✕ per rimuovere) + input sempre visibile "+ aggiungi ancora..." (autocomplete)
- "Insieme a lui": chip blu per ogni `compatibile` (con ✕) + input sempre visibile "+ aggiungi compatibile..." (autocomplete)
- Note: textarea editabile inline, auto-resize

### Funzioni JS principali (namespace `piano*`)
- `pianoGetSlot(rep, idx)` → `{plan, slot}` + normalizza fork legacy
- `pianoSaveSlot(plan, rep, idx)` → wrap di `savePlan`
- `pianoRefresh()` → re-render del Piano nella War Room + nella WM window se aperta
- `pianoFindPlayer(name)`, `pianoFindPlayerById(id)` → lookup
- `pianoAttachAutocomplete(inp, onPick)` → dropdown riusabile (lista player filtrata per nome)
- `pianoAddFork`, `pianoDeleteFork`, `pianoToggleFork(rep, idx, forkId)`
- `pianoAddAnchor`, `pianoRemoveAnchor` (multi-anchor)
- `pianoAddCompat`, `pianoRemoveCompat`
- `pianoAddCandidatoLibero`, `pianoRemoveCandidatoLibero`
- `pianoOpenSearchBuilder`, `pianoOpenSearchResults` (modali ricerca per slot)
- `pianoOpenInWindow`, `pianoRefreshWindow` → WM window minimizzabile

### `checkPianoMatch(player, plan)` — ordine di priorità
1. **Fork attivo**: se il giocatore è un'anchor o un compatibile del fork attivo dello slot del proprio reparto → match forte (`forkActive: true`, `forkRole: 'anchor' | 'compat'`).
2. **Candidati liberi** + **anchor di fork non attivi**: match debole come candidato (`candidato: true`, opzionalmente `forkAnchor: true`).
3. **Match fascia**: comportamento originale.

Il rendering del badge Piano nella Rosa (`renderPlayerCard`):
- `forkActive + forkRole='anchor'` → bordo ambra + badge "🔱 nome · ancora"
- `forkActive + forkRole='compat'` → bordo verde + badge "🔱 nome · compatibile"
- match semplice → bordo ambra + badge "🎯 reparto slot N · max X cr"

### Window Manager — finestra "Piano"
Pulsante 🪟 nell'header del Piano (visibile solo desktop). `pianoOpenInWindow`:
- Crea una `WM.create({type:'piano'})` (~720×700, posizione basso-destra)
- Renderizza `wrRenderPiano(container)` dentro il body
- Se già aperta → la porta in primo piano invece di duplicare
- `pianoRefreshWindow` rirenderizza il contenuto quando arriva un update realtime

### Realtime
Subscription `roster_plans_rt` su `roster_plans` → `loadRosterPlans()` → poi:
- `pianoRefreshWindow()` aggiorna la WM window se aperta
- `wrRenderPiano(sec)` aggiorna il Piano nella War Room se visibile

### Salvataggio "a fusione" (kit v17 + Update-17-08)
`savePlan(plan, touchedRep, touchedIdx)`:
1. Rilegge il dato più fresco dal server.
2. Aggiorna SOLO lo slot `touchedRep[touchedIdx]` (o i campi top-level se non è uno slot touchato).
3. Mantiene tutti gli altri slot come sono sul server (più freschi).
Così due persone che toccano slot diversi dello stesso piano, anche nello stesso reparto, non si cancellano a vicenda.

`computeChangedFields(baseline, current)` + `mergeSaveRow(table, id, changedFields)`: stessa logica applicata a editor giocatore/squadra/lavagna/assegnazione/riassunto AI/proiezioni/impostazioni lega. La baseline avanza solo sui campi realmente modificati dall'utente, non su tutto il record.

---

## Oracolo (proiezioni FM)

Per ogni giocatore con `fmAnnoScorso`: proiezione FM prossima stagione.

**Euristica automatica** (fallback, marcate "🤖 ipotesi automatica"):
- Forma recente (`mediaVotoUltime5`)
- Rendimento vs xG (`golAnnoScorso` vs `xgAnnoScorso`), peso ridotto se presenze < 20
- Curva età (separata per P, più tollerante)
- Titolarità (`titolaritaVoto`)
- Fragilità
- Gol previsti vs scorsi
- Contesto offensivo squadra (offensivita) per A/C, contesto difensivo (fragilitaDifensiva) per P/D
- Presenze stagionali (`presenzeAnnoScorso`, kit Update-17-08)

**Giudizio umano PRIORITARIO** (kit v16): se l'utente imposta `trendPrevisto` (select) o `variazionePrevista` (numero), questi hanno priorità assoluta sull'euristica. Modale proiezione mostra chiaramente la fonte.

**Verdetto**: ▲▲/▲/＝/▼/▼▼ con delta.

**Fasce modificatore difesa** (`DF_MOD_DIFESA_FASCE`, kit v15): 8 scaglioni reali della lega:
| Media difesa | Bonus |
|---|---|
| < 6 | 0 |
| ≥ 6 e < 6.25 | +1 |
| ≥ 6.25 e < 6.5 | +2 |
| ≥ 6.5 e < 6.75 | +3 |
| ≥ 6.75 e < 7 | +4 |
| ≥ 7 e < 7.25 | +5 |
| ≥ 7.25 e < 7.5 | +5 |
| ≥ 7.5 | +6 |

**NON cambiarle senza conferma esplicita** — sono le regole reali della lega dell'utente.

---

## AI Riassunti

**Tre modalità** (⚙️ AI, impostazioni locali al dispositivo, MAI sincronizzate — la chiave non va condivisa):
1. **OpenRouter** (cloud): chiave API + nome modello (gratis con suffisso `:free`).
2. **LM Studio** (locale): URL default `http://localhost:1234/v1`, CORS abilitato nelle impostazioni del server LM Studio.
3. **Ollama** (locale/cloud): URL default `http://localhost:11434/v1`.

**Tre azioni per giocatore**:
- ✨ Genera ora (sincrono nella modalità attiva)
- 🕒 Richiedi async (solo LM Studio): mette in coda (`aiRequest.status = 'pending'`), worker `lmstudio_worker.py` da lanciare a mano per smaltire
- 🚨 Emergenza OpenRouter: bypassa modalità corrente, forza chiamata immediata (visibile solo se chiave configurata)

**Prompt di sistema** (`AI_SYSTEM_PROMPT` in `index.html`, replicato in `lmstudio_worker.py`):
- Solo parole chiave/punti brevissimi (max 6-8 parole)
- Mai inventare
- Output JSON puro: `{ keywords, punti_giocatore, punti_squadra, flag_rischio }`
- Parser toglie automaticamente i blocchi `<think>...</think>` (compatibilità modelli "thinking" tipo Qwen3)

**Staleness**: banner giallo se note modificate dopo ultimo riassunto (hash salvato in `aiSummary.sourceHash`).

---

## Arricchimento automatico

**Tentativo 1 (fallito): API-Football gratuito.** Bloccato strutturalmente: piano gratuito copre solo stagioni 2022-2024. Endpoint rifiuta stagione corrente con `"Free plans do not have access to this season, try from 2022 to 2024"`. File `daily_enrichment.py` + workflow GitHub Actions **deprecati**. Da considerare solo se si paga $19/mese per Pro.

**Soluzione adottata: ibrida, locale, gratuita, con ricerca web reale.**

Stack: LM Studio + **Beledarian's LM Studio Toolbox** (plugin installabile dal LM Studio Hub: tool `web_search` DuckDuckGo, `read_file`/`save_file`, `fetch_web_content`, navigazione browser) + modello **Gemma 4** (confermato compatibile col tool-calling). L'utente ha GTX 3050 4GB + 16GB RAM.

Non è un'automazione silenziosa in background: l'utente apre LM Studio quando vuole, il modello cerca online e scrive un file di output, poi un piccolo script Python locale applica il risultato su Supabase.

**Due flussi paralleli, volutamente separati** (per non sovraccaricare un modello locale piccolo con un compito troppo lungo):

### Flusso A — arricchimento campi mancanti (squadra/gol/assist)
1. `export_missing_fields.py` (locale, solo Supabase) → crea `players_todo.json` (max 40 per batch).
2. Copia il file nella workspace del plugin Beledarian.
3. In LM Studio: chat con Gemma 4 + toolbox attivo, incolla `prompt_arricchimento.txt` (già pronto: vieta di inventare, impone data corrente per dare priorità a notizie recenti, chiede output `players_result.json` con `id` preservato).
4. Importa `players_result.json` con il pulsante ⬆️ dell'app (upsert su id).

### Flusso B — sincronizzazione rosa completa (nuovi + fuori Serie A)
1. `export_full_roster_context.py` → crea `current_roster.json` (id, nome, squadra di tutti i giocatori NON già segnalati fuori Serie A).
2. Prompt `prompt_sincronizzazione_rosa.txt`: il modello trova le 20 squadre attuali di Serie A (senza usare memoria, perché potrebbe essere superato da promozioni/retrocessioni), apre Wikipedia delle rose, confronta con `current_roster.json`, scrive in modo **incrementale** (salva dopo ogni squadra) `roster_sync_result.json` con due liste: `nuovi_giocatori` e `da_verificare_fuori_serie_a` (solo id).
3. `apply_roster_sync.py` (locale) applica in **scrittura sicura**: crea i nuovi giocatori normalmente, ma per "fuori Serie A" fa read-modify-write che aggiunge SOLO `custom.fuoriSerieA = true` senza toccare altri campi (NON usa l'import generico dell'app, che sovrascriverebbe l'intero `data`).

**Ordine se si fanno entrambi**: prima B (sincro rosa, così i nuovi giocatori esistono), poi A (arricchimento, include i nuovi).

**Regola di sicurezza trasversale**: mai sovrascrivere campi già compilati. **ECCEZIONE** per `squadra`: se l'ha scritta l'automatismo stesso l'ultima volta (`updatedBy` contiene `"auto-enrichment"`), viene ricontrollata ad ogni esecuzione contro trasferimenti/rose più recenti (utile durante calciomercato); se l'ha scritta un umano, resta protetta per sempre.

**Nessuna eliminazione automatica in nessun caso**: la cancellazione vera resta sempre manuale dal pulsante 🌍 nell'app, con conferma e avviso se il giocatore ha già note scritte.

---

## Window Manager (desktop ≥1024px)

- Editor come finestre mobili (`WM.create`): drag dalla chrome, resize dall'angolo, minimize (—), maximize (doppio click chrome o snap ai bordi).
- Taskbar in basso con una voce per finestra.
- `Alt+W` cicla tra le finestre aperte.
- Snap: trascina verso bordo sinistro/destra → metà schermo; verso sopra → massimizza.
- Su mobile (<1024px): modal classici.
- Tipi di finestra noti: `player` (editor giocatore), `team` (editor squadra), `piano` (finestra Piano Rosa v2).

---

## ⚠️ Decisioni di design NON-invertibili senza chiedere esplicitamente

Queste decisioni sono state prese in passato e **non vanno invertite senza conferma esplicita dell'utente**:

1. **Niente cancellazioni automatiche di giocatori, mai** — solo flag + conferma manuale.
2. **Chiave OpenRouter/impostazioni AI personali per dispositivo**, mai sincronizzate su Supabase condiviso.
3. **Campo `squadra` del giocatore**: va lasciato inserire all'utente / agli script di arricchimento. Non fa parte dell'import "essenziale" originario.
4. **Sezioni del form giocatore già consolidate** (vedi sopra): non ri-frammentare.
5. **Pulsante creazione singolo giocatore**: volutamente nascosto dentro il modale di importazione, non un FAB prominente ("ormai li avremo quasi tutti").
6. **"Modalità Asta" (tab Asta)** nasconde gli strumenti di assegnazione quando OFF. È uno stato condiviso tra i due utenti, non locale.
7. **Import in blocco (⬆️) fa upsert che sovrascrive l'intero `data` per l'id dato** — mai usarlo per aggiornamenti parziali/flag. Per aggiornamenti parziali sicuri, sempre pattern read-modify-write come negli script Python.
8. **Fasce giocatori unificate a 5** per tutti i ruoli (Top/Semitop/Medio/Regolarista/Scommessa). NON tornare alle fasce per-ruolo.
9. **Priorità campo manuale SEPARATO dalla fascia**. NON derivarla dalla fascia.
10. **posReale autocomplete con datalist**. NON è un campo select fisso.
11. **Tema visivo: Dossier Design System** (font Archivo/JetBrains Mono, scuro verde-campo/ambra). NON tornare al tema piatto precedente.
12. **Fasce modificatore difesa: 8 scaglioni reali della lega** (0/1/2/3/4/5/5/6). NON cambiarle senza conferma.
13. **Oracolo: il giudizio umano** (`trendPrevisto`/`variazionePrevista`) **ha PRIORITÀ sull'euristica automatica**. NON invertire questa priorità.
14. **Piano Rosa: il budget è FLESSIBILE** (si può sforare). NON renderlo rigido.
15. **Piano Rosa: multi-piano supportato**. NON limitare a un solo piano.
16. **Piano Rosa: niente stelle di priorità sugli slot** (l'utente ha detto esplicitamente di no).
17. **Piano Rosa è dentro la War Room come sotto-sezione**, NON è una tab separata.
18. **Ricerca per slot: i candidati sono salvati come ID giocatore**, NON come nomi.
19. **Fork (Piano v2): anchor multipli** (`anchors: array`). NON tornare al singolo `anchor: string`.
20. **Fork edit inline (Piano v2.1)**: nome/anchor/compatibili/note modificabili direttamente sulla card, senza aprire modale. Il vecchio `pianoOpenForkEditor` è dead-code lasciato come fallback.
