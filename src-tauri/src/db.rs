//! SQLite connection management + schema migration.
//!
//! Schema versioning:
//!  - v2.2 (M2): `migrations/schema_v2.2.sql` — schema base.
//!  - v2.3 (M3a): `migrations/schema_v2.3.sql` — estensione additive per
//!    sync-live (CRDT). ALTER TABLE additive + nuova tabella `sync_peers`.
//!  - v2.4 (M3a.3): `migrations/schema_v2.4.sql` — estensione additive per
//!    `sync_identity` (peer key Iroh persistente, singleton table).
//!  - v2.5 (M3a.4 + M3a.5): `migrations/schema_v2.5.sql` — estensione additive per
//!    `sync_pairings` (ECDH shared_secret + room_name derivata) +
//!    `sync_pairings_pending` (codici 8-cifre pairing in corso).
//!
//! M3a (B.1) — Migrazione tracciata via `PRAGMA user_version`:
//!  - 0 (never migrated) → applica v2.2 + v2.3 + v2.4 + v2.5, set user_version=5
//!  - <3 → applica v2.3 + v2.4 + v2.5, set user_version=5
//!  - ==3 → applica v2.4 + v2.5, set user_version=5
//!  - ==4 → applica v2.5, set user_version=5
//!  - >=5 → skip
//!
//! Lo schema v2.2 è idempotente via check esistenza tabella `players`.
//! Lo schema v2.3 è idempotente via `PRAGMA table_info` check su ogni ALTER
//! + `CREATE TABLE IF NOT EXISTS` per `sync_peers`.

use rusqlite::{Connection, Error as SqlError};
use std::path::{Path, PathBuf};

/// Schema SQL v2.2 embedded nel binario (nessun file esterno a runtime).
const SCHEMA_V2_2: &str = include_str!("../migrations/schema_v2.2.sql");

/// Schema SQL v2.3 (estensione additive per sync-live M3a).
/// Contiene SOLO la CREATE TABLE IF NOT EXISTS sync_peers. Gli ALTER
/// additive sono gestiti in Rust da `migrate_v22_to_v23` per idempotenza.
const SCHEMA_V2_3: &str = include_str!("../migrations/schema_v2.3.sql");

/// Schema SQL v2.4 (estensione additive M3a.3 — peer key persistente).
/// Contiene SOLO la CREATE TABLE IF NOT EXISTS sync_identity (singleton
/// table). Nessun ALTER — puramente additive.
const SCHEMA_V2_4: &str = include_str!("../migrations/schema_v2.4.sql");

/// Schema SQL v2.5 (estensione additive M3a.4 + M3a.5 — pairing cifrato).
/// Contiene SOLO CREATE TABLE IF NOT EXISTS sync_pairings + sync_pairings_pending.
/// Nessun ALTER — puramente additive.
const SCHEMA_V2_5: &str = include_str!("../migrations/schema_v2.5.sql");

/// Versione schema target. v5 = v2.5 (sync_pairings per ECDH + AES-GCM).
const SCHEMA_VERSION_TARGET: i32 = 5;

/// Apre la connessione a `mio.db` (lo crea se non esiste) e applica lo
/// schema v2.2 se è la prima esecuzione, poi la migrazione v2.3 se
/// `PRAGMA user_version` < 3.
///
/// Idempotente: se la tabella `players` esiste già, lo schema v2.2 non
/// viene ri-eseguito. La migrazione v2.3 è idempotente via check
/// `PRAGMA table_info` su ogni ALTER.
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
        // Su DB nuovo, applica subito anche v2.3 (sync_peers + ALTER additive).
        log::info!("Applying DossierFanta schema v2.3 (sync-live extension)...");
        conn.execute_batch(SCHEMA_V2_3)?;
        migrate_v22_to_v23(&conn)?;
        // Su DB nuovo, applica subito anche v2.4 (sync_identity singleton).
        log::info!("Applying DossierFanta schema v2.4 (sync_identity extension)...");
        conn.execute_batch(SCHEMA_V2_4)?;
        // Su DB nuovo, applica subito anche v2.5 (sync_pairings per ECDH pairing).
        log::info!("Applying DossierFanta schema v2.5 (sync_pairings extension)...");
        conn.execute_batch(SCHEMA_V2_5)?;
        set_user_version(&conn, SCHEMA_VERSION_TARGET)?;
        log::info!(
            "Schema v2.5 applied. user_version={}.",
            SCHEMA_VERSION_TARGET
        );
    } else {
        let current = get_user_version(&conn);
        log::debug!(
            "Schema v2.2 already applied. user_version={} (target={}).",
            current,
            SCHEMA_VERSION_TARGET
        );
        if current < SCHEMA_VERSION_TARGET {
            log::info!(
                "Migrating DB from user_version={} to {} (v2.3+v2.4+v2.5 sync extensions)...",
                current,
                SCHEMA_VERSION_TARGET
            );
            // Applica v2.3 se non ancora applicato (current < 3)
            if current < 3 {
                conn.execute_batch(SCHEMA_V2_3)?;
                migrate_v22_to_v23(&conn)?;
                log::info!("Migration to v2.3 complete.");
            }
            // Applica v2.4 (sync_identity) se non ancora applicato (current < 4)
            if current < 4 {
                conn.execute_batch(SCHEMA_V2_4)?;
                log::info!("Migration to v2.4 complete (sync_identity table).");
            }
            // Applica v2.5 (sync_pairings + sync_pairings_pending) se non ancora applicato (current < 5)
            if current < 5 {
                conn.execute_batch(SCHEMA_V2_5)?;
                log::info!("Migration to v2.5 complete (sync_pairings + sync_pairings_pending tables).");
            }
            set_user_version(&conn, SCHEMA_VERSION_TARGET)?;
            log::info!(
                "Migration complete. user_version={}.",
                SCHEMA_VERSION_TARGET
            );
        } else {
            log::debug!("DB already at v2.5, skipping migration.");
        }
    }

    Ok(conn)
}

