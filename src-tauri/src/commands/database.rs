//! Comandi per gestione del DB locale + multi-DB workspace (M2).
//!
//! M1:
//! - `init_db`: inizializza il DB (già fatto in `setup`, ma riesposto per
//!   permettere al frontend di forzarne la riuscita e ottenere metadati).
//! - `get_db_info`: restituisce path, versione schema, numero record.
//!
//! M2 (multi-DB workspace):
//! - `list_databases()`: elenca tutti i DB logici (righe di `databases`).
//! - `create_database(name, db_type)`: crea un nuovo DB logico (INSERT in
//!   `databases`, apre una nuova Connection allo stesso file mio.db, la
//!   inserisce nella mappa `DbState.connections`).
//! - `delete_database(id)`: rimuove il DB (cascade elimina i players).
//!   Non permette la cancellazione di `default-personal` (vincolo: il DB
//!   di default deve restare sempre disponibile).
//! - `set_active_database(id)`: cambia `active_db_id` nel DbState.
//! - `get_active_database()`: ritorna il DatabaseMeta del DB attivo.

use crate::commands::{AppError, AppResult};
use crate::db;
use crate::DbState;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};

// ----------------------------------------------------------------------
// Tipi esposti al frontend
// ----------------------------------------------------------------------

/// Metadati di un DB logico (riga di `databases`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseMeta {
    pub id: String,
    pub name: String,
    pub r#type: String, // 'personal' | 'shared' | 'listone'
    pub owner: Option<String>,
    pub created_at: Option<String>,
    pub last_sync: Option<String>,
    pub schema_ver: i64,
}

/// Statistiche DB (M1 + esteso per multi-DB).
#[derive(Debug, Serialize)]
pub struct DbInfo {
    pub db_path: String,
    pub schema_version: i64,
    pub players_count: i64, // totale (tutti i db)
    pub archived_count: i64,
    pub default_db_id: String,
    pub default_db_name: String,
    pub databases_count: i64, // M2: numero di DB logici
    pub active_db_id: String, // M2: db attivo
    pub active_db_name: String, // M2: nome db attivo
}

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

/// Risolve il path del DB di default ("mio.db") dentro `app_data_dir`.
fn resolve_db_path(app: &AppHandle) -> Result<PathBuf, AppError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Generic(format!("app_data_dir: {}", e)))?;
    std::fs::create_dir_all(&dir).map_err(AppError::Io)?;
    Ok(dir.join("mio.db"))
}

/// Mappa una riga di `databases` in `DatabaseMeta`.
fn row_to_meta(row: &rusqlite::Row) -> rusqlite::Result<DatabaseMeta> {
    Ok(DatabaseMeta {
        id: row.get(0)?,
        name: row.get(1)?,
        r#type: row.get(2)?,
        owner: row.get(3)?,
        created_at: row.get(4)?,
        last_sync: row.get(5)?,
        schema_ver: row.get(6)?,
    })
}

const DB_META_SELECT: &str = r#"SELECT id, name, type, owner, created_at, last_sync, schema_ver
                                FROM databases"#;

/// Verifica che un `db_id` esista e ritorna il suo tipo. Usato per il
/// check "listone è read-only" in commands/players.rs.
pub(crate) fn db_type(conn: &rusqlite::Connection, db_id: &str) -> Result<String, AppError> {
    let t: Option<String> = conn
        .query_row(
            "SELECT type FROM databases WHERE id = ?1",
            params![db_id],
            |r| r.get(0),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
                AppError::NotFound(format!("DB id={} non esiste", db_id))
            }
            other => AppError::Db(other),
        })?;
    Ok(t.unwrap_or_else(|| "personal".to_string()))
}

/// Verifica che il DB indicato NON sia di tipo `listone` (read-only).
/// Usato da `create_player`, `update_player`, `delete_player`.
pub(crate) fn ensure_writable_db(
    conn: &rusqlite::Connection,
    db_id: &str,
) -> Result<(), AppError> {
    let t = db_type(conn, db_id)?;
    if t == "listone" {
        return Err(AppError::Validation(format!(
            "DB id={} è di tipo 'listone' (read-only): operazione di scrittura rifiutata",
            db_id
        )));
    }
    Ok(())
}

// ----------------------------------------------------------------------
// Comandi M1 (mantenuti per backward compatibility)
// ----------------------------------------------------------------------

