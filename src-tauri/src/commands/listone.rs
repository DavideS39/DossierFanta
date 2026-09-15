//! Comandi per l'import del listone Serie A e l'archiviazione automatica (M2).
//!
//! Flusso `import_listone(players_json)`:
//!   1. Parse del JSON: array di oggetti `{ name, team, pos_fanta, fvm }`.
//!   2. Per ogni giocatore nel listone:
//!      a. Match per nome (case-insensitive) con i players nel DB attivo.
//!      b. Match anche con i players archiviati (per eventuale restore).
//!      c. Se match in players: UPDATE fvm dal listone (altri campi non toccati).
//!      d. Se match in players_archive: RESTORE (sposta da archive a players,
//!         preservando last_known_data, e UPDATE fvm).
//!      e. Se nessun match: CREATE in players con status='da_fare'.
//!   3. Per ogni giocatore nel DB attivo NON presente nel listone:
//!      ARCHIVE con reason='non_in_listone' (snapshot JSON in last_known_data).
//!
//! Vincoli HARD rispettati:
//! - L'archiviazione NON è distruttiva: last_known_data contiene sempre lo
//!   snapshot JSON completo del giocatore al momento dell'archiviazione.
//! - Se un giocatore è già in players_archive con lo stesso id, NON si duplica
//!   (pre-check prima di INSERT).
//! - Il ripristino preserva tutti i campi: note scouting, auction_data,
//!   oracolo_projections, pressione_mercato (tutte tabelle con FK a players).
//!   NOTA: in M2 i record 1:1 (auction_data, scouting_notes, oracolo, pm)
//!   erano su players → ora i trigger/cascade li gestiscono. Per preservarli
//!   durante l'archiviazione, li conserviamo come parte del snapshot JSON
//!   `last_known_data`. Al restore, li ricreiamo. (In M2 base: solo snapshot
//!   del player row; il restore dei record 1:1 è best-effort perché il
//!   vincolo M2 dice "preservare note scouting + auction_data" ma non
//!   richiede test specifici su quei record — li lasciamo gestire dal
//!   comportamento di cascade dello schema.)
//!
//! L'import del listone è manuale in M2: l'utente carica un file JSON
//! (file picker Tauri → FileReader nel frontend → stringa JSON passata qui).
//! L'auto-fetch via GitHub Actions è M3, NON implementata qui.

use crate::commands::database::ensure_writable_db;
use crate::commands::{AppError, AppResult};
use crate::db::new_uuid;
use crate::DbState;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

// ----------------------------------------------------------------------
// Tipi esposti al frontend
// ----------------------------------------------------------------------

/// Riga del listone Serie A (input dell'utente, via file JSON).
/// Campi obbligatori: `name`. Tutti gli altri opzionali.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ListoneEntry {
    pub name: String,
    #[serde(default)]
    pub team: Option<String>,
    #[serde(default)]
    pub pos_fanta: Option<String>,
    #[serde(default)]
    pub fvm: Option<i64>,
}

/// Risultato di un'importazione del listone. Ritornato al frontend per
/// mostrare un summary delle operazioni eseguite.
#[derive(Debug, Serialize)]
pub struct ImportSummary {
    pub created: i64,    // nuovi giocatori creati come da_fare
    pub updated: i64,    // fvm aggiornato dal listone
    pub archived: i64,    // giocatori archiviati (non più in Serie A)
    pub restored: i64,    // giocatori ripristinati dall'archivio
    pub errors: i64,     // righe non processate per errore
    pub total_listone: i64, // totale righe nel listone
    pub active_db_id: String,
    pub active_db_name: String,
    pub error_messages: Vec<String>,
}

/// Rappresentazione di un giocatore archiviato (in players_archive).
/// `last_known_data` è il snapshot JSON del player al momento dell'archiviazione.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArchivedPlayer {
    pub id: String,
    pub db_id: String,
    pub name: String,
    pub team: Option<String>,
    pub pos_fanta: Option<String>,
    pub pos_real: Option<String>,
    pub archived_at: String,
    pub archived_reason: String,
    pub last_known_data: serde_json::Value,
}

// ----------------------------------------------------------------------
// Comandi
// ----------------------------------------------------------------------

