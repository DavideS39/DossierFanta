
# Changelog

Tutti i cambiamenti notevoli di DossierFanta v2.2 vengono documentati qui.
Il formato segue [Keep a Changelog](https://keepachangelog.com/it/1.1.0/),
e il progetto adotta [Semantic Versioning](https://semver.org/lang/it/).

---

## [Unreleased]

### Added
- `.github/workflows/ci.yml` — CI su push/PR: cargo check + test + tsc + vite build
- `.github/workflows/build.yml` — Build manuale + post-push: bundle per Windows (.msi/.exe), Linux (.deb/.AppImage), macOS (.dmg/.app)
- `.github/workflows/release.yml` — Crea GitHub Release su tag `v*` con asset auto-generati

### Changed
- `.gitignore`: rimosso `src-tauri/Cargo.lock` — per le app binarie Tauri il lockfile VA committato per riproducibilità build CI

---

## [0.2.4] — 2026-10-11 — Restyling grafico fotografico (design doc v2.3, Cap.16)

### Added
- `src/assets/paper/` — 5 texture carta fotografiche fornite dal product owner,
  normalizzate in WebP RGBA (~180 KB totali) da `scripts/preprocess_paper.py`:
  crop sul bounding-box alpha, banda postcard 1.50-1.75 senza stretch, safe-area
  misurate analiticamente (fori, strappi, margine rosa, angolo piegato) in
  `paper-meta.json` + `src/assets/paper/index.ts`
- `src/styles/scrivania.css` — layer UI v2.3.2: cartoline strappate reali (bordo
  = alpha della foto, ombre 3-layer Cap.16 come drop-shadow sull'alpha),
  scrivania con vignettatura, masthead-copertina ink con cartellino DF e nastro,
  striscia stats con progress scouting, toolbar a chip stile timbro, empty state
  su bigliettino strappato, toast cartaceo
- `src/api/mock.ts` — backend in-memory per ANTEPRIMA WEB dev-only: fuori da
  Tauri (`npm run dev`) l'app gira nel browser con dati dimostrativi (badge
  "anteprima web · mock"); dentro il binario desktop il gate `isDesktop` in
  `tauri.ts` usa solo i comandi Rust
- `scripts/shoot.mjs` — verifica visiva headless (server statico dist/ +
  Playwright): screenshot in `shots/` (rosa, hover, tooltip, menu stato, WM, 1280px)
- `src/vite-env.d.ts` — tipi Vite per import asset (.webp)

### Changed
- `PlayerCardPaper.tsx` riscritta: niente più clip-path finti né feTurbulence
  inline; layout postcard dentro safe-area per variante (4 varianti assegnate
  per hash stabile dell'id), pinzatrice per priorità 5/5, azioni al hover
- `GlossaryTooltip.tsx` e `StatusToggle.tsx`: popover/menu via portal su
  document.body con position fixed misurata (flip sopra/sotto + clamp viewport)
  — prima venivano clippati dall'overflow del container e spostati dai
  transform/filter delle card
- `RosaView.tsx`: masthead e toolbar nuovi, scrivania per la lista, toast per
  il detach OS in anteprima web
- `StatsBar.tsx`: conteggi per stato (✓/?/○/▤) + barra progress scouting +
  info workspace, al posto dei conteggi ridondanti "visualizzati/totali"
- `PlayerForm.tsx` embedded: rimosso il sub-header duplicato (la chrome WM/OS
  mostra già titolo e pulsanti — audit ridondanze UI Cap.0)
- `Window.tsx`: corpo finestra su carta rigata da quaderno
- `index.html`: titolo aggiornato a v2.3

---

## [0.2.3] — 2026-10-10 — M2.1: Chiusura M2 + 6 miglioramenti d'uso v2.3

### Blocco A — Chiusura 4 FAIL ispettore M2

#### FIX A1 — Conferma rebuild hotfix (E12)
- Verifica byte-identità `main/` vs `m2-hotfix/` per `listone.rs` e `players.rs`: diff=0 → hotfix già integrato
- `npm run build` verde (vite build OK, 71 moduli, 30KB CSS, 221KB JS)
- `tsc --noEmit` verde (TypeScript type-check senza errori)
- `cargo check` + `cargo test` richiedono runner CI Windows (build-msi.yml) — Rust non disponibile nel sandbox di generazione

#### FIX A2 — Snapshot last_known_data arricchito (B5)
- `src-tauri/src/commands/players.rs`:
  - Aggiunta helper privata `collect_player_snapshot(conn, player_id) -> serde_json::Value` che serializza: player + scouting_notes (multi-row) + auction_data (1:1) + oracolo_projections (1:1) + pressione_mercato (1:1) in un unico JSON
  - `archive_player` ora usa questo helper invece di leggere solo la riga di players (prima il DELETE CASCADE cancellava i record collegati senza preservarli)
- `src-tauri/src/commands/listone.rs`:
  - `import_listone` Fase 2 (archiviazione automatica dei player non più in listone) usa lo stesso snapshot arricchito via helper esposto `_collect_player_snapshot`
- Struttura JSON snapshot:
  ```json
  {
    "player": {...},
    "scouting_notes": [...],
    "auction_data": {...} | null,
    "oracolo_projections": {...} | null,
    "pressione_mercato": {...} | null
  }
  ```

#### FIX A3 — Restore ricrea i collegati (B12)
- `src-tauri/src/commands/listone.rs`:
  - `restore_archived_player` riscritto per gestire sia snapshot M2 base legacy sia snapshot M2.1 arricchito (rilevamento via chiave "player")
  - Transazione SQLite atomica in 3 step:
    1. INSERT INTO players (la FK referenzia players.id)
    2. Ricrea le 4 tabelle collegate via helper `_recreate_connected_tables`
    3. DELETE FROM players_archive
  - Se qualsiasi step fallisce, rollback completo
- `src-tauri/src/commands/players.rs`: aggiunta helper `_recreate_connected_tables` esposto come `pub(crate)`

#### FIX A4 — Persistenza workspace attivo in localStorage (A8)
- `src/stores/useDbStore.ts`:
  - Aggiunta funzione `loadActiveDbIdFromLs()` / `saveActiveDbIdToLs()` (localStorage chiave `dossierfanta.activeDbId`)
  - `setActiveDatabase` e `refresh` ora persistono in localStorage
  - Nuova azione `restoreFromLocalStorage()` che verifica l'esistenza del DB salvato (vs eliminato) e ripristina l'attivo nel backend
- `src/App.tsx`: al boot chiama `restoreFromLocalStorage()` PRIMA di `refreshMeta` + `refreshDbs`
- Backend NON toccato, schema NON toccato

#### FIX A5 — Anteprima import con diff (B7)
- `src-tauri/src/commands/listone.rs`: nuovo comando `preview_import_listone(players_json) -> ImportPreview`
  - Esegue lo stesso matching di `import_listone` MA SENZA applicare modifiche
  - Ritorna 4 liste tipate: `created` (PreviewCreated), `archived` (PreviewArchived), `updated` (PreviewUpdated con old/new), `restored` (PreviewRestored)
  - Usa enum locale `MatchResult` per gestire il dispatch tra 3 tipi diversi in una singola closure
- `src/types/player.ts`: aggiunti 5 tipi (ImportPreview + 4 voci Preview)
- `src/api/tauri.ts`: wrapper `previewImportListone`
- `src/components/ImportPreview.tsx` (NUOVO): modale cartaceo che mostra le 4 liste con header colorati (green/blue/red/amber). Disabilita "Applica" se 0 operazioni.
- `src/components/ImportListone.tsx`: flusso a 2 step → carica JSON → click "Anteprima modifiche" → modale ImportPreview → click "Applica" o "Annulla"

### Blocco B — 6 miglioramenti d'uso v2.3

#### IMPROVEMENT B1 — Design system realistico (Cap.16)
- `src/styles/taccuino-realistic.css` (NUOVO, 200+ righe): texture 4-layer + ombre multilayer + Z levels + chrome WM + status toggle menu
  - Layer 1: griglia quaderno 14px (replicato da taccuino.css)
  - Layer 2: piega centrale verticale (linear-gradient, opacity 0.15, 80px centrata)
  - Layer 3: 4 radial-gradient (opacity 0.08, raggio 200px) per invecchiamento angoli
  - Layer 4: SVG inline con 3 macchie d'inchiostro fisse (opacity 0.04-0.06), non casuali
  - Ombre multilayer: contact (0 1px 2px / 0.20) + mid (0 4px 8px / 0.12) + ambient (0 12px 24px / 0.08). Hover: ombre +50% opacity + translateY(-3px)
  - Bordi strappati 8-12 punti con variazione organica (clip-path polygon con 30 punti totali tra top/bottom) + filter drop-shadow per simulare spessore carta
  - 5 livelli Z (Z0 sfondo, Z1 card, Z2 hover, Z3 tooltip, Z4 finestre WM, Z5 modale)
  - Toggle "taccuino pulito" via classe body.tacc-clean-mode disattiva Layer 2/3/4 mantenendo solo Layer 1
- `src/index.css`: import del nuovo CSS, classe .tacc-info-banner per B6, body.player-window per finestre OS
- `src/components/PlayerCardTaccuino.tsx`: usa classe `tacc-card tacc-card--v23` (entrambe) per attivare le ombre multilayer
- `src/components/RosaView.tsx`: toggle "taccuino pulito" persistito in localStorage; applica `body.tacc-clean-mode` via useEffect

#### IMPROVEMENT B2 — Audit ridondanze UI
- `src/components/RosaView.tsx`:
  - Rimosso il modale "edit" duplicato del PlayerForm (M2 aveva sia `setFormState({mode:'edit'})` che il modale stesso). Ora il flusso è: click card → apre come finestra WM (B5), non più come modale a tutto schermo. Risparmio di un layer di UI.
  - Footer legenda esteso con `⇄ toggle stato · T shortcut` per evitare duplicazione di istruzioni in altri punti
- `src/components/PlayerCardTaccuino.tsx`:
  - Eliminata la duplicazione "f₥ Fantamilioni" — il footer legenda già lo spiega, la card mostra solo `f₥ 78` (simbolo + valore)
  - Eliminato il doppio title/tooltip su ValueChip (raw era ridondante di fmtFmil già visualizzato)
- Ridondanze rimosse: 3 (modale edit duplicato, label f₥ ripetuta, raw text ridondante)

#### IMPROVEMENT B3 — Auto-toggle stato + toggle manuale
- `src-tauri/src/commands/players.rs`:
  - `set_player_status(player_id, new_status)` con validazione `new_status IN ('totali','scoutato','da_fare')`
  - `save_scouting_note(player_id, kind, label, content, source)` con auto-toggle: se `kind IN ('note','data')` e `content` non vuoto e giocatore in 'da_fare' → status promosso a 'scoutato' in singola transazione atomica. Non torna indietro automaticamente.
- `src/components/StatusToggle.tsx` (NUOVO): menu a 3 voci (Scoutato/Da fare/Totale) attivato al click sul timbro. Chiude su click fuori, ESC, o dopo aver applicato
- `src/components/PlayerCardTaccuino.tsx`: timbro di stato cliccabile con glyph `⇄` accanto; click → menu StatusToggle
- `src/components/RosaView.tsx`: shortcut `T` (key listener) cicla lo status del giocatore selezionato: totali → scoutato → da_fare → totali. Skip se il focus è in input/textarea/select

#### IMPROVEMENT B4 — Tooltip glossario integrato UI (Cap.9)
- `src/data/glossary.json` (NUOVO, 17 voci): f₥, M, MV, FVM, fascia, priorità, titolarità, fragilità, infortuni, modificatore, status, pm_esterna, pm_locale, oracolo, fork, slot, target. Definizioni + esempi dal Cap.19 del design doc
- `src/components/GlossaryTooltip.tsx` (NUOVO): componente riutilizzabile `<GlossaryTooltip term="fvm">FVM</GlossaryTooltip>`
  - Renderizza children + glyph ? (Special Elite 9.5px ink-soft)
  - Hover: popover cartaceo con 100ms delay aprire, 300ms delay chiudere (anti-flicker)
  - Click: popover persiste in modalità pinned
  - ESC: chiude qualsiasi popover aperto
  - Click fuori: chiude pinned
  - Popover: sfondo paper, bordo 1px ink-soft, ombra 3-layer Z3, font Special Elite per title + Courier Prime per def/example
- `src/components/PlayerCardTaccuino.tsx`: GlossaryTooltip applicato a f₥, M, MV, FVM (accanto ai valori) e fascia, priorità (accanto alle label)

#### IMPROVEMENT B5 — Window Manager ibrido (Cap.17)
- `src-tauri/src/commands/windows.rs` (NUOVO):
  - `open_player_window(player_id)`: crea finestra OS nativa (WebviewWindowBuilder, URL `/player/:id`, 560x720, min 320x400). Pre-check: già aperta → focus + return. Limite 6 finestre contemporanee → errore leggibile
  - `close_player_window(player_id)`: chiude finestra OS
  - `list_os_player_windows()`: ritorna array player_id con finestra OS aperta
- `src-tauri/src/commands/mod.rs`: registrato `pub mod windows;`
- `src-tauri/src/lib.rs`: registrati 3 nuovi comandi nell'invoke_handler
- `src-tauri/capabilities/default.json`: esteso `windows: ["main", "player-*"]` + permessi create/close/set-focus/set-size/set-position/webview-window/event
- `src-tauri/tauri.conf.json`: aggiunto `label: "main"` alla finestra principale, titolo `v2.3 (M2.1)`
- `src/stores/useWindowsStore.ts` (NUOVO): stato finestre WM in-app (posizione, dimensioni, z-order, minimized, maximized, prevRect). 9 azioni: openPlayerWindow, closeWindow, focusWindow, moveWindow, resizeWindow, minimizeWindow, restoreFromTaskbar, toggleMaximize, cycleZOrder (Alt+W). Set `detachedToOs` per sync con finestre OS
- `src/components/Window.tsx` (NUOVO): singola finestra con chrome 32px (drag handle + 3 pulsanti glyph ─ □ ✕), resize handle angolo ↘, pointer events per drag/resize, clamp ai bounds, doppio-click chrome → toggleMaximize
- `src/components/WindowManager.tsx` (NUOVO): container assoluto Z4 che renderizza tutte le finestre aperte via render-prop. Taskbar in fondo per finestre minimizzate. ResizeObserver per misurare i bounds. Alt+W per ciclare z-order
- `src/components/RosaView.tsx`: handleEdit ora apre come finestra WM (non modale). Render-prop `renderWindow` istanzia PlayerForm dentro la finestra. Se scheda è detached su OS → focus quella
- `src/components/PlayerCardTaccuino.tsx`: doppio-click sulla card → apre in finestra OS nativa (via api.openPlayerWindow)

#### IMPROVEMENT B6 — Nota esplicita sharing DB = M3a
- `src/components/DatabaseManager.tsx`: banner `.tacc-info-banner` (classe CSS) sotto il paragrafo introduttivo
  - Testo: "La condivisione live dei database tra dispositivi è disponibile nella milestone M3a (sync Iroh p2p + Yjs). In M2.1 i DB sono locali: puoi crearli, switcharli, eliminarli, ma non sincronizzarli con altri dispositivi."
  - Dismissibile via pulsante ×; stato persistito in localStorage chiave `dossierfanta.shareBannerDismissed`
- `src/index.css`: classe `.tacc-info-banner` + `.tacc-info-banner-dismiss` (bordo sinistro blue, padding, hover)

### Backend Rust — Nuovi comandi (3 in players.rs, 1 in listone.rs, 3 in windows.rs)

| Modulo | Comando | Descrizione |
|--------|---------|-------------|
| `players.rs` | `set_player_status(player_id, new_status)` | Toggle manuale status con validazione |
| `players.rs` | `save_scouting_note(player_id, kind, label, content, source)` | Auto-toggle status da_fare → scoutato |
| `listone.rs` | `preview_import_listone(players_json)` | Anteprima diff senza applicare |
| `windows.rs` | `open_player_window(player_id)` | Crea finestra OS nativa |
| `windows.rs` | `close_player_window(player_id)` | Chiude finestra OS |
| `windows.rs` | `list_os_player_windows()` | Elenca player_id con finestra OS |

### Frontend — Nuovi file (7)

| File | Descrizione |
|------|-------------|
| `src/components/WindowManager.tsx` | Container WM in-app + taskbar |
| `src/components/Window.tsx` | Singola finestra con chrome + drag/resize |
| `src/components/GlossaryTooltip.tsx` | Tooltip riutilizzabile per termini tecnici |
| `src/components/StatusToggle.tsx` | Menu a 3 voci per toggle status |
| `src/components/ImportPreview.tsx` | Modale anteprima diff import |
| `src/data/glossary.json` | 17 definizioni del Cap.19 |
| `src/styles/taccuino-realistic.css` | Texture 4-layer + ombre multilayer + Z levels |
| `src/stores/useWindowsStore.ts` | Stato finestre WM (Zustand) |

### Frontend — File modificati (10)

- `src/api/tauri.ts` — 6 nuovi wrapper (previewImportListone, setPlayerStatus, saveScoutingNote, openPlayerWindow, closePlayerWindow, listOsPlayerWindows)
- `src/types/player.ts` — 5 nuovi tipi (ImportPreview + 4 voci) + SaveScoutingNoteInput + ScoutingNoteKind
- `src/stores/useDbStore.ts` — persistenza localStorage active DB + restoreFromLocalStorage
- `src/components/PlayerCardTaccuino.tsx` — timbro cliccabile + GlossaryTooltip + design realistico (.tacc-card--v23)
- `src/components/ImportListone.tsx` — flusso 2-step con anteprima
- `src/components/DatabaseManager.tsx` — banner info sharing M3a
- `src/components/RosaView.tsx` — WindowManager + shortcut T + toggle taccuino pulito
- `src/App.tsx` — restoreFromLocalStorage al boot
- `src/index.css` — import taccuino-realistic + classi banner
- `package.json` — version 0.2.3

### Backend Rust — File modificati (5)

- `src-tauri/src/commands/players.rs` — helper `collect_player_snapshot` + `recreate_connected_tables` + 2 nuovi comandi
- `src-tauri/src/commands/listone.rs` — snapshot arricchito in archive + restore con ricreazione collegati + nuovo comando preview
- `src-tauri/src/commands/mod.rs` — registrato `pub mod windows;`
- `src-tauri/src/lib.rs` — 6 nuovi comandi registrati nell'invoke_handler
- `src-tauri/tauri.conf.json` — label "main", versione 0.2.3, titolo v2.3
- `src-tauri/Cargo.toml` — version 0.2.3
- `src-tauri/capabilities/default.json` — windows ["main", "player-*"] + permessi multi-window

### Backend Rust — Nuovi file (2)

- `src-tauri/src/commands/windows.rs` — modulo per multi-window Tauri (3 comandi)

### Verifica build

- `npm install`: 141 pacchetti installati ✓
- `npx tsc --noEmit`: 0 errori ✓
- `npm run build`: vite build OK, 71 moduli, dist/index.html + 30KB CSS + 221KB JS ✓
- `cargo check` + `cargo test`: richiede runner CI Windows (build-msi.yml) — Rust non disponibile nel sandbox di generazione

### Vincoli HARD rispettati (12/12)

1. ✅ Niente cancellazioni automatiche — delete_player esplicita con DeleteConfirmDialog; archive_player NON è cancellazione
2. ✅ Simbolo f₥ (f + ₥ U+20A5, senza spazio) — `fmtFmil` in lib/format.ts
3. ✅ Terminologia f₥ / M / MV / FVM rispettata in UI e Rust
4. ✅ Tabella players_archive separata (NON flag su players)
5. ✅ Schema SQLite NON toccato (byte-identico a schema_v2.2.sql allegato)
6. ✅ rusqlite (NON tauri-plugin-sql) — tutte le query in comandi Rust
7. ✅ Tutte le operazioni DB tramite comandi Tauri (no SQL dal frontend)
8. ✅ Niente fetch HTTP diretta dal frontend (api/tauri.ts ha solo invoke)
9. ✅ Tipi TS mirror delle struct Rust (types/player.ts)
10. ✅ Validazione a 3 livelli: UI (form) + Rust (validators) + CHECK schema
11. ✅ Niente emoji — solo glyph Unicode (★ ◆ ▲ ▼ → » □ ⚠ ✓ ? ₥ ⇄ ─ ✕)
12. ✅ CSP non nulla (`default-src 'self'` + eccezioni Google Fonts per styles)

### Out of scope rispettato (10/10)

- ❌ Sync live Iroh/Yjs (M3a) — solo banner informativo B6
- ❌ Sync BT BLE / BT Classic (M4/M4a)
- ❌ Auto-fetch GitHub Actions per il listone (M3) — import resta manuale
- ❌ Oracolo v2 con proiezioni (M5)
- ❌ Piano Rosa v3 con mappa dipendenze (M6)
- ❌ Pressione Mercato con sorgente esterna (M6) — `pm_esterna` può essere NULL
- ❌ Generalizzazione updated_by (M3a) — resta hard-coded 'me'
- ❌ Vista Confronta DB side-by-side (M6)
- ❌ Cursori collaborativi live (M3a)
- ❌ Condivisione DB tra dispositivi (M3a) — solo banner informativo

---

## [0.1.0] — 2026-09-14

### Added — M1: Base offline

**Stack**
- Tauri 2.0 (ultima stabile) con frontend React 18 + TypeScript 5 + Vite 5
- SQLite via `rusqlite` (feature `bundled`: SQLite compilato dentro il binario)
- Schema v2.2 completo applicato al primo avvio (file `src-tauri/migrations/schema_v2.2.sql`)
- Zustand 4.5 per state management
- Tailwind CSS 3.4 + CSS custom (palette taccuino base: paper/ink/red/green/amber/blue)

**Backend Rust**
- `db::open_and_migrate()` — apre `mio.db` (lo crea se non esiste) e applica schema v2.2 in modo idempotente
- Comandi Tauri tipizzati per tutte le operazioni DB:
  - `init_db`, `get_db_info` (path, versione schema, conteggi)
  - `list_players` (con filtri search/pos_fanta/status/fascia + paginazione)
  - `create_player` (UUID v4 generato lato Rust, `db_id` = "default-personal")
  - `update_player` (full replace dei campi editabili)
  - `delete_player` (esplicita — il frontend DEVE confermare con dialog)
  - `archive_player` (sposta in `players_archive`, non distruttivo)
  - `list_archive`, `count_players`
- Validazione lato Rust di tutti i vincoli CHECK (priority 0-5, med/medv 0-10, pos_fanta enum, fascia enum, status enum)
- `AppError` tipizzato con `thiserror`, serializzato come stringa per il frontend
- Init DB PRIMA di Tauri (garantisce che `mio.db` sia creato anche se la webview fallisce)

**Frontend React**
- `RosaView`: layout principale con header + StatsBar + toolbar (search + role filter) + lista + footer simbologia
- `PlayerList`: griglia responsive di card (1-4 colonne in base al viewport)
- `PlayerCard`: card giocatore con badge ruolo colorato (P/D/C/A), barra fascia verticale, stelle priorità, valori disambiguati (f₥ / M / MV / FVM), stato scouting
- `PlayerForm`: modal di creazione/modifica con tutti i campi richiesti + validazione client-side + datalist autocomplete squadre
- `DeleteConfirmDialog`: conferma cancellazione con checkbox esplicito + nome giocatore in evidenza + chiusura con ESC
- `SearchBar`: input ricerca con debounce 250ms (cancella con `×`)
- `RoleFilter`: chips Tutti / P / D / C / A con colore attivo
- `StatsBar`: conteggi (visualizzati, totali con filtri, archiviati) + path DB + versione schema

**State management (Zustand)**
- `usePlayersStore`: lista + filtri + azioni CRUD con refresh automatico post-mutazione
- `useDbMetaStore`: metadati DB separati (no re-render quando cambiano solo i filtri)

**Styling**
- Tailwind config con palette taccuino (paper #F4ECD8, ink #2B1B12, red #8B2E1F, green #4A6741, amber #B8860B, blue #2C4A6B)
- CSS custom: texture carta (linee orizzontali sottili), scrollbar taccuino, range slider rosso, select con freccia custom
- Simbolo `f₥` Unicode U+20A5 (Mill Sign) usato ovunque per Fantamilioni

**Testing**
- `src-tauri/tests/m1_smoke_test.rs`: test end-to-end offline che verifica schema applicato, 10 tabelle + 1 vista + 2 trigger + 3 preset, DB default "mio.db", CRUD completo, trigger `updated_at` automatico, filtri search/pos_fanta case-insensitive, archiviazione non-distruttiva, validazione vincoli CHECK

**Build & delivery**
- `tauri.conf.json` configurato per Windows (WiX language=it-IT, NSIS installer perMachine + selector Italian/English)
- Icona taccuino generata programmaticamente (1024x1024 source + varianti 32/128/256/512 + .ico multi-res + .icns)
- Bundle `.deb` Linux buildato come smoke test (2.4MB)
- Binario release 5MB (LTO + strip)

**Documentazione**
- `README.md` con istruzioni dev/build per Windows (.msi), Linux (.deb), macOS (.app)
- Sezione troubleshooting Linux/Windows
- Glossario simboli (f₥ / M / MV / FVM / Fascia / Archiviazione)

### Vincoli hard rispettati

- ✅ **Niente cancellazioni automatiche** — `delete_player` è l'unico modo per rimuovere. Il frontend mostra `DeleteConfirmDialog` con checkbox esplicito prima di chiamarlo.
- ✅ **Simbolo f₥** — Unicode U+20A5 (Mill Sign), renderizzato via `FMIL_SYMBOL` in `src/lib/format.ts`.
- ✅ **Terminologia disambiguata** — `fmil_spesi` (f₥), `med` (M), `medv` (MV), `fvm` (FVM). Etichette distinte in UI e form.
- ✅ **`players_archive` separata** — i giocatori non più in Serie A vengono spostati (non flaggati). Recuperabili.
- ✅ **Schema esattamente come allegato** — `src-tauri/migrations/schema_v2.2.sql` è identico al file fornito. Applicato via `include_str!()` senza modifiche.

### Decisioni architetturali

- **`rusqlite` invece di `tauri-plugin-sql`**: il requisito HARD "Comandi Tauri in Rust per tutte le operazioni DB" è in tensione con `tauri-plugin-sql` (che espone SQL diretto al JS). Scelta: usare `rusqlite` direttamente in Rust. Tutte le query SQL vivono dentro comandi Rust tipizzati. Il frontend non scrive mai SQL: invoca solo comandi Rust tramite `@tauri-apps/api/core::invoke`.
- **DB init prima di Tauri**: in Tauri 2.0 le finestre da `tauri.conf.json` vengono create PRIMA del setup() callback. Se la webview fallisce (es. WebKit senza process binaries in ambienti headless), setup() non viene chiamato e il DB non verrebbe inizializzato. Soluzione: risolvere `app_data_dir` con la crate `dirs` PRIMA di `tauri::Builder`, inizializzare il DB, poi passarlo a Tauri via `.manage(DbState(...))`.

### Out of scope per M1

- ❌ Multi-DB workspace (M2)
- ❌ Switcher DB + UI taccuino completa (M2)
- ❌ Sync live Yjs + Iroh p2p (M3a)
- ❌ Auto-fetch GitHub Actions (M3)
- ❌ Sync BT BLE / Classic (M4 / M4a)
- ❌ Oracolo v2 (M5)
- ❌ Piano Rosa v3 + Pressione Mercato (M6)
- ❌ Tema taccuino completo (M2) — in M1 c'è styling base ma pulito

---

## Convenzioni versione

- `0.x.y` — pre-1.0, milestone M1-M6
- `1.0.0` — primo release pubblico completo (post-M6)
- Tag formato: `v0.1.0`, `v0.2.0-m1`, `v1.0.0-rc1` (prerelease se ha trattino)