/// Inizializza il DB. Idempotente. Usato dal frontend per ottenere una
/// conferma che il DB è pronto (utile per splash screen o first-run wizard).
#[tauri::command]
pub fn init_db(app: AppHandle) -> AppResult<String> {
    let path = resolve_db_path(&app)?;
    Ok(path.display().to_string())
}

/// Restituisce metadati sul DB: path, versione schema, conteggi, DB attivo.
#[tauri::command]
pub fn get_db_info(app: AppHandle, state: State<'_, DbState>) -> AppResult<DbInfo> {
    let path = resolve_db_path(&app)?;
    let active_id = state.active_db_id()?;

    // Leggi dalla connessione del DB attivo (qualsiasi DB logico va bene,
    // visto che tutte le connessioni puntano allo stesso file).
    let info = state.with_conn(&active_id, |conn| {
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

        let databases_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM databases", [], |row| row.get(0))
            .unwrap_or(0);

        let (default_db_id, default_db_name): (String, String) = conn
            .query_row(
                "SELECT id, name FROM databases WHERE id = 'default-personal'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap_or_else(|_| ("default-personal".to_string(), "mio.db".to_string()));

        let (active_db_id, active_db_name): (String, String) = conn
            .query_row(
                "SELECT id, name FROM databases WHERE id = ?1",
                params![&active_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap_or_else(|_| (active_id.clone(), "?".to_string()));

        Ok(DbInfo {
            db_path: path.display().to_string(),
            schema_version,
            players_count,
            archived_count,
            default_db_id,
            default_db_name,
            databases_count,
            active_db_id,
            active_db_name,
        })
    })?;
    Ok(info)
}

// ----------------------------------------------------------------------
// Comandi M2 — multi-DB workspace
// ----------------------------------------------------------------------

/// Elenca tutti i DB logici (righe della tabella `databases`).
/// Ordinamento: created_at ASC (il default-personal è sempre il primo).
#[tauri::command]
pub fn list_databases(state: State<'_, DbState>) -> AppResult<Vec<DatabaseMeta>> {
    let active_id = state.active_db_id()?;
    state.with_conn(&active_id, |conn| {
        let mut stmt = conn.prepare(&format!("{} ORDER BY created_at ASC", DB_META_SELECT))?;
        let rows = stmt.query_map([], row_to_meta)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    })
}

/// Crea un nuovo database logico (PERSONALE o CONDIVISO; LISTONE in M2 viene
/// creato solo dall'import del listone, vedi `commands/listone.rs`).
///
/// Genera un UUID v4 come `id`, INSERT nella tabella `databases`, apre una
/// nuova Connection allo stesso file `mio.db` e la inserisce nella mappa
/// `DbState.connections`.
///
/// NOTA: il `name` è libero ma deve essere non vuoto e unico (case-insensitive).
#[tauri::command]
pub fn create_database(
    state: State<'_, DbState>,
    name: String,
    db_type: Option<String>,
) -> AppResult<DatabaseMeta> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::Validation("name è obbligatorio".to_string()));
    }
    let t = db_type.unwrap_or_else(|| "personal".to_string());
    let valid_types = ["personal", "shared", "listone"];
    if !valid_types.contains(&t.as_str()) {
        return Err(AppError::Validation(format!(
            "type deve essere uno di {:?}, avuto {:?}",
            valid_types, t
        )));
    }

    // Genera id e owner
    let id = db::new_uuid();
    let owner = match t.as_str() {
        "personal" => "me",
        "shared" => "me", // in M2 non c'è multi-utente; owner è sempre 'me'
        "listone" => "auto-fetch", // marker — ma in M2 l'import crea il listone, non questo comando
        _ => "me",
    };

    // Path del file SQLite (cached in DbState.db_path).
    let db_path = {
        let p = state
            .db_path
            .lock()
            .map_err(|e| AppError::Generic(format!("Mutex db_path: {}", e)))?;
        p.clone()
    };

    // INSERT nella tabella `databases` (uso la connessione del default-personal,
    // che è sempre presente).
    let meta = state.with_conn("default-personal", |conn| {
        // Check name unique (case-insensitive)
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM databases WHERE LOWER(name) = LOWER(?1) LIMIT 1",
                params![&name],
                |_| Ok(true),
            )
            .unwrap_or(false);
        if exists {
            return Err(AppError::Validation(format!(
                "Esiste già un database di nome {:?}",
                name
            )));
        }

        conn.execute(
            r#"INSERT INTO databases (id, name, type, owner, schema_ver)
               VALUES (?1, ?2, ?3, ?4, 3)"#,
            params![&id, &name, &t, owner],
        )?;

        // Re-read the inserted row
        let meta = conn.query_row(
            &format!("{} WHERE id = ?1", DB_META_SELECT),
            params![&id],
            row_to_meta,
        )?;
        Ok(meta)
    })?;

    // Apri una nuova Connection allo stesso file e inseriscila nella mappa.
    let new_conn = db::open_db_file(&db_path)?;
    {
        let mut map = state
            .connections
            .lock()
            .map_err(|e| AppError::Generic(format!("Mutex connections: {}", e)))?;
        map.insert(id.clone(), new_conn);
    }

    Ok(meta)
}

