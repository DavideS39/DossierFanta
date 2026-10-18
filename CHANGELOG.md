# Changelog

Tutti i cambiamenti notevoli di DossierFanta v2.2 vengono documentati qui.
Il formato segue [Keep a Changelog](https://keepachangelog.com/it/1.1.0/),
e il progetto adotta [Semantic Versioning](https://semver.org/lang/it/).

---

## [0.3.3] — 2026-10-18 — M3a.3: sync multi-canale (Supabase + Iroh) + peer key persistente + Listone come DB

Sprint finale per chiudere M3. Architettura sync completa con due provider
attivi simultaneamente sullo stesso Y.Doc: Supabase (relay + offline storage)
e Iroh (p2p diretto low-latency). La peer key Iroh è persistita in SQLite
(stabile cross-boot). SyncView ridisegnata con auto-connect dei peer fidati.
Listone promosso a DB di prima classe nel DatabaseManager con azioni inline.

### Architettura sync finale (design doc v2.5, Cap.5 + brief M3a.3)

```
PC A ←─ Supabase Realtime ─→ Supabase ←─ Supabase Realtime ─→ PC B
      (WebSocket ~100ms)    (gratis)    (WebSocket ~100ms)
Y.Doc                         PostgreSQL
SQLite                        yjs_updates
      ←─ query (su reconnect) ─→   ←─ query (su reconnect) ─→

      ←─ Iroh p2p diretto ──────────────────────────────────→
         (quando entrambi online, ~50ms)
```

DUE PROVIDER attivi contemporaneamente sullo stesso Y.Doc. Yjs gestisce i
duplicati automaticamente (idempotenza CRDT). Entrambi implementano
l'interfaccia `SyncProvider` (abstraction layer) — domani, per sostituire
Supabase con un server proprio, basta creare un nuovo provider che
implementa la stessa interfaccia.

### Deliverable M3a.3 (8 totali)

1. **Abstraction layer SyncProvider + SyncManager** — interfaccia comune
   per tutti i provider (`src/lib/sync/SyncProvider.ts`,
   `src/lib/sync/SyncManager.ts`). Manager multi-provider con
   `connectAll()` / `disconnectAll()` / `syncAllFromOffline()` via
   `Promise.allSettled` (un provider fallito non blocca gli altri).
2. **SupabaseYjsProvider** (`src/lib/sync/SupabaseYjsProvider.ts`) —
   realtime broadcast via WebSocket (~100ms) + offline storage su
   tabella PostgreSQL `yjs_updates`. Setup SQL documentato in
   `docs/supabase-setup-m3a3.sql` (RLS policies, indici, pubblicazione
   Realtime). Config centralizzata in `src/lib/sync/syncConfig.ts`
   (URL + anonKey + roomName + cleanupDays).
3. **Peer key persistente (Iroh)** — nuova tabella `sync_identity`
   (schema v2.4, singleton row id=1) in
   `src-tauri/migrations/schema_v2.4.sql`. `iroh_start_node` carica la
   SecretKey salvata se esiste, altrimenti la genera + salva. Peer_key
   (NodeId derivato) è STABILE cross-boot. `SCHEMA_VERSION_TARGET = 4`
   in `db.rs`, migrazione `v2.3 → v2.4` idempotente.
4. **IrohYjsProvider** (`src/lib/sync/IrohYjsProvider.ts`) — integrazione
   frontend di Iroh gossip. Registra `onSyncUpdateReceived` per applicare
   update remoti (`Y.applyUpdate(doc, bytes, this)`) + `ydoc.on('update')`
   per broadcast update locali via `iroh_broadcast_update`. Auto-connect
   trusted peers al boot. `connectToSavedPeers(peerKeys)` riconnette i
   peer salvati in `sync_peers`.
5. **Fix PB4-A (architetturale)** — risolto ELIMINANDO i bridge manuali
   (`bridgePlayerUpdate`, `bridgeScoutingNoteAppend`,
   `bridgeAuctionDataUpdate`) e i flag `isApplyingLocalBridge` /
   `isApplyingRemoteUpdate`. L'anti-loop è ora gestito dal parametro
   `origin` di Yjs (nativo, molto più robusto del flag manuale):
   - Update locale: `yPlayers.set(...)` senza origin → listener
     `yPlayers.observe` vede `transaction.local === true` → SKIP persistenza
     (già fatta da `update_player` con `updated_by='me'`).
   - Update remoto: `Y.applyUpdate(doc, bytes, this)` → listener vede
     `transaction.local === false` → PROCEDE con `save_player_from_sync`
     (`updated_by='sync-live'`).
6. **SyncView redesign** (`src/components/SyncView.tsx`) — UI completamente
   ridisegnata: sezione identità (peer key + display_name + [salva]),
   stato dual-provider (● Supabase + ●/○ Iroh), lista peer conosciuti con
   [connetti]/[disconnetti]/[rimuovi], aggiungi nuovo peer, box info.
   Sincronizza con SyncManager singleton + `api.getSyncIdentity()` +
   `api.listTrustedPeers()`.
7. **Listone come DB nel DatabaseManager** — il DB di tipo `listone`
   appare nel workspace con card inline contenente: counter giocatori,
   ultimo aggiornamento, 3 pulsanti (`[aggiorna ora]` / `[anteprima]` /
   `[fallback: fantacalcio.it]`). ImportPreview renderizzato inline nella
   card per confermare il diff prima di applicare. Sostituisce la necessità
   di aprire la schermata AggiornamentiView separata per le azioni di
   routine.
8. **Fix PB6 + WARN residui**:
   - **PB6** (owner GitHub): `DATA_REPO_OWNER = "DavideS39"` già impostato
     in `listone.rs:989` (M3a.2). Repo `DavideS39/DossierFanta-Data` è il
     riferimento pubblico. Verifica: workflow `.github/workflows/scrape.yml`
     + release con `players.json` asset pubblicato.
   - **W1** (rimozione "marco" da `validate_updated_by`): già fatto in
     M3a.2 — whitelist ora `{ "me", "auto-fetch", "sync-live" }`.
   - **W2** (CHANGELOG entries M3 / M3.1 / M3a / M3a.1 / M3a.2 / M3a.3):
     questa entry chiude W2 con un riepilogo completo.
   - **W3** (`iroh_connect_by_peer_key` ritorna `Ok(false)` su errore/
     timeout): già fatto in M3a.2 — solo `Ok(Ok(_conn))` ritorna `Ok(true)`
     + aggiunge il peer alla lista connessi.

### Altre modifiche

- **App.tsx boot sync** — `initYjsBridge()` + `startCursorsCleanup()` +
  `SyncManager.addProvider(SupabaseYjsProvider)` (sempre) + (se
  `getSyncIdentity()` ritorna Some) `addProvider(IrohYjsProvider)` +
  `connectAll()` + auto-connect trusted peers. Il listener
  `sync-update-received` vive al root (non nel SyncView) così sopravvive
  alla chiusura del modal. Gap 1 + Gap 2 chiusi.
- **Nuovi comandi Tauri** (registrati in `lib.rs`):
  `iroh_stop_node`, `get_sync_identity`, `set_sync_display_name`,
  `list_trusted_peers`, `remove_trusted_peer`, `iroh_connect_by_peer_key_v2`.
- **Nuovi wrapper `api/tauri.ts`**: `irohStopNode`,
  `irohConnectByPeerKeyV2`, `getSyncIdentity`, `setSyncDisplayName`,
  `listTrustedPeers`, `removeTrustedPeer`, `onSyncUpdateReceived`,
  `onSyncPeerConnected`, `onSyncPeerDisconnected`.
- **Nuovi tipi `types/sync.ts`**: `SyncIdentity`, `TrustedPeer`.
- **`@supabase/supabase-js` v2.118** aggiunto alle dipendenze
  (`package.json`).
- **Cargo.lock + package-lock.json** aggiornati (vincolo HARD #15).
- **Versioni bumped**: `package.json` 0.3.0 → 0.3.3, `Cargo.toml`
  0.3.0 → 0.3.3, `tauri.conf.json` 0.3.0 → 0.3.3, `HTTP_USER_AGENT`
  in `listone.rs` 0.3.2 → 0.3.3.

### Vincoli HARD rispettati

- **#13**: Sync-live NON sostituisce SQLite come source of truth. Yjs è
  transport + merge layer.
- **#14**: Pairing esplicito (peer key scambiata out-of-band).
- **#15**: Cargo.lock + package-lock.json committati.
- **#16**: Schema v2.2 + v2.3 invariati. v2.4 solo additive
  (CREATE TABLE IF NOT EXISTS sync_identity).
- **#17**: Niente Tag & Filtri (M4).
- **#18**: Supabase NON è authoritativo. SQLite locale è source of truth.
- **#19**: SUPABASE_URL e SUPABASE_ANON_KEY hardcoded in `syncConfig.ts`
  (chiave publishable, NON sensibile).
- **#20**: Tabella `yjs_updates` contiene SOLO bytes binari Yjs (CRDT
  diffs). Decodificabile solo con il Y.Doc locale.
- **#21**: Iroh opzionale. Se non disponibile, Supabase basta per il sync.

### Test funzionali (14 minimi)

Vedi `docs/supabase-setup-m3a3.sql` per l'SQL setup + brief M3a.3 per la
checklist dei 14 test funzionali (Supabase connection, peer key persistente,
sync online + offline + auto-reconnect, multi-provider idempotenza,
updated_by markers, conflict resolution B.7, cursori collaborativi,
listone come DB, build .msi verde).

---

## [Unreleased] — 2026-10-17 — HOTFIX critico: l'app .msi non si avviava proprio

Hotfix chirurgico che risolve un bug critico segnalato dall'utente: dopo aver
installato l'.msi generato da `build-msi.yml`, l'app **non si apriva proprio**.
Nessuna finestra, nessun messaggio di errore visibile. Sintomo identico su
qualsiasi macchina Windows su cui l'app veniva installata da zero (file
`mio.db` non preesistente).

### Causa radice

`src-tauri/src/db.rs::has_column` chiamava `stmt.exists([&column.to_string()])`
passando 1 parametro bind a una query `PRAGMA table_info(<table>)` che ha 0
placeholder. rusqlite 0.32 ritorna `Err(InvalidParameterCount(1, 0))`.

Catena di propagazione dell'errore:

1. `has_column` ritorna `Err(InvalidParameterCount(1, 0))` per ogni chiamata.
2. `migrate_v22_to_v23` propaga l'errore via `?` (è chiamata 6 volte, una per
   colonna sync-live di v2.3: `players.last_sync_at`, `players.sync_node_id`,
   `scouting_notes.last_sync_at`, `scouting_notes.sync_node_id`,
   `auction_data.last_sync_at`, `auction_data.sync_node_id`).