/// Restituisce `PRAGMA user_version` (0 se mai settato).
fn get_user_version(conn: &Connection) -> i32 {
    conn.query_row("SELECT user_version FROM pragma_user_version", [], |r| {
        r.get::<_, i32>(0)
    })
    .unwrap_or(0)
}

/// Setta `PRAGMA user_version` (solo verso il basso non consentito da SQLite).
fn set_user_version(conn: &Connection, version: i32) -> Result<(), SqlError> {
    conn.pragma_update(None, "user_version", version)
}

/// Migrazione v2.2 → v2.3: aggiunge colonne sync-live a players,
/// scouting_notes, auction_data. Idempotente via check su `PRAGMA
/// table_info(table)` per ogni colonna.
///
/// Vincoli HARD: ALTER additive solo (default NULL, no drop, no rename,
/// no type change). La tabella `players_archive` NON viene estesa.
fn migrate_v22_to_v23(conn: &Connection) -> Result<(), SqlError> {
    // Definizione (table, column) da aggiungere se mancante.
    let alters: &[(&str, &str)] = &[
        // players: campi sync-live
        ("players", "last_sync_at"),
        ("players", "sync_node_id"),
        // scouting_notes: campi sync-live
        ("scouting_notes", "last_sync_at"),
        ("scouting_notes", "sync_node_id"),
        // auction_data: campi sync-live
        ("auction_data", "last_sync_at"),
        ("auction_data", "sync_node_id"),
    ];

    for (table, column) in alters {
        if !has_column(conn, table, column)? {
            let sql = format!(
                "ALTER TABLE {} ADD COLUMN {} TEXT;",
                table, column
            );
            log::info!("MIGRATE v2.3: ALTER TABLE {} ADD COLUMN {}", table, column);
            conn.execute(&sql, [])?;
        } else {
            log::debug!(
                "MIGRATE v2.3: skip ALTER {} ADD {} (già presente)",
                table,
                column
            );
        }
    }
    Ok(())
}

/// True se la colonna `column` esiste già nella tabella `table`.
///
/// Implementazione: scorre le righe di `PRAGMA table_info(<table>)` e
/// confronta il campo `name` (colonna 1) con `column`. `PRAGMA` non accetta
/// parametri bindabili, quindi NON possiamo usare `stmt.exists([param])` con
/// un parametro — rusqlite restituirebbe `InvalidParameterCount(1, 0)` e
/// `migrate_v22_to_v23` fallirebbe, causando `std::process::exit(1)` in
/// `lib.rs::run()` PRIMA che Tauri apra la finestra. Sintomo esterno:
/// l'app .msi installata "non si apre proprio" al primo avvio su DB nuovo.
fn has_column(conn: &Connection, table: &str, column: &str) -> Result<bool, SqlError> {
    // Note: `table` è una stringa costante interna (vedi `migrate_v22_to_v23`),
    // non input utente, quindi interpolazione nel SQL è sicura.
    let sql = format!("PRAGMA table_info({})", table);
    let mut stmt = conn.prepare(&sql)?;
    // PRAGMA table_info ritorna righe (cid, name, type, notnull, dflt, pk).
    // Filtra per name == column. 0 params passati a query_map: la query
    // non ha placeholder (`?N`), quindi passiamo `[]` (nessun parametro).
    let rows = stmt.query_map([], |r| r.get::<_, String>(1))?;
    for row in rows {
        if let Ok(name) = row {
            if name == column {
                return Ok(true);
            }
        }
    }
    Ok(false)
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
