//! DossierFanta v2.2 — Tauri 2.0 backend (M2).
//!
//! Architettura (M2 — multi-DB workspace):
//! - `DbState` contiene una `HashMap<String, Connection>`: una connessione per
//!   ogni database logico caricato nel workspace. Tutte le connessioni sono
//!   aperte sullo stesso file `mio.db` (lo schema v2.2 ha la tabella `databases`
//!   interna con FK da `players.db_id`), quindi il multi-DB è LOGICO, non fisico.
//! - `active_db_id: Mutex<String>` indica quale DB logico è attivo nella vista
//!   Rosa. Lo switch è una semplice mutazione del mutex, senza riaprire conn.
//! - I comandi `players::*` prendono un `db_id: Option<String>` esplicito:
//!   se `None`, usano l'`active_db_id`. Le query filtrano sempre per `db_id`.
//! - I comandi write (`create_player`, `update_player`, `delete_player`) fanno
//!   un `ensure_writable_db` check: rifiutano scritture su DB di tipo `listone`.
//! - Lo schema `migrations/schema_v2.2.sql` è embedded via `include_str!` e
//!   applicato al primo avvio. Lo schema NON è toccato in M2 (vincolo HARD).
//! - Il frontend NON esegue SQL diretto: ogni accesso passa per i comandi.
//!
//! Nota architetturale (M1, mantenuta in M2): si usa `rusqlite` direttamente
//! in Rust invece di `tauri-plugin-sql` — questo per rispettare il vincolo HARD
//! "Comandi Tauri in Rust per tutte le operazioni DB" (v. README M1).

pub mod commands;
pub mod db;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::Connection;

use crate::commands::AppError;

/// Stato condiviso tra i comandi Tauri (M2 — multi-DB workspace).
///
/// - `connections`: mappa `db_id → Connection`. Una entry per ogni riga della
///   tabella `databases`. Tutte le connessioni puntano allo stesso file
///   SQLite (`mio.db`); la distinzione tra DB è logica (via `db_id` su ogni
///   riga di `players`), ma manteniamo una connessione per DB per onorare
///   il commento architetturale M1 "HashMap<String, Connection>" e preparare
///   il terreno per DB fisici separati in M3 (listone auto-fetch).
/// - `active_db_id`: il `db_id` attivo nella vista Rosa. Switch istantaneo.
/// - `db_path`: path del file SQLite (cached per `create_database` ecc.).
pub struct DbState {
    pub connections: Mutex<HashMap<String, Connection>>,
    pub active_db_id: Mutex<String>,
    pub db_path: Mutex<PathBuf>,
}

impl DbState {
    /// Esegue `f` con la connessione associata a `db_id`. Errore se il DB
    /// non è caricato nella mappa (es. eliminato o mai creato).
    pub fn with_conn<F, R>(&self, db_id: &str, f: F) -> Result<R, AppError>
    where
        F: FnOnce(&Connection) -> Result<R, AppError>,
    {
        let map = self
            .connections
            .lock()
            .map_err(|e| AppError::Generic(format!("Mutex connections: {}", e)))?;
        let conn = map.get(db_id).ok_or_else(|| {
            AppError::NotFound(format!("DB id={} non caricato nel workspace", db_id))
        })?;
        f(conn)
    }

    /// Restituisce il `db_id` attualmente attivo.
    pub fn active_db_id(&self) -> Result<String, AppError> {
        self.active_db_id
            .lock()
            .map_err(|e| AppError::Generic(format!("Mutex active_db_id: {}", e)))
            .map(|g| g.clone())
    }

    /// Imposta il `db_id` attivo (dopo aver verificato che esista).
    pub fn set_active_db_id(&self, id: String) -> Result<(), AppError> {
        let mut guard = self
            .active_db_id
            .lock()
            .map_err(|e| AppError::Generic(format!("Mutex active_db_id: {}", e)))?;
        *guard = id;
        Ok(())
    }
}