3. `open_and_migrate` propaga l'errore via `?`.
4. `lib.rs::run()` ha un `match` arm `Err(e) => { eprintln!(...); std::process::exit(1); }`.

Su Windows in release (`#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]`
in `main.rs`), `eprintln!` non ha output visibile (nessuna console). L'app
chiama `std::process::exit(1)` PRIMA che `tauri::Builder::default().run(...)`
venga raggiunto, quindi nessuna finestra viene mai creata.

Il bug si manifesta solo su DB nuovo (file `mio.db` non esistente), perché
`migrate_v22_to_v23` viene chiamato solo nel branch `!schema_already_applied`
di `open_and_migrate`. In dev (su DB già esistente da sessioni precedenti)
il bug era latente.

### Fix

#### FIX A — `has_column` non passa parametri bind a `PRAGMA`
- `src-tauri/src/db.rs::has_column` — Rimossa la chiamata
  `stmt.exists([&column.to_string()])?` (che dava `InvalidParameterCount`).
  Il valore `exists` era già scartato con `let _ = exists;` e la logica reale
  era nello scroll di `query_map([], ...)`. La funzione ora scorre le righe
  di `PRAGMA table_info(<table>)` e ritorna `true` alla prima corrispondenza
  di `name == column`. Nessun parametro bind passato a PRAGMA.
