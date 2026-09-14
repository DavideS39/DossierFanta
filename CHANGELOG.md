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