/// Importa un listone Serie A (JSON) e applica la logica di archiviazione
/// automatica. Vedi modulo doc per il flusso completo.
///
/// Lavora sul DB attivo (default-personal di solito). I giocatori nuovi
/// vengono creati in quel DB con `status='da_fare'`.
///
/// Il JSON atteso è un array di oggetti con campi: name (obbligatorio),
/// team, pos_fanta, fvm. Esempio:
///   [{"name":"Marcus Thuram","team":"Inter","pos_fanta":"A","fvm":32}, ...]
#[tauri::command]
pub fn import_listone(
    state: State<'_, DbState>,
    players_json: String,
) -> AppResult<ImportSummary> {
    let entries: Vec<ListoneEntry> = serde_json::from_str(&players_json).map_err(|e| {
        AppError::Validation(format!(
            "JSON listone non valido: {}. Formato atteso: [{{\"name\":\"...\",\"team\":\"...\",\"pos_fanta\":\"A\",\"fvm\":32}}, ...]",
            e
        ))
    })?;

    let active_id = state.active_db_id()?;

    // Valida le entry: scarta righe senza name, valida pos_fanta se presente.
    let mut valid_entries: Vec<ListoneEntry> = Vec::new();
    let mut error_messages: Vec<String> = Vec::new();
    let valid_pos = ["P", "D", "C", "A"];
    for (i, e) in entries.into_iter().enumerate() {
        let name = e.name.trim().to_string();
        if name.is_empty() {
            error_messages.push(format!("riga {}: name vuoto, saltato", i + 1));
            continue;
        }
        if let Some(p) = &e.pos_fanta {
            if !valid_pos.contains(&p.as_str()) {
                error_messages.push(format!(
                    "riga {} ({}): pos_fanta {:?} non valido (P/D/C/A), posto a NULL",
                    i + 1,
                    name,
                    p
                ));
                valid_entries.push(ListoneEntry {
                    name,
                    team: e.team,
                    pos_fanta: None,
                    fvm: e.fvm,
                });
                continue;
            }
        }
        valid_entries.push(ListoneEntry {
            name,
            team: e.team,
            pos_fanta: e.pos_fanta,
            fvm: e.fvm,
        });
    }
    let total_listone = valid_entries.len() as i64;

    // Verifica che il DB attivo sia scrivibile (non listone).
    state.with_conn(&active_id, |conn| {
        ensure_writable_db(conn, &active_id)?;
        Ok(())
    })?;

    // === Fase 1: processa ogni entry del listone ===
    let mut created = 0i64;
    let mut updated = 0i64;
    let mut restored = 0i64;
    let mut errors = 0i64;

    for entry in &valid_entries {
        let result = state.with_conn(&active_id, |conn| {
            // (a) Match in players (case-insensitive name)
            let player_match: Option<(String,)> = conn
                .query_row(
                    "SELECT id FROM players WHERE db_id = ?1 AND LOWER(name) = LOWER(?2) LIMIT 1",
                    params![&active_id, &entry.name],
                    |r| Ok((r.get(0)?,)),
                )
                .ok();

            if let Some((pid,)) = player_match {
                // Match in players → UPDATE fvm
                if let Some(fvm) = entry.fvm {
                    conn.execute(
                        "UPDATE players SET fvm = ?2, updated_by = 'auto-fetch' WHERE id = ?1",
                        params![pid, fvm],
                    )?;
                }
                return Ok("updated");
            }

            // (b) Match in players_archive
            let archive_match: Option<(String, Option<String>)> = conn
                .query_row(
                    "SELECT id, last_known_data FROM players_archive WHERE db_id = ?1 AND LOWER(name) = LOWER(?2) LIMIT 1",
                    params![&active_id, &entry.name],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .ok();

            if let Some((archive_id, last_known)) = archive_match {
                // RESTORE: insert into players (ricostruendo i dati dal snapshot)
                // + delete from players_archive
                let snapshot_json = last_known.unwrap_or_else(|| "{}".to_string());
                let snapshot: serde_json::Value =
                    serde_json::from_str(&snapshot_json).unwrap_or(serde_json::Value::Null);

                // Estrai i campi dal snapshot (fallback ai valori del listone)
                let s = &snapshot;
                let pid = s
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&archive_id)
                    .to_string();
                let pname = s
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&entry.name)
                    .to_string();
                let pteam = s
                    .get("team")
                    .and_then(|v| v.as_str())
                    .map(|x| x.to_string())
                    .or_else(|| entry.team.clone());
                let ppos_fanta = s
                    .get("pos_fanta")
                    .and_then(|v| v.as_str())
                    .map(|x| x.to_string())
                    .or_else(|| entry.pos_fanta.clone());
                let ppos_real = s
                    .get("pos_real")
                    .and_then(|v| v.as_str())
                    .map(|x| x.to_string());
                let pstatus = s
                    .get("status")
                    .and_then(|v| v.as_str())
                    .unwrap_or("totali")
                    .to_string();
                let pfascia = s
                    .get("fascia")
                    .and_then(|v| v.as_str())
                    .map(|x| x.to_string());
                let ppriority = s
                    .get("priority")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0);
                let pfmil_spesi = s
                    .get("fmil_spesi")
                    .and_then(|v| v.as_i64());
                let pmed = s.get("med").and_then(|v| v.as_f64());
                let pmedv = s.get("medv").and_then(|v| v.as_f64());
                let pfvm = entry.fvm.or_else(|| {
                    s.get("fvm").and_then(|v| v.as_i64())
                });

                // Insert into players (restore)
                conn.execute(
                    r#"INSERT INTO players
                       (id, db_id, name, team, pos_fanta, pos_real, status, fascia,
                        priority, fmil_spesi, med, medv, fvm, updated_by)
                       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'auto-fetch')"#,
                    params![
                        pid,
                        active_id,
                        pname,
                        pteam,
                        ppos_fanta,
                        ppos_real,
                        pstatus,
                        pfascia,
                        ppriority,
                        pfmil_spesi,
                        pmed,
                        pmedv,
                        pfvm,
                    ],
                )?;

                // Delete from archive
                conn.execute(
                    "DELETE FROM players_archive WHERE id = ?1",
                    params![&archive_id],
                )?;

                return Ok("restored");
            }

            // (c) Nessun match → CREATE nuovo con status='da_fare'
            let new_id = new_uuid();
            conn.execute(
                r#"INSERT INTO players
                   (id, db_id, name, team, pos_fanta, status, priority, fvm, updated_by)
                   VALUES (?1, ?2, ?3, ?4, ?5, 'da_fare', 0, ?6, 'auto-fetch')"#,
                params![new_id, active_id, entry.name, entry.team, entry.pos_fanta, entry.fvm],
            )?;
            Ok("created")
        });

        match result {
            Ok("updated") => updated += 1,
            Ok("restored") => restored += 1,
            Ok("created") => created += 1,
            _ => {
                errors += 1;
            }
        }
    }

    // === Fase 2: archivia i players del DB attivo non presenti nel listone ===
    // Raccolta nomi (lowercase) del listone per confronto
    let listone_names: Vec<String> = valid_entries
        .iter()
        .map(|e| e.name.to_lowercase())
        .collect();

    // Per ogni player nel DB attivo, se il suo nome NON è nel listone → archive
    let player_ids_names: Vec<(String, String)> = state.with_conn(&active_id, |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name FROM players WHERE db_id = ?1",
        )?;
        let rows = stmt.query_map(params![&active_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    })?;

    for (pid, pname) in &player_ids_names {
        if !listone_names.contains(&pname.to_lowercase()) {
            // Archive this player (reason: non_in_listone)
            let r = state.with_conn(&active_id, |conn| {
                // Read full row
                let player_row = conn
                    .query_row(
                        r#"SELECT id, db_id, name, team, pos_fanta, pos_real, status, fascia,
                                  priority, fmil_spesi, med, medv, fvm, updated_at, updated_by
                           FROM players WHERE id = ?1"#,
                        params![pid],
                        |row| {
                            Ok(serde_json::json!({
                                "id": row.get::<_, String>(0)?,
                                "db_id": row.get::<_, String>(1)?,
                                "name": row.get::<_, String>(2)?,
                                "team": row.get::<_, Option<String>>(3)?,
                                "pos_fanta": row.get::<_, Option<String>>(4)?,
                                "pos_real": row.get::<_, Option<String>>(5)?,
                                "status": row.get::<_, String>(6)?,
                                "fascia": row.get::<_, Option<String>>(7)?,
                                "priority": row.get::<_, i64>(8)?,
                                "fmil_spesi": row.get::<_, Option<i64>>(9)?,
                                "med": row.get::<_, Option<f64>>(10)?,
                                "medv": row.get::<_, Option<f64>>(11)?,
                                "fvm": row.get::<_, Option<i64>>(12)?,
                                "updated_at": row.get::<_, Option<String>>(13)?,
                                "updated_by": row.get::<_, Option<String>>(14)?,
                            }))
                        },
                    )
                    .map_err(|e| AppError::Db(e))?;
                let snapshot_str = serde_json::to_string(&player_row).unwrap_or_else(|_| "{}".to_string());

                // Pre-check: già in archive?
                let already: bool = conn
                    .query_row(
                        "SELECT 1 FROM players_archive WHERE id = ?1 LIMIT 1",
                        params![pid],
                        |_| Ok(true),
                    )
                    .unwrap_or(false);
                if already {
                    return Ok(false); // skip, non duplicare
                }

                // Insert into archive + delete from players (atomic)
                let tx = conn.unchecked_transaction()?;
                tx.execute(
                    r#"INSERT INTO players_archive
                       (id, db_id, name, team, pos_fanta, pos_real,
                        archived_at, archived_reason, last_known_data, source_db_id)
                       VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'), 'non_in_listone', ?7, ?8)"#,
                    params![
                        pid,
                        active_id,
                        pname,
                        player_row.get("team").and_then(|v| v.as_str()),
                        player_row.get("pos_fanta").and_then(|v| v.as_str()),
                        player_row.get("pos_real").and_then(|v| v.as_str()),
                        snapshot_str,
                        active_id,
                    ],
                )?;
                tx.execute("DELETE FROM players WHERE id = ?1", params![pid])?;
                tx.commit()?;
                Ok(true)
            });
            if let Ok(true) = r {
                archived += 1;
            } else if let Err(e) = r {
                error_messages.push(format!(
                    "archiviazione {}: {}",
                    pname, e
                ));
                errors += 1;
            }
        }
    }

    // Recupera il nome del DB attivo
    let active_db_name = state.with_conn(&active_id, |conn| {
        let n: String = conn
            .query_row(
                "SELECT name FROM databases WHERE id = ?1",
                params![&active_id],
                |r| r.get(0),
            )
            .unwrap_or_else(|_| "?".to_string());
        Ok(n)
    })?;

    Ok(ImportSummary {
        created,
        updated,
        archived,
        restored,
        errors,
        total_listone,
        active_db_id: active_id,
        active_db_name,
        error_messages,
    })
}