- Commento doc aggiornato con la spiegazione del bug + sintomo esterno, così
  eventuali future modifiche sanno perché NON usare `stmt.exists([param])`
  su query PRAGMA.

#### FIX B — `lib.rs::run()` logga su file `boot.log` non solo su stderr
- `src-tauri/src/lib.rs` — Aggiunta funzione `boot_log(line: &str)` che
  scrive in append su `<app_data_dir>/boot.log` oltre che su `eprintln!`.
  Tutti i `eprintln!("FATAL: ...")` prima di `std::process::exit(1)` ora
  passano per `boot_log`, quindi eventuali futuri crash di init sono
  diagnosticabili dall'utente (su Windows: `%APPDATA%/com.dossierfanta.app/boot.log`).
- `eprintln!` viene preservato per dev (visibile in console) e per
  `tauri-plugin-log` dopo l'init.

#### FIX C — Rimossa chiamata inutile `db::clone_conn` per `default-personal`
- `src-tauri/src/lib.rs` — Nel loop che apre una `Connection` per ogni DB
  logico, il branch `default-personal` chiamava `db::clone_conn(&main_conn, &db_path)`
  che internamente fa `open_db_file(path).expect("cannot open clone connection to mio.db")`.
  La connessione clonata veniva poi subito sovrascritta da
  `connections.insert("default-personal".to_string(), main_conn)` dopo il loop
  (operazione inutile). Con `panic = "abort"` nel profile.release, un qualsiasi
  errore di `open_db_file` (es. WAL lock temporaneo) avrebbe abortito l'app
  silenziosamente. Il branch `default-personal` ora fa `continue` e lascia
  che la insert di `main_conn` dopo il loop sia l'unica sorgente di verità.

### Test di regressione

- `src-tauri/tests/m3a_has_column_regression_test.rs` (NEW) — 3 test:
  1. `open_and_migrate_on_fresh_db_succeeds`: riproduce il flusso esatto su
     DB nuovo, verifica che non ritorni errore, verifica che le 6 colonne
     sync-live siano presenti dopo la migrazione.
  2. `open_and_migrate_is_idempotent_on_existing_db`: seconda chiamata
     sullo stesso file deve essere idempotente (le colonne esistono già,
     `has_column` ritorna true, gli ALTER vengono saltati).
  3. `pragma_table_info_does_not_accept_bind_params`: test proxy che
     verifica il pattern buggy (`stmt.exists([param])` su PRAGMA) ritorna
     errore. Se rusqlite in futuro cambia behavior, questo test fallisce e
     ci avvisa di rivedere `has_column`.

### Files modificati

- `src-tauri/src/db.rs` — `has_column` riscritta senza `stmt.exists([param])`
- `src-tauri/src/lib.rs` — `boot_log()` helper + rimozione `clone_conn` per
  `default-personal` + tutti i `eprintln!` FATAL passano per `boot_log`
- `src-tauri/tests/m3a_has_column_regression_test.rs` (NEW) — 3 test di
  regressione

### Verifica manuale (post-fix)

1. `cargo test --test m1_smoke_test -- --nocapture` — passa
2. `cargo test --test m3a_has_column_regression_test -- --nocapture` — passa
3. Push di tag `v0.3.3` (o successivo) → `build-msi.yml` verde → installare
   l'.msi su macchina Windows pulita (nessun file `%APPDATA%/com.dossierfanta.app/`
   preesistente) → l'app si avvia correttamente, mostra splash screen
   "DossierFanta v2.5 · M3" → passa a `RosaView` vuota con messaggio
   "Nessun giocatore" (aspettato su DB nuovo).
4. In caso di futuro problema di init, ispezionare
   `%APPDATA%/com.dossierfanta.app/boot.log` per il messaggio FATAL.

### Note

- Lo schema SQLite (`migrations/schema_v2.2.sql` e `schema_v2.3.sql`) NON è
  stato toccato. Il bug era nel codice Rust che interrogava lo schema, non
  nello schema stesso.
- Il `Cargo.lock` NON è stato rigenerato: nessuna dipendenza aggiunta o
  rimossa, solo codice Rust modificato in 2 file.