/// Elimina un database logico. CASCADE elimina tutti i suoi giocatori
/// (lo schema ha `players.db_id REFERENCES databases(id) ON DELETE CASCADE`).
///
/// Vincoli:
/// - NON si può eliminare `default-personal` (vincolo M2: il DB di default
///   resta sempre disponibile come fallback).
/// - Se il DB eliminato era quello attivo, l'`active_db_id` torna a
///   `default-personal`.
/// - L'eliminazione richiede conferma esplicita nel frontend (vincolo HARD
///   "niente cancellazioni automatiche").
#[tauri::command]
pub fn delete_database(state: State<'_, DbState>, id: String) -> AppResult<bool> {
    if id == "default-personal" {
        return Err(AppError::Validation(
            "Il database 'default-personal' non può essere eliminato (vincolo M2)".to_string(),
        ));
    }

    // Esegui DELETE nella tabella `databases` (cascade elimina i players).
    state.with_conn("default-personal", |conn| {
        // Pre-check: il DB esiste?
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM databases WHERE id = ?1 LIMIT 1",
                params![&id],
                |_| Ok(true),
            )
            .unwrap_or(false);
        if !exists {
            return Err(AppError::NotFound(format!(
                "DB id={} non esiste",
                id
            )));
        }

        let affected = conn.execute("DELETE FROM databases WHERE id = ?1", params![&id])?;
        if affected == 0 {
            return Err(AppError::NotFound(format!(
                "DB id={} non trovato (nessuna riga eliminata)",
                id
            )));
        }
        Ok(true)
    })?;

    // Rimuovi la connessione dalla mappa.
    {
        let mut map = state
            .connections
            .lock()
            .map_err(|e| AppError::Generic(format!("Mutex connections: {}", e)))?;
        map.remove(&id);
    }

    // Se il DB eliminato era quello attivo, resetta a default-personal.
    let active = state.active_db_id()?;
    if active == id {
        state.set_active_db_id("default-personal".to_string())?;
    }

    Ok(true)
}

/// Imposta il DB attivo. Verifica che il `db_id` esista nella tabella.
#[tauri::command]
pub fn set_active_database(state: State<'_, DbState>, id: String) -> AppResult<DatabaseMeta> {
    // Verifica che il DB esista
    state.with_conn("default-personal", |conn| {
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM databases WHERE id = ?1 LIMIT 1",
                params![&id],
                |_| Ok(true),
            )
            .unwrap_or(false);
        if !exists {
            return Err(AppError::NotFound(format!(
                "DB id={} non esiste",
                id
            )));
        }
        Ok(())
    })?;

    state.set_active_db_id(id.clone())?;

    // Ritorna il meta del DB appena attivato
    state.with_conn("default-personal", |conn| {
        let meta = conn.query_row(
            &format!("{} WHERE id = ?1", DB_META_SELECT),
            params![&id],
            row_to_meta,
        )?;
        Ok(meta)
    })
}

/// Ritorna i metadati del DB attualmente attivo.
#[tauri::command]
pub fn get_active_database(state: State<'_, DbState>) -> AppResult<DatabaseMeta> {
    let id = state.active_db_id()?;
    state.with_conn("default-personal", |conn| {
        let meta = conn.query_row(
            &format!("{} WHERE id = ?1", DB_META_SELECT),
            params![&id],
            row_to_meta,
        )?;
        Ok(meta)
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
