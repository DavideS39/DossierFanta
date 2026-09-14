//! Comandi per gestione del DB locale.
//! - `init_db`: inizializza il DB (già fatto in `setup`, ma riesposto per
//!   permettere al frontend di forzarne la riuscita e ottenere metadati).
//! - `get_db_info`: restituisce path, versione schema, numero record.

use crate::commands::{AppError, AppResult};
use crate::DbState;
use rusqlite::params;
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};

#[derive(Debug, Serialize)]
pub struct DbInfo {
    pub db_path: String,
    pub schema_version: i64,
    pub players_count: i64,
    pub archived_count: i64,
    pub default_db_id: String,
    pub default_db_name: String,
}

/// Risolve il path del DB di default ("mio.db") dentro `app_data_dir`.
fn resolve_db_path(app: &AppHandle) -> Result<PathBuf, AppError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Generic(format!("app_data_dir: {}", e)))?;
    std::fs::create_dir_all(&dir).map_err(AppError::Io)?;
    Ok(dir.join("mio.db"))
}

/// Inizializza il DB. Idempotente. Usato dal frontend per ottenere una
/// conferma che il DB è pronto (utile per splash screen o first-run wizard).
#[tauri::command]
pub fn init_db(app: AppHandle) -> AppResult<String> {
    let path = resolve_db_path(&app)?;
    // Lo schema è già applicato nel setup(). Qui ritorniamo solo il path.
    Ok(path.display().to_string())
}

/// Restituisce metadati sul DB di default: path, versione schema, conteggi.
#[tauri::command]
pub fn get_db_info(app: AppHandle, state: State<'_, DbState>) -> AppResult<DbInfo> {
    let path = resolve_db_path(&app)?;    let conn = state.0.lock().map_err(|e| AppError::Generic(e.to_string()))?;

    let schema_version: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(schema_ver), 3) FROM databases LIMIT 1",
            [],
            |row| row.get(0),
        )
        .unwrap_or(3);

    let players_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM players", [], |row| row.get(0))
        .unwrap_or(0);

    let archived_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM players_archive", [], |row| row.get(0))
        .unwrap_or(0);

    let (default_db_id, default_db_name): (String, String) = conn
        .query_row(
            "SELECT id, name FROM databases WHERE id = 'default-personal'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap_or_else(|_| ("default-personal".to_string(), "mio.db".to_string()));

    Ok(DbInfo {
        db_path: path.display().to_string(),
        schema_version,
        players_count,
        archived_count,
        default_db_id,
        default_db_name,
    })
}

// Helper interno: controlla che un giocatore esista.
#[allow(dead_code)]
pub(crate) fn player_exists(conn: &rusqlite::Connection, id: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM players WHERE id = ?1",
        params![id],
        |_| Ok(()),
    )
    .is_ok()
}