/// Risolve il path di `app_data_dir` PRIMA che Tauri venga inizializzato.
/// Necessario perché in Tauri 2.0 le finestre da `tauri.conf.json` vengono
/// create PRIMA del setup() callback, e se la webview fallisce (es. WebKit
/// senza process binaries in alcuni ambienti Linux headless), setup() non
/// viene mai chiamato e il DB non verrebbe inizializzato.
///
/// Usa la crate `dirs` che risolve i path secondo le convenzioni di piattaforma:
/// - Linux: `$XDG_DATA_HOME/com.dossierfanta.app/` o `~/.local/share/com.dossierfanta.app/`
/// - Windows: `%APPDATA%/com.dossierfanta.app/`
/// - macOS: `~/Library/Application Support/com.dossierfanta.app/`
fn resolve_app_data_dir_early() -> std::path::PathBuf {
    use std::path::PathBuf;

    let base = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("com.dossierfanta.app")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // === Inizializzazione DB PRIMA di Tauri ===
    // Garantisce che mio.db esista prima che la webview venga inizializzata,
    // e che lo schema v2.2 sia applicato anche se Tauri non riesce ad avviare la UI.
    let app_data_dir = resolve_app_data_dir_early();
    if let Err(e) = std::fs::create_dir_all(&app_data_dir) {
        eprintln!("FATAL: cannot create app_data_dir {}: {}", app_data_dir.display(), e);
        std::process::exit(1);
    }
    let db_path = app_data_dir.join("mio.db");

    eprintln!("[DossierFanta] app_data_dir = {}", app_data_dir.display());
    eprintln!("[DossierFanta] DB path = {}", db_path.display());

    // Apri la connessione principale e applica lo schema v2.2 se primo avvio.
    let main_conn = match db::open_and_migrate(&db_path) {
        Ok(c) => {
            eprintln!("[DossierFanta] DB init OK, schema v2.2 applied");
            c
        }
        Err(e) => {
            eprintln!("FATAL: DB init failed: {}", e);
            std::process::exit(1);
        }
    };

    // === Setup multi-DB workspace ===
    // Carica tutti i DB logici (righe di `databases`) aprendo una connessione
    // per ciascuno. In M2 tutte le connessioni puntano allo stesso file mio.db,
    // ma la struttura permette di estendere a file separati in M3 (listone).
    let mut connections: HashMap<String, Connection> = HashMap::new();
    let active_db_id: String = {
        let mut stmt = match main_conn.prepare("SELECT id FROM databases ORDER BY created_at ASC") {
            Ok(s) => s,
            Err(e) => {
                eprintln!("FATAL: cannot read databases table: {}", e);
                std::process::exit(1);
            }
        };
        let ids: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .ok()
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default();

        if ids.is_empty() {
            // Should not happen — schema inserts 'default-personal'. Fallback.
            eprintln!("[DossierFanta] WARN: no databases rows found, using default-personal");
            "default-personal".to_string()
        } else {
            ids[0].clone()
        }
    };

    // Apri una connessione per ogni DB logico (tutte sullo stesso file mio.db).
    // La prima (default-personal) è già `main_conn`; le altre vengono aperte qui.
    {
        let mut stmt = match main_conn.prepare("SELECT id FROM databases") {
            Ok(s) => s,
            Err(e) => {
                eprintln!("FATAL: cannot enumerate databases: {}", e);
                std::process::exit(1);
            }
        };
        let ids: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .ok()
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default();

        for id in &ids {
            if id == "default-personal" {
                connections.insert(id.clone(), db::clone_conn(&main_conn, &db_path));
            } else {
                match db::open_db_file(&db_path) {
                    Ok(c) => {
                        connections.insert(id.clone(), c);
                    }
                    Err(e) => {
                        eprintln!(
                            "[DossierFanta] WARN: cannot open conn for db_id={}: {}",
                            id, e
                        );
                    }
                }
            }
        }
    }
    // Move main_conn into the map for default-personal (replaces the clone above
    // — the clone is just to keep main_conn alive during the loop). We end up
    // with one Connection per db_id; default-personal uses the original main_conn.
    connections.insert("default-personal".to_string(), main_conn);

    eprintln!(
        "[DossierFanta] workspace: {} DB caricati, active={}",
        connections.len(),
        active_db_id
    );

    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        .manage(DbState {
            connections: Mutex::new(connections),
            active_db_id: Mutex::new(active_db_id),
            db_path: Mutex::new(db_path),
        })
        .invoke_handler(tauri::generate_handler![
            // database.rs (M1)
            commands::database::init_db,
            commands::database::get_db_info,
            // database.rs (M2 — multi-DB workspace)
            commands::database::list_databases,
            commands::database::create_database,
            commands::database::delete_database,
            commands::database::set_active_database,
            commands::database::get_active_database,
            // players.rs (M1 + M2 refactor)
            commands::players::list_players,
            commands::players::create_player,
            commands::players::update_player,
            commands::players::delete_player,
            commands::players::count_players,
            commands::players::archive_player,
            commands::players::list_archive,
            // listone.rs (M2 — archiviazione automatica)
            commands::listone::import_listone,
            commands::listone::list_archived_players,
            commands::listone::restore_archived_player,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DossierFanta application");
}