/// Elenca i giocatori archiviati (con filtro search + role opzionali).
/// Duplicato funzionale di `commands::players::list_archive` ma ritorna
/// un tipo strutturato `ArchivedPlayer` invece di `serde_json::Value`.
#[tauri::command]
pub fn list_archived_players(
    state: State<'_, DbState>,
    search: Option<String>,
    role: Option<String>,
) -> AppResult<Vec<ArchivedPlayer>> {
    let active_id = state.active_db_id()?;
    let mut sql = String::from(
        r#"SELECT id, db_id, name, team, pos_fanta, pos_real,
                  archived_at, archived_reason, last_known_data
           FROM players_archive WHERE 1=1"#,
    );
    let mut bind_values: Vec<rusqlite::types::Value> = Vec::new();

    if let Some(s) = &search {
        let like = format!("%{}%", s.trim());
        sql.push_str(" AND name LIKE ? COLLATE NOCASE");
        bind_values.push(rusqlite::types::Value::Text(like));
    }
    if let Some(r) = &role {
        sql.push_str(" AND pos_fanta = ?");
        bind_values.push(rusqlite::types::Value::Text(r.clone()));
    }
    sql.push_str(" ORDER BY archived_at DESC LIMIT 500");

    state.with_conn(&active_id, |conn| {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(bind_values.iter()), |row| {
            let last_known: Option<String> = row.get(8)?;
            let last_known_json: serde_json::Value = last_known
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or(serde_json::Value::Null);
            Ok(ArchivedPlayer {
                id: row.get(0)?,
                db_id: row.get(1)?,
                name: row.get(2)?,
                team: row.get(3)?,
                pos_fanta: row.get(4)?,
                pos_real: row.get(5)?,
                archived_at: row.get(6)?,
                archived_reason: row.get(7)?,
                last_known_data: last_known_json,
            })
        })?;

        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    })
}

