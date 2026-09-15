//! SQLite connection management + schema migration.
//!
//! Lo schema è `migrations/schema_v2.2.sql` (copiato pari pari dal file
//! allegato). La migrazione è idempotente: controlla se la tabella `players`
//! esiste già e se sì salta l'applicazione dello schema.
//!
//! In M2 aggiungiamo `open_db_file` e `clone_conn`: helper per aprire
//! ulteriori connessioni allo stesso file (multi-DB workspace logico).

use rusqlite::{Connection, Error as SqlError};
use std::path::{Path, PathBuf};

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

/// Apre una nuova connessione a un file SQLite esistente (M2 helper per
/// multi-DB workspace). Applica gli stessi PRAGMA di `open_and_migrate`
/// ma NON applica lo schema (presuppone che il file sia già inizializzato).
pub fn open_db_file(db_path: &Path) -> Result<Connection, SqlError> {
    let conn = Connection::open(db_path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "recursive_triggers", "OFF")?;
    Ok(conn)
}

/// Apre una nuova connessione allo stesso path di `src` (M2 helper).
/// Usato quando inizializziamo il workspace: ogni `db_id` logico ha la
/// sua connessione, ma tutte puntano allo stesso file `mio.db`.
///
/// `src` non viene usato per leggere dati — serve solo per ottenere il path.
/// In pratica questo metodo delega a `open_db_file(path)`.
#[allow(dead_code)]
pub fn clone_conn(_src: &Connection, path: &Path) -> Connection {
    open_db_file(path).expect("cannot open clone connection to mio.db")
}

/// Helper: genera un UUID v4 come stringa. Usato per i nuovi giocatori.
pub fn new_uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Ritorna il path di `app_data_dir` risolto in `lib.rs`. Usato dai comandi
/// che necessitano del path del file (es. `init_db`).
#[allow(dead_code)]
pub fn app_data_dir() -> PathBuf {
    let base = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("com.dossierfanta.app")
}