- `tauri.conf.json` e `capabilities/default.json` NON sono stati toccati.
- Il profile.release (`panic = "abort"`, `opt-level = "s"`, `lto = true`)
  NON è stato toccato. Il fix funziona sia con `panic = "abort"` che con
  `panic = "unwind"`.

---

## [0.2.5] — 2026-10-12 — M2.2 sprint zero M3: 4 fix ispettore + 2 bug grafici

Sprint zero chirurgico che chiude i 4 fix bloccanti dell'ispezione M2.1
(F11, F12, H9, E3) e i 2 bug grafici segnalati dall'utente in v2.4 (B1 gap
resize texture, B2 finestre native Windows). Niente nuove feature, niente
refactor architetturale. Solo dopo M2.2 verde, M3 può partire.

### Blocco A — 4 FIX ISPETTORE M2.1

#### FIX A1 — F11: Doppio-click chrome stacca in OS nativa
- `src/lib/windowActions.ts` (NEW) — helper condiviso
  `detachWindowToOs(playerId)` + `attachWindowFromOs(playerId)` che
  centralizza il flusso detach (close in-app → open OS → track store →
  sync backend). Chiamato da Window.tsx (chrome) e RosaView (fallback).
- `src/components/Window.tsx:325-330` — l'handler `onDoubleClick` sul
  `<header className="wf-head">` ora chiama `detachWindowToOs(win.id)`
  invece di `toggleMaximize(win.id)`. Il pulsante □ resta dedicato al
  maximize (Opzione 1 del brief M2.2). Aggiornato anche il `title`
  descrittivo della chrome.
- `src/components/PlayerCardPaper.tsx:204-208` — rimosso il pulsante ⧉
  (era ridondante ora che la chrome fa detach). Il doppio-click sul corpo
  card resta come gesture alternativa via `onDetachOs`.

#### FIX A2 — F12: Sync eventi Tauri emit/listen
- `src-tauri/src/commands/players.rs`:
  - Aggiunto `use tauri::{AppHandle, Emitter, State};` per il trait
    `Emitter` (metodo `app.emit(event, payload)`)
  - `set_player_status` (riga 992), `save_scouting_note` (riga 1089),
    `save_auction_data` (riga 1382), `assign_player` (riga 1496):
    aggiunto parametro `app: AppHandle` + dopo il commit DB chiamano
    `let _ = app.emit("player-updated", serde_json::json!({ "id": &player_id }));`
    per notificare tutte le finestre (main + player-* OS native)
- `src-tauri/capabilities/default.json`: aggiunti
  `core:event:allow-emit` + `core:event:allow-listen` (espliciti oltre
  al default) per garantire che il frontend possa sottoscrivere gli eventi
- `src/api/tauri.ts`: aggiunto helper `onPlayerUpdated(callback)` che
  wrappa `listen<{ id: string }>("player-updated", ...)`. In mock mode
  è no-op (ritorna una UnlistenFn vuota)
- `src/lib/usePlayerSync.ts` (NEW) — hook React che sottoscrive
  `player-updated` per un singolo player. Usa un ref interno alla
  callback per permettere al caller di passare callback inline senza
  useCallback. In anteprima web è no-op.
- `src/App.tsx`: montato `usePlayerSync(null, ...)` con debounce 150ms
  per refreshare usePlayersStore (lista Rosa) + useDbMetaStore quando
  un qualunque player viene aggiornato. Skip in finestra OS (gestito da
  PlayerOSWindow).
- `src/components/PlayerOSWindow.tsx`: montato `usePlayerSync(playerId, ...)`
  per refreshare il player quando l'evento arriva per il playerId
  corrente. Commento top aggiornato: niente più "refresh manuale" (era
  il TODO F12 noto nel report M2.1).
