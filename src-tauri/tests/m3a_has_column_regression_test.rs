//! Test di regressione per il bug "l'app .msi non si avvia proprio".
//!
//! Sintomo: dopo aver installato l'.msi generato da build-msi.yml, l'app
//! non si apre. Nessuna finestra, nessun messaggio di errore visibile.
//!
//! Causa radice (individuata il 2026-10-17):
//! `db::has_column` chiamava `stmt.exists([&column.to_string()])` passando
//! 1 parametro a una query `PRAGMA table_info(<table>)` che ha 0 placeholder.
//! rusqlite restituisce `Err(InvalidParameterCount(1, 0))`. L'errore
//! veniva propagato da `migrate_v22_to_v23` → `open_and_migrate` →
//! `lib.rs::run()`, dove il match arm `Err(e)` fa:
//!
//! ```text
//! eprintln!("FATAL: DB init failed: {}", e);
//! std::process::exit(1);
//! ```
//!
//! Su Windows in release (`#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]`)
//! `eprintln!` non ha output visibile, quindi l'app "sparisce" silenziosamente
//! prima che `tauri::Builder::default().run(...)` apra la finestra.
//!
//! Il bug si manifesta su qualunque DB nuovo (file mio.db non esistente),
//! perché `migrate_v22_to_v23` viene chiamato nel branch `!schema_already_applied`
//! di `open_and_migrate` per aggiungere le colonne sync-live (v2.3).
//!
//! Questo test riproduce il flusso esatto e verifica che:
//! 1. `open_and_migrate` su DB nuovo va a buon fine (no `InvalidParameterCount`)
//! 2. `migrate_v22_to_v23` aggiunge effettivamente le 6 colonne sync-live
//! 3. Chiamando di nuovo `open_and_migrate` sullo stesso file, le colonne
//!    esistono già e gli ALTER vengono saltati (idempotenza)

use std::path::PathBuf;

const SYNC_LIVE_COLUMNS: &[(&str, &str)] = &[
    ("players", "last_sync_at"),
    ("players", "sync_node_id"),
    ("scouting_notes", "last_sync_at"),
    ("scouting_notes", "sync_node_id"),
    ("auction_data", "last_sync_at"),
    ("auction_data", "sync_node_id"),
];

/// Pulisce i file SQLite precedenti (db, wal, shm) per garantire un DB nuovo.
fn cleanup_db_files(path: &std::path::Path) {
    let _ = std::fs::remove_file(path);
    let mut wal = path.to_path_buf();
    wal.set_extension("db-wal");
    let _ = std::fs::remove_file(&wal);
    let mut shm = path.to_path_buf();
    shm.set_extension("db-shm");
    let _ = std::fs::remove_file(&shm);
}

/// Verifica che tutte le 6 colonne sync-live siano presenti su una tabella.
fn count_sync_columns(conn: &rusqlite::Connection) -> usize {
    let mut found = 0;
    for (table, column) in SYNC_LIVE_COLUMNS {
        let sql = format!("PRAGMA table_info({})", table);
        let mut stmt = conn.prepare(&sql).unwrap();
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap();
        for row in rows.flatten() {
            if row == *column {
                found += 1;
                break;
            }
        }
    }
    found
}

#[test]
fn open_and_migrate_on_fresh_db_succeeds() {
    let tmp: PathBuf = PathBuf::from("/tmp/dossierfanta_regression_has_column.db");
    cleanup_db_files(&tmp);

    // Questo era il path che panicava/exit(1) prima del fix.
    let conn = dossierfanta_lib::db::open_and_migrate(&tmp)
        .expect("open_and_migrate on fresh DB must succeed — see has_column() in db.rs");

    // Verifica che tutte le 6 colonne sync-live siano state aggiunte.
    let found = count_sync_columns(&conn);
    assert_eq!(
        found, 6,
        "expected all 6 sync-live columns after migrate_v22_to_v23, found {}",
        found
    );

    drop(conn);
    cleanup_db_files(&tmp);
}

#[test]
fn open_and_migrate_is_idempotent_on_existing_db() {
    let tmp: PathBuf = PathBuf::from("/tmp/dossierfanta_regression_has_column_idem.db");
    cleanup_db_files(&tmp);

    // Prima chiamata: crea il DB + applica schema v2.2 + v2.3.
    {
        let conn = dossierfanta_lib::db::open_and_migrate(&tmp)
            .expect("first open_and_migrate must succeed");
        assert_eq!(count_sync_columns(&conn), 6);
        drop(conn);
    }

    // Seconda chiamata sullo stesso file: deve essere idempotente.
    // Le colonne esistono già → has_column ritorna true → ALTER saltati.
    // Nessun InvalidParameterCount, nessun "duplicate column" error.
    {
        let conn = dossierfanta_lib::db::open_and_migrate(&tmp)
            .expect("second open_and_migrate must be idempotent");
        assert_eq!(count_sync_columns(&conn), 6);
        drop(conn);
    }

    cleanup_db_files(&tmp);
}

/// Verifica diretta di `has_column` (la funzione che era buggy).
/// `db::has_column` è privata, ma viene esercitata indirettamente da
/// `open_and_migrate` → `migrate_v22_to_v23`. Questo test è un proxy
/// che riproduce il pattern di chiamata per assicurarsi che il fix regga
/// anche se qualcuno in futuro ri-introduce il pattern `stmt.exists([param])`.
#[test]
fn pragma_table_info_does_not_accept_bind_params() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE players (id TEXT PRIMARY KEY, name TEXT);")
        .unwrap();

    // Pattern BUGGY: stmt.exists([param]) su PRAGMA senza placeholder.
    // Verifichiamo che rusqlite lo rifiuti (regressione futura).
    let mut stmt = conn.prepare("PRAGMA table_info(players)").unwrap();
    let buggy_result: Result<bool, rusqlite::Error> = stmt.exists(["last_sync_at"]);
    assert!(
        buggy_result.is_err(),
        "stmt.exists([param]) on PRAGMA must error — if this passes, rusqlite changed behavior, \
         re-check has_column() in db.rs"
    );

    // Pattern CORRETTO: query_map([]) senza parametri.
    let mut stmt = conn.prepare("PRAGMA table_info(players)").unwrap();
    let rows: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .unwrap()
        .flatten()
        .collect();
    assert!(rows.contains(&"id".to_string()));
    assert!(rows.contains(&"name".to_string()));
    assert!(!rows.contains(&"last_sync_at".to_string()));
}
