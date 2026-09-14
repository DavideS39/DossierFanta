//! DossierFanta v2.2 — Tauri 2.0 backend (M1).
//!
//! Architettura:
//! - `rusqlite` gestisce il DB SQLite locale in `app_data_dir/mio.db`
//! - Lo schema `schema_v2.2.sql` è embedded via `include_str!` e applicato
//!   al primo avvio del comando `init_db`.
//! - Tutte le operazioni CRUD sono esposte come Tauri commands in Rust.
//! - Il frontend NON esegue SQL diretto: ogni accesso passa per i comandi.
//!
//! Nota architetturale (vedi README.md): lo specifica menzionava
//! `tauri-plugin-sql` come bridge SQLite, ma il requisito HARD "Comandi Tauri
//! in Rust per tutte le operazioni DB" richiede che ogni query attraversi un
//! comando Rust. `tauri-plugin-sql` espone un'API JS diretta che permetterebbe
//! al frontend di eseguire SQL arbitrario, violando il requisito. Usiamo quindi
//! `rusqlite` direttamente in Rust: più sicuro, più tipizzato, più idiomatico.

pub mod commands;
pub mod db;

use std::sync::Mutex;
use rusqlite::Connection;

/// Stato condiviso tra i comandi Tauri: una singola connessione SQLite
/// protetta da `Mutex`. In M1 c'è un solo DB ("mio.db"), quindi una sola
/// connessione è sufficiente. Per M2 (multi-DB workspace) diventerà una
/// `HashMap<String, Connection>`.
pub struct DbState(pub Mutex<Connection>);

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
    // Questo garantisce che mio.db esista prima che la webview venga inizializzata,
    // e che lo schema v2.2 sia applicato anche se Tauri non riesce ad avviare la UI.
    let app_data_dir = resolve_app_data_dir_early();
    if let Err(e) = std::fs::create_dir_all(&app_data_dir) {
        eprintln!("FATAL: cannot create app_data_dir {}: {}", app_data_dir.display(), e);
        std::process::exit(1);
    }
    let db_path = app_data_dir.join("mio.db");

    eprintln!("[DossierFanta] app_data_dir = {}", app_data_dir.display());
    eprintln!("[DossierFanta] DB path = {}", db_path.display());

    let conn = match db::open_and_migrate(&db_path) {
        Ok(c) => {
            eprintln!("[DossierFanta] DB init OK, schema v2.2 applied");
            c
        }
        Err(e) => {
            eprintln!("FATAL: DB init failed: {}", e);
            std::process::exit(1);
        }
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        .manage(DbState(Mutex::new(conn)))
        .invoke_handler(tauri::generate_handler![
            commands::database::init_db,
            commands::database::get_db_info,
            commands::players::list_players,
            commands::players::create_player,
            commands::players::update_player,
            commands::players::delete_player,
            commands::players::count_players,
            commands::players::archive_player,
            commands::players::list_archive,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DossierFanta application");
}