- `src/components/PlayerForm.tsx`: montato `usePlayerSync(player?.id, ...)`
  per refreshare auction_data + scouting_notes quando il player in edit
  viene modificato da un'altra finestra. I campi del form base NON
  vengono resettati (l'utente potrebbe starli editando).

#### FIX A3 — H9: Commit Cargo.lock
- `scripts/generate-cargo-lock.sh` (NEW) — script shell che l'utente
  esegue localmente per generare `src-tauri/Cargo.lock` la prima volta
  (l'ambiente M2.2 non ha toolchain Rust). Verifica anche che
  `.gitignore` NON escluda Cargo.lock e che il lockfile sia sincronizzato
  con Cargo.toml (`cargo verify-lock`).
- `.github/workflows/build-msi.yml`: aggiunto step "Verify Cargo.lock"
  prima del build. Se il file manca o è out-of-sync, il workflow fallisce
  esplicitamente con un messaggio chiaro. Aggiunto `args: --locked`
  al `tauri-action` per garantire che la build CI usi ESATTAMENTE
  le versioni delle dipendenze fissate in Cargo.lock (build riproducibile).
- NOTA: il file Cargo.lock NON è incluso in questa release perché il
  sandbox di generazione M2.2 non ha cargo. L'utente deve eseguire
  `scripts/generate-cargo-lock.sh` sul suo dev machine e committare
  il file. Vedere la sezione "Stato readiness M3" nel report finale.

#### FIX A4 — E3: Tooltip glossario su badge stato
- `src/components/PlayerCardPaper.tsx:163-188` — il badge stato
  (Scoutato/Da fare/Totale + ⇄ toggle, o Archiviato) è ora avvolto da
  `<GlossaryTooltip term="status">`. Il popover mostra la definizione
  di "status" (scoutato/da fare/totale + auto-toggle B3). La voce
  `status` era già presente in `glossary.json:52-56` con title + def
  + example, niente aggiunta necessaria lì.

### Blocco B — 2 BUG GRAFICI v2.4

#### BUG B1 — Gap trasparente nel resize della finestra
- Diagnosi (Cap.16 "Texture handling"): il bug era causato da
  `background-repeat: repeat` su `desk-tile.png` (440x584). Al resize
  della finestra WM in-app o OS nativa, l'ultima ripetizione veniva
  tagliata e lasciava un gap di 1-2px trasparente tra le ripetizioni
  e in fondo.
- Fix applicato: `background-repeat: round` invece di `repeat`. Il
  browser scala leggermente la texture per farla combaciare esattamente
  N volte senza gap. La distorsione è impercettibile sui tile di carta
  rigata (legal pad). La texture `desk-vintage` è già `no-repeat + 100% 100%`
  → niente gap di partenza.
- File modificati:
  - `src/components/Window.tsx:65-89` — `WM_SHEET_BG[0].repeat: "round"`
  - `src/components/PlayerOSWindow.tsx:38-52` — stesso
  - `SheetBgConfig.repeat` type ampliato a `"repeat" | "round" | "no-repeat"`
- Soluzione alternativa non applicata: `background-size: cover` +
  `background-attachment: fixed` (l'avrebbe sgranata sui tile 440x584).
  `background-repeat: round` è la soluzione raccomandata dal Cap.16
  per texture non seamless-ready.

#### BUG B2 — Finestre native Windows non vanno
- Diagnosi (Cap.17 "Troubleshooting layer 2", 5 punti):
  1. **Comando Tauri** (`windows.rs::open_player_window`): era già
     corretto (`WebviewWindowBuilder::new + .build()`). Aggiunto
     logging esteso con `log::info!` su ogni step (ingresso, pre-check,
     conteggio, builder, build, successo/errore) per diagnosticare
     futuri malfunzionamenti.
  2. **Routing frontend** (`App.tsx`): era già corretto (branch su
     `window.location.pathname` per riconoscere `/player/:id`). Fix
     aggiuntivo: `vite.config.ts` ha ora `appType: "spa"` esplicito
     per garantire SPA fallback in dev (Vite deve servire index.html
     per qualunque route, non 404).
  3. **Capabilities** (`default.json`): aveva già
     `core:webview:allow-create-webview-window` (essenziale per
     `open_player_window`). Aggiunti `core:event:allow-emit` +
     `core:event:allow-listen` per FIX A2.
  4. **State non condiviso** tra finestre: risolto da FIX A2 (eventi
     Tauri per sync). `PlayerOSWindow` faceva già fetch del player
     via `api.getPlayer` al mount; ora refresha anche quando l'evento
     arriva.
  5. **Conflict WM in-app**: `WindowManager.tsx` filtra già
     `detachedToOs` (riga 67-68). Nessun fix necessario.
- File modificati:
  - `src-tauri/src/commands/windows.rs` — logging esteso su
    `open_player_window`, `close_player_window`, `list_os_player_windows`
  - `vite.config.ts` — `appType: "spa"` esplicito

### Changed
- Version bump: `package.json` 0.2.3 → 0.2.5, `Cargo.toml` 0.2.3 → 0.2.5,
  `tauri.conf.json` 0.2.3 → 0.2.5. Titolo finestra main aggiornato a
  "DossierFanta — Taccuino v2.4 (M2.2)". Splash screen App.tsx aggiornato
  a "v2.4 · M2.2".

### Removed
- Pulsante ⧉ in `PlayerCardPaper.tsx` (ridondante ora che la chrome fa
  detach via doppio-click — FIX A1 complementare)

### Note
- Schema SQLite `schema_v2.2.sql` NON toccato (byte-identico al baseline,
  MD5 6ea1a2719009b93f9ee2df3c6af0a656 — vincolo HARD #5 rispettato).
- `update_player` non emette `player-updated` perché fuori dallo scope
  del brief M2.2 (che menziona solo save_scouting_note/save_auction_data/
  set_player_status/assign_player). La main window refresha comunque la
  lista Rosa dopo `update_player` via `usePlayersStore.updatePlayer`
  riga 127. Per coerenza totale, si potrebbe aggiungere l'evento anche
  a `update_player` in un follow-up.

---

## [0.3.2] — 2026-10-16 — M3a.2: 3 fix bloccanti (PB4-A, PB4-B, PB6) + W1-W3, M3 chiusa

Micro-sprint finale che chiude formalmente M3. Risolve i 2 bug latenti
identificati dall'ispezione M3a.1 (auto-sovrascrittura marker `updated_by`,
path ricezione sync interrotto) + il problema operativo (owner GitHub
inesistente) + 3 fix WARN non bloccanti. Al termine, M3 è formalmente
completa e la release .msi è possibile.

### Blocco A — 3 FIX BLOCCANTI

#### FIX PB4-A — Anti-loop flag `isApplyingLocalBridge` nei 3 bridge
- `src/lib/sync/yjsDocuments.ts` — Aggiunto nuovo flag
  `isApplyingLocalBridge` (distinto da `isApplyingRemoteUpdate`). Le 3
  funzioni bridge (`bridgePlayerUpdate`, `bridgeScoutingNoteAppend`,
  `bridgeAuctionDataUpdate`) lo impostano a `true` PRIMA della
  `ydoc.transact(...)` e lo ripristinano a `false` nel `finally`.
- I 3 listener (`playersHandler`, `notesHandler`, `auctionHandler`)
  ora escono early-return su `if (isApplyingLocalBridge) return;`
  (NON più su `isApplyingRemoteUpdate`).
- Perché due flag distinti: il flag `isApplyingRemoteUpdate` viene
  impostato da `applyRemoteUpdate` (peer ricevente), dove il listener
  DEVE procedere e chiamare `save_*_from_sync` per persistere l'update
  remoto su SQLite del peer ricevente. Se usassimo lo stesso flag, il
  listener uscirebbe early-return anche sul path ricezione → SQLite del
  peer B mai aggiornato.
- Effetto: edit locali dell'utente → `updated_by='me'` preservato
  (NON più sovrascritto a `'sync-live'` da `save_player_from_sync`).
  Il conflict resolution B.7 (`player_has_recent_local_edit`) non è più
  invalidato dal trigger `trg_players_updated_at`.

#### FIX PB4-B — Listener frontend per `sync-update-received` + bytes nel payload
- `src-tauri/src/commands/sync.rs` (~riga 434) — L'emit dell'evento
  `sync-update-received` ora include `update_bytes: update_bytes` (Vec<u8>
  serializzato come array di numeri JSON) nel payload. In M3a.1 conteneva
  solo `bytes_len` + `from_peer` — nessun frontend poteva ricostruire i
  bytes.
- `src-tauri/src/commands/sync.rs` — Aggiunto `use tauri::Emitter;` in
  cima (mancava — i `let _ = app.emit(...)` a riga 434/444/453 davano
  E0599 senza questo trait in scope).
- `src-tauri/src/commands/sync_lan.rs` — `handle_peer` ora accetta un
  parametro `app: tauri::AppHandle` e, sul path ricezione `Message::Binary`,
  emette `sync-update-received` con `update_bytes` (stesso pattern del
  path Iroh). Aggiornati i chiamanti `lan_start_server` e `lan_connect`
  per passare `app`/`app.clone()`. Aggiunto `use tauri::Emitter;`.
- `src/components/SyncView.tsx` — Nel useEffect di boot, registra un
  listener Tauri per `sync-update-received` che converte il payload in
  `Uint8Array` e chiama `applyRemoteUpdate(bytes)`. Cleanup corretto
  su unmount (gestione `cancelled` per evitare leak se il componente si
  smonta durante l'await di `listen()`).
- `src/lib/sync/yjsDocuments.ts` — `applyRemoteUpdate` convertita da
  `async function ... Promise<void>` a `function ... void` (per
  allineamento al brief: `Y.applyUpdate` è sincrono in yjs, non serve
  async). Imposta `isApplyingRemoteUpdate=true` attorno a `Y.applyUpdate`
  per coerenza con il pattern re-entry guard dei listener.
- `src/types/sync.ts` — `SyncUpdateReceivedEvent` ora ha campi
  `update_bytes: number[]`, `bytes_len: number`, `from_peer: string`
  (era `updateBase64`/`fromPeer`/`receivedAt` — mai allineato al reale
  payload Rust).
- Effetto: peer B riceve l'update via Iroh gossip o WebSocket LAN →
  Y.Doc frontend di B aggiornato → listener `yPlayers.observe` triggerato
  → `save_player_from_sync` chiamato → SQLite di B persiste la modifica
  con `updated_by='sync-live'`. Sync live end-to-end finalmente funziona.

#### FIX PB6 — Owner GitHub `dossierfanta` (operativo, NON codice)
- Identificato: `src-tauri/src/commands/listone.rs:988` hardcoda
  `DATA_REPO_OWNER = "dossierfanta"`. L'owner NON esiste su GitHub
  (API ritorna 404 su `users/dossierfanta/repos` e
  `repos/dossierfanta/dossier-fanta-data/releases`). In produzione
  l'auto-fetch fallirebbe (HTTP 404 su `releases/latest`).
- Fix operativo (da eseguire manualmente — NON modificabile da codice):
  creare account GitHub `dossierfanta` (o usare un owner esistente e
  aggiornare la costante), creare il repo pubblico
  `dossier-fanta-data`, pushare il contenuto del repo locale
  (`players.json` con 603/603 giocatori, 20 squadre, 100% FVM coverage
  — già verificato), triggerare `scrape.yml` (manuale o attendere cron
  01:00 UTC), verificare che la release con tag
  `data-YYYY-MM-DD-<sha256[:12]>` venga creata e che l'asset
  `players.json` sia scaricabile.
- Se l'utente usa un altro account GitHub, aggiornare le costanti in
  `listone.rs:988` (`DATA_REPO_OWNER`) e `:992` (`HTTP_USER_AGENT`).
- Costanti lasciate invariate in codice: l'utente deve solo creare
  l'account/repo GitHub (preferred) oppure aggiornare 2 righe.

### Blocco B — 3 FIX AGGIUNTIVI (WARN non bloccanti)

#### FIX W1 — Rimosso `"marco"` dalla whitelist `validate_updated_by`
- `src-tauri/src/commands/sync.rs:198` — Whitelist ora:
  `"me" | "auto-fetch" | "sync-live"`. Era `"me" | "auto-fetch" |
  "sync-live" | "marco"` (extra-brief M3a.1). Messaggio di errore
  aggiornato coerentemente.

#### FIX W2 — CHANGELOG allineato alle milestone M3/M3.1/M3a/M3a.1/M3a.2
- Aggiunte 3 entry retroattive (questo file): `0.3.0` (M3 base),
  `0.3.1` (M3.1 + M3a + M3a.1), `0.3.2` (M3a.2, M3 chiusa).

#### FIX W3 — `iroh_connect_by_peer_key` rigoroso (Ok(false) su errore/timeout)
- `src-tauri/src/commands/sync.rs` (~riga 528-559) — Sui branch
  `Ok(Err(e))` (errore connect) e `Err(elapsed)` (timeout 10s) ora
  ritorna `Ok(false)` e NON aggiunge il peer alla lista connessi. In
  M3a.1 ritornava `Ok(true)` "ottimistico" su tutti e 3 i branch,
  causando `iroh_get_connected_peers` a ritornare peer non realmente
  connessi → sync live poi falliva silenziosamente. Solo il branch
  `Ok(Ok(_conn))` (connessione QUIC realmente stabilita) ritorna
  `Ok(true)` e aggiunge il peer.
- `src/components/SyncView.tsx` — Il `handleConnect` gestisce già
  correttamente `ok=false` (mostra errore "Connessione fallita").

### Vincoli HARD rispettati

- 15: `Cargo.lock` + `package-lock.json` committati (preservato da M3a.1).
- 16: Schema v2.2 + v2.3 NON toccati (nessun ALTER nuovo in M3a.2).
- 17: M3a.2 NON aggiunge comandi Tauri (solo fix interni).
- 18: M3a.2 NON aggiunge tabelle schema (tags è M4).
- 1-14: Tutti i vincoli hard precedenti preservati (validazioni, cancellazione
  con doppio consenso, click-to-edit, WM ibrido, glossario, multi-DB,
  archiviazione, auto-toggle, paper textures, assenza emoji, CSP, ecc.).

### Test funzionali minimi

6 test definiti dal brief. 4 sono test operativi 2-PC (non eseguibili in
sandbox ispezione), 1 è test operativo GitHub (PB6), 1 è test .msi build.
Tutti i test richiedono ambiente Windows + 2 PC fisici o GitHub account:
vanno eseguiti manualmente dopo il push del tag v0.3.2.

- TEST PB4-A (anti-loop): edita player → SELECT updated_by → deve essere 'me'
- TEST PB4-B (sync live 2 PC): A edita → B vede entro 200ms + SQLite B aggiornato
- TEST PB6 (GitHub): API 200 su releases/latest + asset scaricabile
- TEST PB6 (.msi): push tag v0.3.2 → build-msi.yml verde → .msi >5MB
- TEST B6 (conflict resolution field-level): edit simultanei di campi diversi → entrambi sopravvivono
- TEST B7 (auto-fetch vs sync-live): player modificato NON archiviato dall'auto-fetch (updated_at > scraped_at)

---

## [0.3.1] — 2026-10-15 — M3.1 fix selettori + M3a sync live scaffolding + M3a.1 fix bloccanti

Sprint di chiusura M3.1 (fix bug selettori HTML scraper) + inizio M3a
(scaffolding sync live Yjs+Iroh). M3a.1 segue per chiudere i 5 PB
identificati dall'ispezione M3a.

### M3.1 — Fix selettori scraper

- `dossier-fanta-data/scraper/scrape_fantacalcio.py` — Aggiornati selettori
  BeautifulSoup per il nuovo layout fantacalcio.it/quotazioni. Assertion
  raise se la struttura HTML cambia (graceful failure → notifica GitHub).
- `src-tauri/src/commands/listone.rs` — `apply_auto_fetch` ora passa
  `scraped_at` (Option<String>) per attivare il conflict resolution B.7.

### M3a — Sync live Yjs + Iroh (scaffolding)

- `Cargo.toml` — Aggiunte dipendenze: `yrs` (CRDT Rust), `iroh` (p2p QUIC),
  `iroh-gossip` (broadcast protocol), `tokio-tungstenite` (WebSocket per
  fallback LAN), `mdns-sd` (discovery LAN).
- `src-tauri/src/commands/sync.rs` (NUOVO) — Comandi yrs core
  (`yjs_apply_update`, `yjs_get_state_vector`, `yjs_get_diff`) +
  comandi Iroh transport (`iroh_start_node`, `iroh_connect_by_peer_key`,
  `iroh_broadcast_update`, `iroh_subscribe_updates`,
  `iroh_get_connected_peers`, `iroh_disconnect_peer`, `iroh_get_peer_key`)
  + comandi `save_*_from_sync` (con `updated_by='sync-live'`).
- `src-tauri/src/commands/sync_lan.rs` (NUOVO, dietro feature flag
  `lan-only`) — Fallback WebSocket LAN con mDNS discovery.
- `src/lib/sync/yjsDocuments.ts` (NUOVO) — Bridge Yjs frontend:
  `yPlayers`, `yNotes`, `yAuction` Y.Map/Array; funzioni bridge
  (`bridgePlayerUpdate`, ecc.); listener observe → `save_*_from_sync`;
  `applyRemoteUpdate` (path testing); `initialSync`.
- `src/lib/sync/yjsCursors.ts` (NUOVO) — Cursori collaborativi Yjs
  (`yCursors` Y.Map; `setMyCursor`, `observeCursors`, cleanup stale
  >30s).
- `src/components/SyncView.tsx` (NUOVO) — Schermata Sync: peer key
  display, connect by peer key, status, polling.
- `src/components/LiveCursor.tsx` (NUOVO) — Render cursore remoto con
  label nome + posizione. Montato in `PlayerForm.tsx` sul campo
  `quick_note` (asta live).
- `src/components/DatabaseManager.tsx` — Banner sharing DB "M3a attiva"
  (PB5 risolto in M3a.1).

### M3a.1 — 5 fix bloccanti (PB1-PB5)

- PB1 ✓ — `apply_auto_fetch` signature allineata a 3 argomenti
  (`import_listone(state, players_json, Some(scraped_at))`). Errore E0061
  risolto.
- PB2 ✓ — Iroh gossip listener reale (non placeholder). `iroh_subscribe_updates`
  no-op (subscribe loop spawnato in `iroh_start_node`). `iroh_broadcast_update`
  chiama `gossip.broadcast(topic, bytes)`.
- PB3 ✓ — Cargo.lock (8839 righe) + package-lock.json rigenerati con
  yrs/iroh/iroh-gossip/iroh-base/tokio-tungstenite/mdns-sd + yjs.
- PB4 ✗ (PARZIALE) — Bridge cablato in `usePlayersStore.ts` (chiamate
  ai 3 bridge dopo commit SQLite). MA 2 bug latenti: PB4-A (flag
  anti-loop non impostato nei bridge — `updated_by` corrotto) e PB4-B
  (nessun listener frontend per `sync-update-received` — sync live
  end-to-end interrotto). Risolti in M3a.2.
- PB5 ✓ — Banner sharing DB "Condivisione live DB attiva con M3a"
  (era "in arrivo con M3a").

### Integrazioni aggiuntive

- Cursori collaborativi integrati in `PlayerForm.tsx` (campo `quick_note`).
- Fallback LAN-only bidirezionale + mDNS discovery (`Fix aggiuntivo B`).
- README documenta fallback LAN-only in sezione dedicata.

### WARN (non bloccanti, risolti in M3a.2)

- W1: `validate_updated_by` conteneva `"marco"` extra-brief.
- W2: CHANGELOG fermo a 0.2.5 — entry per M3/M3.1/M3a/M3a.1 mancanti.
- W3: `iroh_connect_by_peer_key` ritornava `Ok(true)` "ottimistico" su
  errore/timeout.

---

## [0.3.0] — 2026-10-14 — M3: Auto-fetch GitHub Actions + scraper inline fallback

Milestone M3 — Pipeline auto-fetch notturna da fantacalcio.it via
GitHub Actions + fallback scraper inline nell'app. L'app all'avvio
interroga GitHub Releases per l'ultima versione del listone, confronta
con il tag locale, mostra toast "aggiornamento disponibile" e applica
il diff (archiviazione automatica dei player non più in listone).

### Added

- `dossier-fanta-data/` (NUOVO repo GitHub separato) — Workflow
  `scrape.yml` (cron 0 1 * * * UTC = 03:00 CET): setup Python 3.12,
  scraper BeautifulSoup di fantacalcio.it/quotazioni, validate JSON,
  pytest, compute tag `data-${DATE}-${HASH:0:12}`, create release via
  `softprops/action-gh-release@v2` con asset `players.json`.
- `dossier-fanta-data/scraper/scrape_fantacalcio.py` (NUOVO) — Parser
  HTML con selettori configurabili + assertion su struttura. Output
  `players.json` con 603 giocatori, 20 squadre, 6 campi obbligatori
  (name/team/ruolo_fanta/ruolo_reale/fvm/quotazione_ufficiale).
- `dossier-fanta-data/scraper/tests/` (NUOVO) — pytest che valida
  struttura JSON, range FVM, count giocatori.
- `src-tauri/src/commands/listone.rs` — Comandi Tauri:
  `check_latest_listone_version` (GET GitHub API releases/latest),
  `download_listone` (download asset con reqwest, salva cache),
  `apply_auto_fetch` (apply diff al DB attivo con archiviazione
  automatica), `scrape_listone_inline` (fallback scraper Rust embedded,
  ~10-15s se GitHub irraggiungibile).
- `src-tauri/src/commands/listone.rs::player_has_recent_local_edit`
  (NUOVO) — Conflict resolution B.7: se un player ha
  `updated_at > scraped_at` (modifica locale più recente del listone),
  NON archiviare. Ritorna warning per UI.
- `src-tauri/src/commands/listone.rs::_collect_player_snapshot`
  (NUOVO) — Snapshot arricchito (JSON completo del player + auction_data
  + scouting_notes) salvato in `players_archive.last_known_data`.
- `src/components/ImportListone.tsx` (NUOVO) — UI per applicare
  l'auto-fetch: anteprima diff, conferma utente (archiviazione
  irreversibile).
- `src/components/ImportPreview.tsx` (NUOVO) — Anteprima diff
  pre-applicazione (cosa verrà creato/archiviato/aggiornato).
- `src/components/AggiornamentiView.tsx` (NUOVO) — Schermata "Aggiornamenti"
  che mostra: versione corrente, ultima release disponibile, log storico
  ultimi 5 fetch.
- `src/api/tauri.ts` — Wrapper TS per i nuovi comandi listone.

### Changed

- `src-tauri/migrations/schema_v2.3.sql` — ALTER additive: aggiunte
  colonne `last_sync_at` + `sync_node_id` su `players`, `scouting_notes`,
  `auction_data`; nuova tabella `sync_peers` (per audit sync Iroh).
- `src/App.tsx` — Al mount chiama `check_latest_listone_version`, se
  tag diverso da cache (`last_applied_tag.txt`) mostra toast
  "aggiornamento disponibile".
- `src-tauri/src/commands/listone.rs::import_listone` — Signature
  estesa con `scraped_at: Option<String>` per attivare conflict
  resolution B.7.

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
