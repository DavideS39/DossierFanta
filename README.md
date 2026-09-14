# DossierFanta v2.2 — Milestone M1

App desktop Windows nativa per gestione rosa fantacalcio. **M1: base offline funzionante.**

> *"Come un taccuino da scout: si porta in campo, non ha bisogno di rete. Ma quando c'è, parla col gemello."*

---

## Stato M1

| Requisito | Stato |
|---|---|
| Tauri 2.0 + React + TypeScript + Vite | ✅ |
| SQLite locale con schema v2.2 (file `mio.db`) | ✅ |
| Zustand per state management (no Redux) | ✅ |
| Tailwind CSS + CSS custom (tema base taccuino) | ✅ |
| Comandi Tauri Rust per tutte le operazioni DB | ✅ |
| Schema v2.2 applicato tale e quale (vedi `src-tauri/migrations/schema_v2.2.sql`) | ✅ |
| CRUD giocatore (create / read / update / delete con conferma) | ✅ |
| Vista Rosa con lista + ricerca testuale + filtro ruolo | ✅ |
| Form giocatore con campi `name, team, pos_fanta, pos_real, fascia, priority, fmil_spesi, med, medv, fvm` | ✅ |
| App si avvia offline, crea DB, schema applicato | ✅ verificato |
| Build `.deb` (Linux) | ✅ `download/DossierFanta_0.1.0_amd64.deb` |
| Build `.msi` (Windows) | ⚙️ richiede build su Windows — vedi §"Build .msi per Windows" |

---

## Stack

| Componente | Versione | Ruolo |
|---|---|---|
| Tauri | 2.x | Shell desktop, IPC con Rust core |
| Rust | 1.77+ | Core logic, SQLite, comandi esposti al frontend |
| React | 18 | UI nel WebView |
| TypeScript | 5 | Tipizzazione frontend |
| Vite | 5 | Bundler, dev server |
| Tailwind | 3.4 | Styling utility-first + CSS custom |
| Zustand | 4.5 | State management |
| rusqlite | 0.32 | Driver SQLite (feature `bundled`: SQLite compilato dentro il binario) |
| tauri-plugin-log | 2.x | Logging |

### Nota architetturale: `rusqlite` vs `tauri-plugin-sql`

Lo specifica v2.2 menzionava `tauri-plugin-sql` come bridge SQLite. Tuttavia, il requisito HARD *"Comandi Tauri in Rust per tutte le operazioni DB (no fetch HTTP diretta dal frontend)"* è in tensione con `tauri-plugin-sql`, che espone un'API JS diretta per eseguire SQL arbitrario dal frontend.

La scelta presa in M1: **usare `rusqlite` direttamente in Rust**. Tutte le query SQL vivono dentro comandi Rust tipizzati (`src-tauri/src/commands/players.rs`). Il frontend non scrive mai SQL: invoca solo comandi Rust tramite `@tauri-apps/api/core::invoke`.

Vantaggi:
- Sicurezza: il frontend non può eseguire SQL arbitrario
- Tipizzazione: i parametri e i risultati passano per struct Rust serializzate via serde
- Validazione: ogni comando valida input lato Rust prima di toccare il DB
- Audit: tutte le scritture passano per un singolo punto (i comandi)

---

## Struttura del progetto

