//! SQLite connection management + schema migration.
//!
//! Lo schema è `migrations/schema_v2.2.sql` (copiato pari pari dal file
//! allegato). La migrazione è idempotente: controlla se la tabella `players`
//! esiste già e se sì salta l'applicazione dello schema.

use rusqlite::{Connection, Error as SqlError};
use std::path::Path;

/// Schema SQL v2.2 embedded nel binario (nessun file esterno a runtime).
const SCHEMA_V2_2: &str = include_str!("../migrations/schema_v2.2.sql");

/// Apre la connessione a `mio.db` (lo crea se non esiste) e applica lo
/// schema v2.2 se è la prima esecuzione.
///
/// Idempotente: se la tabella `players` esiste già, lo schema non viene
/// ri-eseguito (evita errori su CREATE TABLE su tabelle già esistenti).
pub fn open_and_migrate(db_path: &Path) -> Result<Connection, SqlError> {
    let conn = Connection::open(db_path)?;

    // PRAGMA obbligatori (lo schema li setta ma solo dopo essere stato applicato
    // la prima volta; qui li impostiamo sempre per sicurezza).
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    // `recursive_triggers` OFF di default in SQLite. Il trigger `trg_players_updated_at`
    // dello schema v2.2 esegue un UPDATE su `players` dentro un AFTER UPDATE:
    // con recursive_triggers=OFF il trigger si ferma a una singola iterazione.
    conn.pragma_update(None, "recursive_triggers", "OFF")?;

    let schema_already_applied: bool = {
        let mut stmt = conn.prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='players' LIMIT 1",
        )?;
        stmt.exists([])?
    };

    if !schema_already_applied {
        log::info!("Applying DossierFanta schema v2.2 (first run)...");
        conn.execute_batch(SCHEMA_V2_2)?;
        log::info!("Schema v2.2 applied successfully.");
    } else {
        log::debug!("Schema v2.2 already applied, skipping migration.");
    }

    Ok(conn)
}

/// Helper: genera un UUID v4 come stringa. Usato per i nuovi giocatori.
pub fn new_uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}