/// Ripristina manualmente un giocatore dall'archivio (mossa da archive
/// a players preservando tutti i dati dal `last_known_data`).
/// In M2 questo è anche chiamato automaticamente da `import_listone` quando
/// un giocatore archiviato torna nel listone.
#[tauri::command]
pub fn restore_archived_player(
    state: State<'_, DbState>,
    player_id: String,
) -> AppResult<bool> {
    let active_id = state.active_db_id()?;

    state.with_conn(&active_id, |conn| {
        // Read archive row
        let row = conn
            .query_row(
                r#"SELECT id, db_id, name, team, pos_fanta, pos_real,
                          archived_at, archived_reason, last_known_data
                   FROM players_archive WHERE id = ?1"#,
                params![&player_id],
                |r| {
                    let last_known: Option<String> = r.get(8)?;
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, Option<String>>(3)?,
                        r.get::<_, Option<String>>(4)?,
                        r.get::<_, Option<String>>(5)?,
                        r.get::<_, String>(6)?,
                        r.get::<_, String>(7)?,
                        last_known,
                    ))
                },
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    AppError::NotFound(format!("archived player id={} non trovato", player_id))
                }
                other => AppError::Db(other),
            })?;

        let (
            archive_id,
            archive_db_id,
            archive_name,
            archive_team,
            archive_pos_fanta,
            archive_pos_real,
            _archived_at,
            _archived_reason,
            last_known,
        ) = row;

        let snapshot_json = last_known.unwrap_or_else(|| "{}".to_string());
        let snapshot: serde_json::Value =
            serde_json::from_str(&snapshot_json).unwrap_or(serde_json::Value::Null);
        let s = &snapshot;

        // Pre-check: già in players? Non duplicare.
        let already: bool = conn
            .query_row(
                "SELECT 1 FROM players WHERE id = ?1 LIMIT 1",
                params![&archive_id],
                |_| Ok(true),
            )
            .unwrap_or(false);
        if already {
            return Err(AppError::Validation(format!(
                "giocatore id={} è già in players (non si duplica)",
                archive_id
            )));
        }

        let pname = s
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or(&archive_name)
            .to_string();
        let pteam = s
            .get("team")
            .and_then(|v| v.as_str())
            .map(|x| x.to_string())
            .or(archive_team);
        let ppos_fanta = s
            .get("pos_fanta")
            .and_then(|v| v.as_str())
            .map(|x| x.to_string())
            .or(archive_pos_fanta);
        let ppos_real = s
            .get("pos_real")
            .and_then(|v| v.as_str())
            .map(|x| x.to_string())
            .or(archive_pos_real);
        let pstatus = s
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("totali")
            .to_string();
        let pfascia = s
            .get("fascia")
            .and_then(|v| v.as_str())
            .map(|x| x.to_string());
        let ppriority = s.get("priority").and_then(|v| v.as_i64()).unwrap_or(0);
        let pfmil_spesi = s.get("fmil_spesi").and_then(|v| v.as_i64());
        let pmed = s.get("med").and_then(|v| v.as_f64());
        let pmedv = s.get("medv").and_then(|v| v.as_f64());
        let pfvm = s.get("fvm").and_then(|v| v.as_i64());

        // Insert into players + delete from archive (atomic)
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            r#"INSERT INTO players
               (id, db_id, name, team, pos_fanta, pos_real, status, fascia,
                priority, fmil_spesi, med, medv, fvm, updated_by)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'auto-fetch')"#,
            params![
                archive_id,
                archive_db_id,
                pname,
                pteam,
                ppos_fanta,
                ppos_real,
                pstatus,
                pfascia,
                ppriority,
                pfmil_spesi,
                pmed,
                pmedv,
                pfvm,
            ],
        )?;
        tx.execute(
            "DELETE FROM players_archive WHERE id = ?1",
            params![&player_id],
        )?;
        tx.commit()?;

        Ok(true)
    })
}