```
dossierfanta-m1/
├── src/                          # Frontend React + TS
│   ├── App.tsx                   # Root: avvia DB, mostra splash, renderizza RosaView
│   ├── main.tsx                  # Entry ReactDOM
│   ├── index.css                 # Tailwind + CSS custom (tema taccuino base)
│   ├── api/
│   │   └── tauri.ts              # Wrapper invoke per tutti i comandi Rust
│   ├── types/
│   │   └── player.ts             # Tipi TS mirror delle struct Rust
│   ├── stores/
│   │   ├── usePlayersStore.ts    # Zustand: lista + filtri + azioni CRUD
│   │   └── useDbMetaStore.ts     # Zustand: metadati DB (path, conteggi)
│   ├── lib/
│   │   └── format.ts             # Formattatori f₥ / M / MV / FVM + palette colori
│   └── components/
│       ├── RosaView.tsx          # Vista principale: header + stats + toolbar + lista
│       ├── PlayerList.tsx        # Griglia di card responsive
│       ├── PlayerCard.tsx         # Card singolo giocatore (f₥, M, MV, FVM badge)
│       ├── PlayerForm.tsx         # Modal di creazione/modifica
│       ├── DeleteConfirmDialog.tsx  # Conferma cancellazione (con checkbox esplicito)
│       ├── SearchBar.tsx         # Input ricerca con debounce 250ms
│       ├── RoleFilter.tsx        # Chips filtro ruolo P/D/C/A
│       └── StatsBar.tsx          # Conteggi + info DB
├── src-tauri/                    # Backend Rust
│   ├── Cargo.toml
│   ├── tauri.conf.json           # Config Tauri (finestra, bundle, wix/nsis)
│   ├── build.rs                  # tauri-build
│   ├── capabilities/default.json # Permessi frontend
│   ├── migrations/
│   │   └── schema_v2.2.sql       # Schema SQLite v2.2 (allegato, NON modificato)
│   ├── icons/                    # Icona taccuino generata (.ico/.icns/.png)
│   └── src/
│       ├── main.rs                # Entry point
│       ├── lib.rs                 # Setup Tauri + init DB PRIMA della webview
│       ├── db.rs                  # open_and_migrate() + new_uuid()
│       └── commands/
│           ├── mod.rs             # AppError + AppResult
│           ├── database.rs        # init_db, get_db_info
│           └── players.rs         # list_players, create, update, delete, count, archive
├── package.json
├── tsconfig.json
├── vite.config.ts
├── tailwind.config.js
├── postcss.config.js
├── index.html
└── README.md                     # Questo file
```

---

## Sviluppo locale

### Prerequisiti

- **Node.js** 18+ e npm
- **Rust** toolchain (`rustup`, stable channel)
- **Tauri 2 CLI**: `npm install` lo installa come dev-dep nel progetto
- Su Windows: **WebView2 Runtime** (preinstallato su Win10+, altrimenti scarica da Microsoft)
- Su Linux: `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `librsvg2-dev`, `pkg-config`, `build-essential`

### Avvio in dev mode

```bash
# Dal root del progetto
npm install
npm run tauri:dev
```

Questo avvia:
1. Vite dev server su `http://127.0.0.1:1420`
2. Compila il binario Rust in debug mode
3. Apre la finestra desktop con WebView2/WebKit

Al primo avvio:
- Viene creata la directory `app_data_dir` (vedi sotto per percorso)
- Viene creato `mio.db` e applicato lo schema v2.2 (10 tabelle + vista + 2 trigger + 3 preset)
- L'app è immediatamente usabile offline

### Path del DB `mio.db` per OS

| OS | Path |
|---|---|
| Windows | `C:\Users\<user>\AppData\Roaming\com.dossierfanta.app\mio.db` |
| Linux | `~/.local/share/com.dossierfanta.app/mio.db` |
| macOS | `~/Library/Application Support/com.dossierfanta.app/mio.db` |

---

## Build

### Build `.deb` (Linux)

```bash
npm run tauri:build
# Output: src-tauri/target/release/bundle/deb/DossierFanta_0.1.0_amd64.deb
```

### Build `.msi` per Windows

La build `.msi` richiede un host Windows con i seguenti prerequisiti:

1. **Windows 10/11** (x86_64)
2. **Microsoft Visual Studio C++ Build Tools** o Visual Studio con workload "Desktop development with C++"
3. **WebView2 Runtime** (preinstallato su Win10+; su Win10 vecchio scarica da https://developer.microsoft.com/microsoft-edge/webview2/)
4. **Rust** toolchain con target `x86_64-pc-windows-msvc`:
   ```powershell
   rustup default stable-x86_64-pc-windows-msvc
   ```
5. **WiX Toolset** v3.11+ — Tauri lo scarica e installa automaticamente al primo `tauri build` su Windows. In alternativa scaricalo manualmente da https://wixtoolset.org/.
6. **Node.js** 18+ e npm

Procedura:

```powershell
git clone <repo>
cd dossierfanta-m1
npm install
npm run tauri:build
```

Output:
- `src-tauri/target/release/dossierfanta.exe` (binario standalone, 5-6 MB)
- `src-tauri/target/release/bundle/msi/DossierFanta_0.1.0_x64_en-US.msi` (installer .msi)
- `src-tauri/target/release/bundle/nsis/DossierFanta_0.1.0_x64-setup.exe` (installer alternativo NSIS)

### Build `.app` (macOS, opzionale)

```bash
npm run tauri:build
# Output: src-tauri/target/release/bundle/macos/DossierFanta.app
# + src-tauri/target/release/bundle/dmg/DossierFanta_0.1.0_x64.dmg
```

---

## Build automatico con GitHub Actions

Il progetto include 3 workflow in `.github/workflows/`:

| Workflow | Trigger | Cosa fa |
|---|---|---|
| `ci.yml` | Ogni push/PR su `main` | `cargo check` + `cargo test` (smoke test M1) + `tsc --noEmit` + `vite build`. Veloce (~2-3 min), niente bundle. |
| `build.yml` | Push su `main` (solo src cambiata) o `workflow_dispatch` manuale | Builda bundle per Windows (.msi/.exe), Linux (.deb/.AppImage), macOS (.dmg/.app). Upload come artefatti GitHub (30 giorni retention). |
| `release.yml` | Push di tag `v*` (es. `v0.1.0`) o `workflow_dispatch` con input tag | Builda per tutte e 3 le piattaforme e crea una GitHub Release con asset auto-allegati + changelog generato. |

### Setup

1. Crea un repo su GitHub e pusha il progetto:
   ```bash
   git init
   git add .
   git commit -m "feat: DossierFanta M1 — base offline"
   git branch -M main
   git remote add origin git@github.com:<user>/dossierfanta.git
   git push -u origin main
   ```

2. (Opzionale) Build manuale: GitHub → Actions → "Build" → "Run workflow". Dopo ~10 min, scarica gli artefatti dalla pagina di esecuzione.

3. Per creare una release pubblica:
   ```bash
   # bump versione e crea tag
   ./scripts/release.sh 0.1.0
   git push origin main
   git push origin v0.1.0
   ```
   Il workflow `release.yml` builda e pubblica la release su GitHub in ~15 min.

### Code signing Windows (opzionale, raccomandato per distribuzione pubblica)

Di default l'.msi è non firmato → Windows SmartScreen avviserà gli utenti. Per firmare:

1. Registra un account [Azure Trusted Signing](https://learn.microsoft.com/en-us/azure/trusted-signing/) o usa un certificato EV
2. Configura i secrets nel repo GitHub (Settings → Secrets and variables → Actions):
   - `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`, `AZURE_CERTIFICATE_PROFILE_NAME`
   - `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (per auto-update)
3. Il workflow `release.yml` firma automaticamente quando i secrets sono presenti

### Costi GitHub Actions

- **Repo pubblici**: minuti illimitati su tutti i runner (windows-latest, ubuntu, macos) — gratis
- **Repo privati**: 2000 minuti/mese gratuiti (Windows conta 2×, macOS 10×). Una build completa (3 OS) usa ~30 minuti equivalenti.

---

## Comandi Rust esposti al frontend

Tutti i comandi sono definiti in `src-tauri/src/commands/`. Il frontend li invoca tramite `@tauri-apps/api/core::invoke`.

| Comando | Input | Output | Descrizione |
|---|---|---|---|
| `init_db` | — | `String` (path) | Inizializza il DB (idempotente). Ritorna il path di `mio.db`. |
| `get_db_info` | — | `DbInfo` | Metadati: path, versione schema, conteggio giocatori attivi/archiviati. |
| `list_players` | `filters?: ListFilters` | `Player[]` | Lista giocatori con filtri opzionali: search, pos_fanta, status, fascia, paginazione. Ordinamento: priority DESC, name ASC. |
| `count_players` | `filters?: ListFilters` | `i64` | Conteggio con stessi filtri di `list_players`. |
| `create_player` | `CreatePlayerInput` | `Player` | Crea nuovo giocatore. UUID v4 generato lato Rust. `db_id` = "default-personal". |
| `update_player` | `UpdatePlayerInput` | `Player` | Aggiorna giocatore (full replace dei campi editabili). |
| `delete_player` | `id: String` | `bool` | **Elimina esplicita**. Il frontend DEVE confermare con dialog (vedi `DeleteConfirmDialog`). |
| `archive_player` | `id, reason?` | `bool` | Sposta in `players_archive` (non distruttivo). |
| `list_archive` | `search?, limit?` | `JsonValue[]` | Elenca giocatori archiviati. |

### Vincoli rispettati

- ✅ **Niente cancellazioni automatiche** — `delete_player` è l'unico modo per rimuovere. Il frontend deve mostrare `DeleteConfirmDialog` con checkbox esplicito prima di chiamarlo.
- ✅ **`players_archive` separata** — i giocatori non più in Serie A vengono spostati (non flaggati). Recuperabili.
- ✅ **Simbolo f₥** — Unicode U+20A5 (Mill Sign), renderizzato via `FMIL_SYMBOL` in `src/lib/format.ts`.
- ✅ **Terminologia disambiguata** — `fmil_spesi` (f₥), `med` (M), `medv` (MV), `fvm` (FVM). Etichette distinte in UI.
- ✅ **Schema esattamente come allegato** — `src-tauri/migrations/schema_v2.2.sql` è identico al file `schema_v2.2.sql` fornito. Applicato via `include_str!()` senza modifiche.

---

## Test

Il test end-to-end `src-tauri/tests/m1_smoke_test.rs` verifica (offline, senza UI):

1. `open_and_migrate()` crea il file DB
2. Schema v2.2 applicato (10 tabelle + 1 vista + 2 trigger + 3 preset)
3. Database di default "mio.db" inizializzato (id="default-personal")
4. CRUD giocatore completo (create, read, update, delete)
5. Trigger `trg_players_updated_at` funziona (aggiorna `updated_at` automaticamente)
6. Filtro per `pos_fanta` e search case-insensitive
7. Archiviazione non-distruttiva
8. Validazione vincoli CHECK (priority 0-5, med/medv 0-10, pos_fanta enum)

Esecuzione:

```bash
cd src-tauri
cargo test --test m1_smoke_test -- --nocapture
```

Output atteso: `1 passed; 0 failed`.

---

## Out of scope per M1 (NON implementato)

- ❌ Multi-DB workspace (M2)
- ❌ Switcher DB + UI taccuino completa (M2)
- ❌ Sync live Yjs + Iroh p2p (M3a)
- ❌ Auto-fetch GitHub Actions (M3)
- ❌ Sync BT BLE / Classic (M4 / M4a)
- ❌ Oracolo v2 (M5)
- ❌ Piano Rosa v3 + Pressione Mercato (M6)
- ❌ Tema taccuino completo (M2) — in M1 c'è styling base ma pulito

---

## Troubleshooting

### Linux: `error: linking with cc failed: unable to find library -lgdk-3`

Installare i dev packages:
```bash
sudo apt-get install libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev \
  libayatana-appindicator3-dev libssl-dev pkg-config build-essential
```

### Linux: WebKit non trova `WebKitNetworkProcess`

WebKit cerca i process binaries in `/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/`. Se assenti, installare `libwebkit2gtk-4.1-0`. Su ambienti headless (CI), usare `xvfb-run`.

### Windows: `error: failed to run custom build command for tauri-build`

Verificare che Microsoft Visual Studio C++ Build Tools siano installati con il workload "Desktop development with C++".

### Windows: `WebView2Loader.dll not found`

Scaricare e installare WebView2 Runtime da https://developer.microsoft.com/microsoft-edge/webview2/.

### Windows: WiX non trovato al primo `tauri build`

Tauri scarica WiX automaticamente. Se fallisce, scaricarlo manualmente da https://wixtoolset.org/releases/v3.11/stable e installare in `C:\Program Files (x86)\WiX Toolset v3.11\`. Aggiungere `C:\Program Files (x86)\WiX Toolset v3.11\bin` al PATH.

---

## Glossario (dal design doc v2.2)

| Simbolo | Significato |
|---|---|
| **f₥** | Fantamilioni (Unicode U+20A5, valuta della lega). Es: f₥ 78. |
| **M** | Med — media voto pura senza bonus, range 0-10. |
| **MV** | MedV — FantaMedia con bonus/malus, range 0-10. |
| **FVM** | FantaValoreMedio — valore di mercato da listone auto-fetch. |
| **Fascia** | Top / Semitop / Medio / Regolarista / Scommessa |
| **Archiviazione** | Spostamento in `players_archive` (non flag, non distruttivo) |

---

## Licenza

© 2026 DossierFanta. Codice privato.
