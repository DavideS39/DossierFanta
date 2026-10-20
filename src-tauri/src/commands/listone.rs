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
use crate::commands::players::_collect_player_snapshot;
use crate::commands::players::_recreate_connected_tables;
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
///
/// M3a (B.7) — Conflict resolution auto-fetch vs sync-live.
/// Timestamp ISO 8601 UTC del momento in cui il listone è stato
/// scaricato (ListoneData.scraped_at). Se fornito, prima di archiviare
/// un player viene verificato che `players.updated_at <= scraped_at`.
/// Se `updated_at > scraped_at`, il player NON viene archiviato
/// (qualcuno lo sta editando via sync-live o manualmente) e viene
/// emesso un warning in `error_messages`.
/// Se None, il check viene saltato (comportamento M3 pre-M3a).
#[tauri::command]
pub fn import_listone(
    state: State<'_, DbState>,
    players_json: String,
    scraped_at: Option<String>,
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
    let mut skipped_asterisk: Vec<String> = Vec::new();
    let valid_pos = ["P", "D", "C", "A"];
    for (i, e) in entries.into_iter().enumerate() {
        let name = e.name.trim().to_string();
        if name.is_empty() {
            error_messages.push(format!("riga {}: name vuoto, saltato", i + 1));
            continue;
        }
        // M3a.5 — SKIP entries con `*` nel nome. La convenzione di
        // fantacalcio.it è che i giocatori con asterisco sono FUORI
        // SERIE A (es. venduti all'estero, ritirati, in Serie B).
        // Non vanno mai nel `players` table. Vengono saltati qui, e
        // il comando `archive_asterisk_players` (chiamato in fondo a
        // questa funzione) pulisce eventuali asterisk già scivolati
        // nel table da listone precedenti (pre-fix).
        if name.contains('*') {
            log::debug!("[M3a.5] skip entry asterisk (fuori serie A): {}", name);
            skipped_asterisk.push(name.clone());
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
    let mut archived = 0i64; // Fase 2: player del DB attivo assenti dal listone
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
            // M3a.1 — La closure ritorna (archived: bool, warning: Option<String>):
            //   (true, None)            → archived OK
            //   (false, None)           → già in archive, skip silente
            //   (false, Some(msg))      → skip B.7 per edit recente, warning user-facing
            let r = state.with_conn(&active_id, |conn| {
                // ---------------------------------------------------
                // M3a (B.7) — Conflict resolution auto-fetch vs sync-live
                // ---------------------------------------------------
                // Prima di archiviare, verifica se il player ha subito
                // modifiche locali più recenti del listone (sync-live attivo
                // o edit manuale). Se sì, NON archiviare: l'utente lo sta
                // scoutando. Logga warning + skip + segnala alla UI.
                if let Some(ref scraped) = scraped_at {
                    if let Ok(true) = crate::commands::sync::player_has_recent_local_edit(
                        conn, pid, scraped,
                    ) {
                        log::warn!(
                            "[M3a B.7] skip archiviazione {}: updated_at > scraped_at ({}). \
                             Player modificato di recente — verifica manuale.",
                            pname,
                            scraped
                        );
                        let warning = format!(
                            "{}: giocatore non più nel listone ma modificato di recente — verifica manuale",
                            pname
                        );
                        return Ok((false, Some(warning))); // skip, non archiviare
                    }
                }

                // FIX A2 (B5) — Snapshot arricchito via shared helper.
                // Invece di leggere solo la riga di players (M2 base),
                // raccogliamo anche scouting_notes, auction_data,
                // oracolo_projections, pressione_mercato.
                let snapshot_value = _collect_player_snapshot(conn, pid);
                let snapshot_str = serde_json::to_string(&snapshot_value)
                    .unwrap_or_else(|_| "{}".to_string());

                // Estrai i campi minimi dalla riga di players per i metadati
                // dell'archivio (team, pos_fanta, pos_real vanno su players_archive).
                let player_obj = snapshot_value
                    .get("player")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);
                let p_team = player_obj.get("team").and_then(|v| v.as_str());
                let p_pos_fanta = player_obj.get("pos_fanta").and_then(|v| v.as_str());
                let p_pos_real = player_obj.get("pos_real").and_then(|v| v.as_str());

                // Pre-check: già in archive?
                let already: bool = conn
                    .query_row(
                        "SELECT 1 FROM players_archive WHERE id = ?1 LIMIT 1",
                        params![pid],
                        |_| Ok(true),
                    )
                    .unwrap_or(false);
                if already {
                    return Ok((false, None)); // skip, non duplicare
                }

                // Insert into archive + delete from players (atomic via tx).
                // Il DELETE FROM players triggerà ON DELETE CASCADE sulle 4
                // tabelle collegate, ma lo snapshot arricchito le ha già
                // preservate in `last_known_data`.
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
                        p_team,
                        p_pos_fanta,
                        p_pos_real,
                        snapshot_str,
                        active_id,
                    ],
                )?;
                tx.execute("DELETE FROM players WHERE id = ?1", params![pid])?;
                tx.commit()?;
                Ok((true, None))
            });
            match r {
                Ok((true, _)) => {
                    archived += 1;
                }
                Ok((false, Some(warning))) => {
                    // B.7 skip per edit recente — non è errore, ma va segnalato alla UI
                    log::debug!("[M3a] skip archiviazione {} (B.7 edit recente)", pname);
                    error_messages.push(warning);
                }
                Ok((false, None)) => {
                    // skip silente: già in archive
                    log::debug!("[M3a] skip archiviazione {} (già in archive)", pname);
                }
                Err(e) => {
                    error_messages.push(format!(
                        "archiviazione {}: {}",
                        pname, e
                    ));
                    errors += 1;
                }
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

    // M3a.5 — Pulizia post-import: archivia eventuali giocatori con `*`
    // nel nome ancora presenti nel `players` table. Questi sono asterisk
    // scivolati dentro da versioni precedenti del listone (pre-fix del
    // filtro). NON distruttivo: il snapshot arricchito va su
    // `last_known_data` in `players_archive`. Se l'utente ha editato
    // recentemente uno di questi player (updated_at > scraped_at),
    // viene skippato (conflict resolution B.7).
    let asterisk_archived = match archive_asterisk_players_inner(&*state, &active_id, scraped_at.as_deref()) {
        Ok(n) => {
            if n > 0 {
                log::info!(
                    "[M3a.5] import_listone: archiviati {} giocatori asterisk (fuori serie A)",
                    n
                );
                error_messages.push(format!(
                    "Archiviati {} giocatori con asterisco (fuori serie A, non più nel listone).",
                    n
                ));
            }
            n
        }
        Err(e) => {
            log::warn!("[M3a.5] archive_asterisk_players fallito (non blocking): {}", e);
            0
        }
    };
    let _ = asterisk_archived; // incluso implicitamente in `archived` count via side-effect? No — somma separata.
    if !skipped_asterisk.is_empty() {
        log::info!(
            "[M3a.5] import_listone: saltate {} entry con asterisco (non importate)",
            skipped_asterisk.len()
        );
    }

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
///
/// FIX A3 (B12): ora il restore legge lo snapshot arricchito in
/// `last_known_data` (player + scouting_notes + auction_data +
/// oracolo_projections + pressione_mercato) e ricrea PRIMA le righe nelle
/// tabelle collegate POI sposta il player da archive a players, usando una
/// singola transazione SQLite per atomicità. In M2 base il restore non
/// ricreava i collegati perché il DELETE CASCADE li aveva cancellati.
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

        // FIX A3 (B12): Snapshot arricchito. Lo snapshot ha due forme possibili:
        //  - Forma M2.1 arricchita: {player: {...}, scouting_notes: [...], ...}
        //  - Forma M2 base legacy: {...} (direttamente i campi del player)
        // Rileviamo: se esiste la chiave "player", è la forma arricchita.
        let is_enriched = snapshot.get("player").is_some();

        // Estrai i dati del player (gestisce entrambe le forme)
        let player_data = if is_enriched {
            snapshot.get("player").cloned().unwrap_or(serde_json::Value::Null)
        } else {
            snapshot.clone()
        };
        let s = &player_data;

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

        // FIX A3 (B12): transazione atomica che:
        //   1. Inserisce la riga in players (prima le FK referenziano players.id)
        //   2. Ricrea le righe nelle tabelle collegate (scouting_notes, auction_data,
        //      oracolo_projections, pressione_mercato) dallo snapshot arricchito
        //   3. Cancella la riga da players_archive
        // Tutto in un'unica tx: se qualsiasi passo fallisce, rollback completo.
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

        // Ricrea le tabelle collegate solo se lo snapshot è arricchito (M2.1).
        // Nota: passiamo &tx (=&Transaction<'_>) che viene deref-coerced a
        // &Connection perché Transaction implementa Deref<Target = Connection>.
        if is_enriched {
            _recreate_connected_tables(&tx, &snapshot).map_err(AppError::Db)?;
        }

        tx.execute(
            "DELETE FROM players_archive WHERE id = ?1",
            params![&player_id],
        )?;
        tx.commit()?;

        Ok(true)
    })
}

// ----------------------------------------------------------------------
// M2.1 — FIX A5 (B7): preview_import_listone
// ----------------------------------------------------------------------
//
// Esegue lo stesso matching di `import_listone` MA SENZA APPLICARE MODIFICHE.
// Restituisce 4 liste dettagliate (created, archived, updated, restored)
// che l'UI mostra in un modale di anteprima prima di abilitare il pulsante
// "Applica". Solo dopo conferma, il frontend chiama il vero `import_listone`.
//
// Le liste ritornate sono strutturate per essere mostrate direttamente
// in una tabella di anteprima (nome, squadra, ruolo, fvm nuovo/vecchio).

/// Voce di anteprima per un giocatore che verrà CREATO (non esiste nel DB).
#[derive(Debug, Serialize)]
pub struct PreviewCreated {
    pub name: String,
    pub team: Option<String>,
    pub pos_fanta: Option<String>,
    pub fvm: Option<i64>,
}

/// Voce di anteprima per un giocatore che verrà ARCHIVIATO (presente nel DB,
/// NON presente nel listone).
#[derive(Debug, Serialize)]
pub struct PreviewArchived {
    pub id: String,
    pub name: String,
    pub team: Option<String>,
    pub reason: String,
}

/// Voce di anteprima per un giocatore che verrà AGGIORNATO (FVM nuovo diverso
/// dal FVM attuale).
#[derive(Debug, Serialize)]
pub struct PreviewUpdated {
    pub id: String,
    pub name: String,
    pub field_changed: String,
    pub old: serde_json::Value,
    pub new: serde_json::Value,
}

/// Voce di anteprima per un giocatore che verrà RIPRISTINATO dall'archivio
/// (presente in players_archive, presente nel listone).
#[derive(Debug, Serialize)]
pub struct PreviewRestored {
    pub id: String,
    pub name: String,
    pub team: Option<String>,
}

/// Risultato della preview: 4 liste + totali.
#[derive(Debug, Serialize)]
pub struct ImportPreview {
    pub created: Vec<PreviewCreated>,
    pub archived: Vec<PreviewArchived>,
    pub updated: Vec<PreviewUpdated>,
    pub restored: Vec<PreviewRestored>,
    pub total_listone: i64,
    pub active_db_id: String,
    pub active_db_name: String,
}

/// Esegue l'anteprima dell'import: calcola cosa succederebbe senza toccare
/// il DB. L'UI mostra questo risultato in un modale di conferma.
#[tauri::command]
pub fn preview_import_listone(
    state: State<'_, DbState>,
    players_json: String,
) -> AppResult<ImportPreview> {
    let entries: Vec<ListoneEntry> = serde_json::from_str(&players_json).map_err(|e| {
        AppError::Validation(format!(
            "JSON listone non valido: {}. Formato atteso: [{{\"name\":\"...\",\"team\":\"...\",\"pos_fanta\":\"A\",\"fvm\":32}}, ...]",
            e
        ))
    })?;

    let active_id = state.active_db_id()?;

    // Valida le entry come in import_listone (skip righe senza name, ecc.)
    let mut valid_entries: Vec<ListoneEntry> = Vec::new();
    let valid_pos = ["P", "D", "C", "A"];
    for (i, e) in entries.into_iter().enumerate() {
        let name = e.name.trim().to_string();
        if name.is_empty() {
            // skip silently nella preview (gli errori sono raccolti in import vero)
            let _ = i;
            continue;
        }
        if let Some(p) = &e.pos_fanta {
            if !valid_pos.contains(&p.as_str()) {
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

    // === Fase 1: per ogni entry, decidi created/updated/restored (no write) ===
    // MatchResult enum tiene il risultato della closure: una sola variante,
    // dispatchato al loop esterno. Senza questo trucco, la closure dovrebbe
    // ritornare `Some(PreviewCreated | PreviewUpdated | PreviewRestored)` che
    // in Rust richiede enum esplicita.
    enum MatchResult {
        Created(PreviewCreated),
        Updated(PreviewUpdated),
        Restored(PreviewRestored),
        Unchanged,
    }

    let mut created: Vec<PreviewCreated> = Vec::new();
    let mut updated: Vec<PreviewUpdated> = Vec::new();
    let mut restored: Vec<PreviewRestored> = Vec::new();

    // Lista nomi lowercase del listone (per Fase 2)
    let listone_names: Vec<String> = valid_entries
        .iter()
        .map(|e| e.name.to_lowercase())
        .collect();

    for entry in &valid_entries {
        let r = state.with_conn(&active_id, |conn| {
            // (a) Match in players?
            let player_match: Option<(String, Option<i64>)> = conn
                .query_row(
                    "SELECT id, fvm FROM players WHERE db_id = ?1 AND LOWER(name) = LOWER(?2) LIMIT 1",
                    params![&active_id, &entry.name],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?)),
                )
                .ok();
            if let Some((pid, current_fvm)) = player_match {
                // UPDATED se FVM diverso
                if entry.fvm.is_some() && entry.fvm != current_fvm {
                    return Ok(MatchResult::Updated(PreviewUpdated {
                        id: pid,
                        name: entry.name.clone(),
                        field_changed: "fvm".to_string(),
                        old: serde_json::Value::from(current_fvm.unwrap_or(0)),
                        new: serde_json::Value::from(entry.fvm.unwrap_or(0)),
                    }));
                }
                return Ok(MatchResult::Unchanged); // già allineato
            }

            // (b) Match in players_archive?
            let archive_match: Option<(String, Option<String>)> = conn
                .query_row(
                    "SELECT id, team FROM players_archive WHERE db_id = ?1 AND LOWER(name) = LOWER(?2) LIMIT 1",
                    params![&active_id, &entry.name],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)),
                )
                .ok();
            if let Some((aid, ateam)) = archive_match {
                return Ok(MatchResult::Restored(PreviewRestored {
                    id: aid,
                    name: entry.name.clone(),
                    team: ateam.or_else(|| entry.team.clone()),
                }));
            }

            // (c) CREATED
            Ok(MatchResult::Created(PreviewCreated {
                name: entry.name.clone(),
                team: entry.team.clone(),
                pos_fanta: entry.pos_fanta.clone(),
                fvm: entry.fvm,
            }))
        });
        match r {
            Ok(MatchResult::Created(p)) => created.push(p),
            Ok(MatchResult::Updated(p)) => updated.push(p),
            Ok(MatchResult::Restored(p)) => restored.push(p),
            Ok(MatchResult::Unchanged) => {}
            Err(_) => {}
        }
    }

    // === Fase 2: archived preview ===
    let player_ids_names: Vec<(String, String, Option<String>)> = state.with_conn(&active_id, |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, team FROM players WHERE db_id = ?1",
        )?;
        let rows = stmt.query_map(params![&active_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    })?;

    let mut archived: Vec<PreviewArchived> = Vec::new();
    for (pid, pname, pteam) in &player_ids_names {
        if !listone_names.contains(&pname.to_lowercase()) {
            archived.push(PreviewArchived {
                id: pid.clone(),
                name: pname.clone(),
                team: pteam.clone(),
                reason: "non_in_listone".to_string(),
            });
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

    Ok(ImportPreview {
        created,
        archived,
        updated,
        restored,
        total_listone,
        active_db_id: active_id,
        active_db_name,
    })
}

// ----------------------------------------------------------------------
// M3 — Auto-fetch listone via GitHub Releases (Cap.7 design doc v2.5)
// ----------------------------------------------------------------------
//
// Quattro comandi Tauri per implementare l'auto-fetch del listone:
//
//   1. check_latest_listone_version() -> ListoneVersionInfo
//      GET https://api.github.com/repos/{owner}/dossier-fanta-data/releases/latest
//      NON scarica il file, solo metadata. Usa reqwest con user-agent
//      "DossierFanta/0.3.0" (GitHub API richiede user-agent obbligatorio).
//
//   2. download_listone(asset_url) -> ListoneData
//      Streaming download del players.json, salvato in cache locale
//      (app_data_dir/cache/listone.json). Authorization: Bearer ${GITHUB_TOKEN}
//      opzionale per rate limit più alto (60 req/h senza, 5000 con token).
//
//   3. apply_auto_fetch(listone_data) -> ImportSummary
//      Riusa la logica di import_listone: Fase 1 match, Fase 2 archive,
//      Fase 3 create, Fase 4 update fvm con marker updated_by='auto-fetch'.
//      Salva il tag applicato in cache/last_applied_tag.txt.
//
//   4. scrape_listone_inline() -> ListoneData
//      FALLBACK se GitHub irraggiungibile. Scraper Rust embedded che
//      scarica fantacalcio.it e applica gli stessi selettori del parser
//      Python in dossier-fanta-data/scraper/scrape_fantacalcio.py.
//      ~10-15 secondi. Logging esteso per diagnostica.
//
// Cache locale:
//   - app_data_dir/cache/listone.json      (ultimo release scaricato)
//   - app_data_dir/cache/last_applied_tag.txt (tag applicato, per skip al boot)
//   - app_data_dir/cache/update_log.json   (log ultimi 5 aggiornamenti)
//
// L'auto-fetch NON si triggera in modo invisibile all'avvio: il frontend
// (App.tsx) chiama check_latest_listone_version al mount, confronta con
// last_applied_tag.txt, se diverso mostra toast "aggiornamento disponibile"
// e l'utente DEVE clickare per applicare (archiviazione irreversibile).

use std::path::PathBuf;

/// Repository GitHub che ospita le release con players.json.
/// Costante centralizzata — se il repo si sposta, cambiare qui.
const DATA_REPO_OWNER: &str = "DavideS39";
const DATA_REPO_NAME: &str = "DossierFanta-Data";

const HTTP_USER_AGENT: &str = "DossierFanta/0.3.4 (+https://github.com/DavideS39/DossierFanta)";


/// Endpoint API GitHub per l'ultima release pubblica.
fn latest_release_api_url() -> String {
    format!(
        "https://api.github.com/repos/{}/{}/releases/latest",
        DATA_REPO_OWNER, DATA_REPO_NAME
    )
}

/// Metadati dell'ultima release disponibile (NON scarica il file).
/// Risposta tipica:
///   {
///     "tag_name": "data-2026-10-13-abc123def456",
///     "name": "Listone Serie A 2026-10-13",
///     "published_at": "2026-10-13T01:05:12Z",
///     "assets": [
///       { "name": "players.json", "url": "...", "browser_download_url": "...",
///         "size": 524288, "api_url": "..." }
///     ]
///   }
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListoneVersionInfo {
    pub tag: String,
    pub name: String,
    pub published_at: String,
    /// URL pubblico per il download diretto del file players.json.
    pub asset_url: String,
    /// Dimensione in bytes del file players.json (per progress UI).
    pub asset_size_bytes: u64,
    /// True se la release ha un asset "players.json" (sanity check).
    pub has_players_json: bool,
}

/// Rappresentazione del file players.json scaricato dal repo dossier-fanta-data.
/// `entries` è la lista di giocatori nel formato atteso da import_listone.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListoneData {
    /// Tag della release da cui deriva questo dato (per cache + skip).
    pub tag: String,
    /// Versione del dato (YYYY-MM-DD dal JSON source).
    pub version: String,
    /// Timestamp ISO UTC di scraping (dal JSON source).
    pub scraped_at: String,
    /// Lista giocatori nel formato atteso da import_listone.
    pub entries: Vec<ListoneEntry>,
    /// True se il dato deriva dal fallback inline scraper (per UI).
    pub from_fallback: bool,
}

/// Voce del log storico aggiornamenti (ultimi 5).
/// Salvato in cache/update_log.json.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateLogEntry {
    /// Timestamp ISO UTC dell'apply.
    pub applied_at: String,
    /// Tag della release applicata.
    pub tag: String,
    /// Sorgente: "github" se dalla release, "fallback" se scraper inline.
    pub source: String,
    /// Riassunto operazioni DB.
    pub created: i64,
    pub archived: i64,
    pub updated: i64,
    pub restored: i64,
}

/// Risolve il path della directory cache locale dell'app.
/// - Windows: %APPDATA%/com.dossierfanta.app/cache/
/// - macOS:   ~/Library/Application Support/com.dossierfanta.app/cache/
/// - Linux:   ~/.local/share/com.dossierfanta.app/cache/
///
/// Usa la crate `dirs` (già in Cargo.toml) coerente con
/// `resolve_app_data_dir_early()` in lib.rs.
fn cache_dir() -> PathBuf {
    let base = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("com.dossierfanta.app").join("cache")
}

/// Path del file JSON cached (ultimo release scaricato).
fn cache_listone_path() -> PathBuf {
    cache_dir().join("listone.json")
}

/// Path del file che contiene il tag dell'ultimo release applicato.
fn cache_last_applied_tag_path() -> PathBuf {
    cache_dir().join("last_applied_tag.txt")
}

/// Path del file log storico aggiornamenti.
fn cache_update_log_path() -> PathBuf {
    cache_dir().join("update_log.json")
}

/// Legge il tag dell'ultimo release applicato (se esiste).
fn read_last_applied_tag() -> Option<String> {
    let p = cache_last_applied_tag_path();
    match std::fs::read_to_string(&p) {
        Ok(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        _ => None,
    }
}

/// Scrive il tag dell'ultimo release applicato.
fn write_last_applied_tag(tag: &str) -> std::io::Result<()> {
    let p = cache_last_applied_tag_path();
    std::fs::create_dir_all(p.parent().unwrap_or(&p))?;
    std::fs::write(&p, tag)
}

/// Legge il log storico (ultimi 5). Se il file non esiste, ritorna vuoto.
fn read_update_log() -> Vec<UpdateLogEntry> {
    let p = cache_update_log_path();
    match std::fs::read_to_string(&p) {
        Ok(s) if !s.trim().is_empty() => {
            serde_json::from_str(&s).unwrap_or_default()
        }
        _ => Vec::new(),
    }
}

/// Aggiunge una entry al log, mantenendo solo gli ultimi 5.
fn append_update_log(entry: UpdateLogEntry) {
    let mut log = read_update_log();
    log.insert(0, entry);
    log.truncate(5);
    let p = cache_update_log_path();
    if let Err(e) = std::fs::create_dir_all(p.parent().unwrap_or(&p)) {
        eprintln!("[M3] WARN: cannot create cache dir: {}", e);
        return;
    }
    if let Ok(json) = serde_json::to_string_pretty(&log) {
        if let Err(e) = std::fs::write(&p, json) {
            eprintln!("[M3] WARN: cannot write update log: {}", e);
        }
    }
}

// ----------------------------------------------------------------------
// Comando 1: check_latest_listone_version
// ----------------------------------------------------------------------

/// Interroga GitHub API per i metadati dell'ultima release del repo
/// dossier-fanta-data. NON scarica il file.
///
/// Rate limit: 60 req/h senza token, 5000 con token. L'app fa una sola
/// chiamata all'avvio, quindi 60 req/h sono ampiamente sufficienti.
///
/// Errors:
///   - NetworkError: GitHub irraggiungibile o risposta non 200.
///   - ParseError: JSON risposta non valido o senza asset players.json.
#[tauri::command]
pub async fn check_latest_listone_version() -> AppResult<ListoneVersionInfo> {
    let client = reqwest::Client::builder()
        .user_agent(HTTP_USER_AGENT)
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| AppError::Generic(format!("reqwest client build: {}", e)))?;

    let mut req = client.get(latest_release_api_url());
    // Authorization opzionale: se GITHUB_TOKEN env var è presente, la usiamo
    // per rate limit 5000/h invece di 60/h. L'endpoint pubblico funziona
    // anche senza token, quindi è opzionale.
    if let Ok(token) = std::env::var("GITHUB_TOKEN") {
        req = req.bearer_auth(&token);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| AppError::Generic(format!("GitHub API unreachable: {}", e)))?;

    if !resp.status().is_success() {
        return Err(AppError::Generic(format!(
            "GitHub API non-200: {} {}",
            resp.status().as_u16(),
            resp.status().canonical_reason().unwrap_or("")
        )));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| AppError::Generic(format!("GitHub API JSON parse: {}", e)))?;

    let tag = json
        .get("tag_name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::Generic("release: manca tag_name".into()))?
        .to_string();
    let name = json
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let published_at = json
        .get("published_at")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    // Cerca l'asset players.json
    let assets = json.get("assets").and_then(|v| v.as_array());
    let (asset_url, asset_size_bytes, has_players_json) = match assets {
        Some(arr) => {
            let mut url = String::new();
            let mut size = 0u64;
            let mut found = false;
            for a in arr {
                let name = a.get("name").and_then(|v| v.as_str()).unwrap_or("");
                if name == "players.json" {
                    url = a
                        .get("browser_download_url")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    size = a.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
                    found = true;
                    break;
                }
            }
            (url, size, found)
        }
        None => (String::new(), 0, false),
    };

    if !has_players_json {
        return Err(AppError::Generic(
            "Release senza asset players.json — workflow scrape.yml incompleto?".into(),
        ));
    }

    Ok(ListoneVersionInfo {
        tag,
        name,
        published_at,
        asset_url,
        asset_size_bytes,
        has_players_json,
    })
}

// ----------------------------------------------------------------------
// Comando 2: download_listone
// ----------------------------------------------------------------------

/// Scarica il players.json dal URL dell'asset GitHub Release.
/// Streaming response (file può essere 500KB-2MB). Salva in cache locale.
///
/// Rate limit note: il download dell'asset NON conta come API call GitHub
/// (è un redirect a S3/githubusercontent.com), quindi è illimitato.
///
/// Errors:
///   - NetworkError: download fallito.
///   - ParseError: JSON scaricato non valido.
#[tauri::command]
pub async fn download_listone(
    asset_url: String,
    tag: String,
) -> AppResult<ListoneData> {
    let client = reqwest::Client::builder()
        .user_agent(HTTP_USER_AGENT)
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| AppError::Generic(format!("reqwest client build: {}", e)))?;

    eprintln!("[M3] download_listone: GET {}", asset_url);
    let resp = client
        .get(&asset_url)
        .header("Accept", "application/octet-stream")
        .send()
        .await
        .map_err(|e| AppError::Generic(format!("download fallito: {}", e)))?;

    if !resp.status().is_success() {
        return Err(AppError::Generic(format!(
            "download non-200: {}",
            resp.status()
        )));
    }

    let body = resp
        .bytes()
        .await
        .map_err(|e| AppError::Generic(format!("download body: {}", e)))?;

    eprintln!(
        "[M3] download_listone: {} bytes ricevuti",
        body.len()
    );

    // Salva in cache locale per evitare re-download
    let cache_path = cache_listone_path();
    if let Err(e) = std::fs::create_dir_all(cache_path.parent().unwrap_or(&cache_path)) {
        eprintln!("[M3] WARN: cannot create cache dir: {}", e);
    } else if let Err(e) = std::fs::write(&cache_path, &body) {
        eprintln!("[M3] WARN: cannot write cache file: {}", e);
    } else {
        eprintln!("[M3] cache salvata: {}", cache_path.display());
    }

    parse_listone_json(&body, &tag, false)
}

/// Parse JSON in formato players.json (dal repo dossier-fanta-data o dal
/// fallback inline scraper). Converte nel formato atteso da import_listone.
fn parse_listone_json(
    body: &[u8],
    tag: &str,
    from_fallback: bool,
) -> AppResult<ListoneData> {
    let raw: serde_json::Value = serde_json::from_slice(body).map_err(|e| {
        AppError::Generic(format!(
            "players.json non valido: {}. Formato atteso: {{version, source, scraped_at, players: [...]}}",
            e
        ))
    })?;

    let version = raw
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let scraped_at = raw
        .get("scraped_at")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let players = raw
        .get("players")
        .and_then(|v| v.as_array())
        .ok_or_else(|| AppError::Generic("players.json: manca chiave 'players'".into()))?;

    let mut entries: Vec<ListoneEntry> = Vec::with_capacity(players.len());
    let mut errors = 0usize;
    for (i, p) in players.iter().enumerate() {
        let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("").trim();
        if name.is_empty() {
            eprintln!("[M3] WARN: riga {} senza name, saltata", i);
            errors += 1;
            continue;
        }
        let team = p.get("team").and_then(|v| v.as_str()).map(|s| s.to_string());
        // Il JSON del repo usa "ruolo_fanta", ma import_listone si aspetta "pos_fanta".
        // Accettiamo entrambi per robustezza.
        let pos_fanta = p
            .get("ruolo_fanta")
            .or_else(|| p.get("pos_fanta"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let fvm = p.get("fvm").and_then(|v| v.as_i64());

        entries.push(ListoneEntry {
            name: name.to_string(),
            team,
            pos_fanta,
            fvm,
        });
    }

    if entries.is_empty() {
        return Err(AppError::Generic(
            "players.json: nessuna entry valida dopo parsing".into(),
        ));
    }

    eprintln!(
        "[M3] parse_listone_json: {} entries ({} scartate)",
        entries.len(),
        errors
    );

    Ok(ListoneData {
        tag: tag.to_string(),
        version,
        scraped_at,
        entries,
        from_fallback,
    })
}

// ----------------------------------------------------------------------
// Comando 3: apply_auto_fetch
// ----------------------------------------------------------------------

/// Applica un ListoneData scaricato al DB attivo. Riusa la logica di
/// import_listone (Fase 1 match + Fase 2 archive + Fase 3 create +
/// Fase 4 update fvm con marker updated_by='auto-fetch').
///
/// Salva il tag in cache/last_applied_tag.txt e aggiunge una entry al
/// log storico (ultimi 5).
///
/// Il frontend DEVE aver mostrato anteprima diff prima di chiamare questo
/// comando — l'archiviazione è irreversibile senza restore esplicito.
#[tauri::command]
pub fn apply_auto_fetch(
    state: State<'_, DbState>,
    listone_data: ListoneData,
) -> AppResult<ImportSummary> {
    eprintln!(
        "[M3] apply_auto_fetch: tag={}, {} entries, from_fallback={}",
        listone_data.tag,
        listone_data.entries.len(),
        listone_data.from_fallback
    );

    // Serializza le entries nel formato JSON atteso da import_listone
    // (array di {name, team, pos_fanta, fvm}).
    let players_json = serde_json::to_string(&listone_data.entries).map_err(|e| {
        AppError::Generic(format!("serialize entries: {}", e))
    })?;

    // Delega alla logica esistente di import_listone (Fase 1-4 + archive).
    // M3a.1 (PB1 fix) — Passa scraped_at per attivare la conflict resolution
    // auto-fetch vs sync-live (B.7). In precedenza il 3° argomento era omesso,
    // lasciando il check `player_has_recent_local_edit` come dead code.
    let summary = import_listone(
        state,
        players_json,
        Some(listone_data.scraped_at.clone()),
    )?;

    // Salva il tag applicato + log
    if let Err(e) = write_last_applied_tag(&listone_data.tag) {
        eprintln!("[M3] WARN: cannot write last_applied_tag: {}", e);
    }
    let log_entry = UpdateLogEntry {
        applied_at: chrono::Utc::now().to_rfc3339(),
        tag: listone_data.tag.clone(),
        source: if listone_data.from_fallback {
            "fallback".to_string()
        } else {
            "github".to_string()
        },
        created: summary.created,
        archived: summary.archived,
        updated: summary.updated,
        restored: summary.restored,
    };
    append_update_log(log_entry);

    Ok(summary)
}

// ----------------------------------------------------------------------
// Comando 4: scrape_listone_inline (FALLBACK)
// ----------------------------------------------------------------------

/// Fallback se GitHub irraggiungibile. Scraper Rust embedded che scarica
/// fantacalcio.it e applica gli stessi selettori del parser Python.
///
/// ~10-15 secondi. Genera ListoneData con from_fallback=true, così la UI
/// può mostrare un badge distintivo nel log.
///
/// Non viene usato per default — solo quando l'utente clicca "Fallback:
/// scarica da fantacalcio.it" nella schermata Aggiornamenti.
#[tauri::command]
pub async fn scrape_listone_inline() -> AppResult<ListoneData> {
    use scraper::{Html, Selector};

    const URL: &str = "https://www.fantacalcio.it/quotazioni-fantacalcio";
    eprintln!("[M3] scrape_listone_inline: GET {}", URL);

    let client = reqwest::Client::builder()
        .user_agent(HTTP_USER_AGENT)
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| AppError::Generic(format!("reqwest build: {}", e)))?;

    let resp = client
        .get(URL)
        .send()
        .await
        .map_err(|e| AppError::Generic(format!("fetch fantacalcio.it: {}", e)))?;

    if !resp.status().is_success() {
        return Err(AppError::Generic(format!(
            "fantacalcio.it non-200: {}",
            resp.status()
        )));
    }

    let body = resp
        .bytes()
        .await
        .map_err(|e| AppError::Generic(format!("body: {}", e)))?;

    let html = String::from_utf8_lossy(&body);
    let document = Html::parse_document(&html);

    // Selettori coerenti con scraper/scrape_fantacalcio.py
    // M3.1 (FIX A2 — bug B1 ispezione M3): aggiornati al HTML reale di
    // fantacalcio.it (ottobre 2026):
    //   <tr class="player-row" data-filter-role-classic="a" ...>
    //     <th class="player-role player-role-classic"><span class="role" data-value="a"></span></th>
    //     <th class="player-role player-role-mantra"><span class="role role-mantra" data-value="pc" title="Punta"></span></th>
    //     <th class="player-name">...<span>Martinez L.</span></th>
    //     <td class="player-team">INT</td>
    //     <td class="player-classic-current-price">36</td>
    //     <td class="player-classic-fvm">410</td>
    //     <td class="player-mantra-fvm">410</td>
    //   </tr>
    let row_sel = Selector::parse(
        "tr.player-row, \
         table.quotazioni tbody tr, \
         div.player-list tr.player-row, \
         table tbody tr[data-player]",
    )
    .map_err(|e| AppError::Generic(format!("selector row: {}", e)))?;
    // name: aggiunto th.player-name per HTML reale fantacalcio.it
    let name_sel = Selector::parse("td.name, th.player-name, .player-name")
        .map_err(|e| AppError::Generic(format!("selector name: {}", e)))?;
    // team: inalterato
    let team_sel = Selector::parse("td.team, .player-team")
        .map_err(|e| AppError::Generic(format!("selector team: {}", e)))?;
    // ruolo_reale: title del nested span.role dentro .player-role-mantra
    let role_real_sel = Selector::parse(".player-role-mantra .role[title]")
        .map_err(|e| AppError::Generic(format!("selector role_real: {}", e)))?;
    // fvm: privilegia player-classic-fvm, fallback player-mantra-fvm
    let fvm_sel = Selector::parse(
        "td.player-classic-fvm, td.player-mantra-fvm, td.fvm, .player-fvm",
    )
    .map_err(|e| AppError::Generic(format!("selector fvm: {}", e)))?;
    // quotazione: privilegia player-classic-current-price (QA).
    // Nota: il parser Rust inline (fallback) NON estrae quotazione perché la
    // struct `ListoneEntry` ha solo {name, team, pos_fanta, fvm} — sufficienti
    // per import_listone. Il parser Python nel workflow GitHub estrae anche
    // quotazione_ufficiale nel players.json del release.
    // Il selettore è comunque definito qui per coerenza con il parser Python
    // e per facilitare l'estensione futura.
    let _quot_sel = Selector::parse(
        "td.player-classic-current-price, \
         td.player-mantra-current-price, \
         td.quotation, .player-quotation",
    )
    .map_err(|e| AppError::Generic(format!("selector quot: {}", e)))?;
    // ruolo_fanta: attr data-filter-role-classic sul <tr> + fallback nested span[data-value]
    let role_value_sel = Selector::parse("[data-value]")
        .map_err(|e| AppError::Generic(format!("selector role_value: {}", e)))?;

    // Fallback adattivo: se il selettore primario matcha poche righe
    let row_count = document.select(&row_sel).count();
    eprintln!("[M3] fallback: {} righe matchate dal selettore primario", row_count);

    let entries_iter: Vec<ListoneEntry> = document
        .select(&row_sel)
        .filter_map(|row| {
            let name_el = row.select(&name_sel).next();
            let name = match name_el {
                Some(el) => el.text().collect::<String>(),
                None => {
                    // fallback via data-player attribute
                    row.value().attr("data-player").map(|s| s.to_string())?
                }
            };
            let name = normalize_string(&name);
            if name.is_empty() {
                return None;
            }
            let team = row
                .select(&team_sel)
                .next()
                .map(|el| normalize_string(&el.text().collect::<String>()))
                .filter(|s| !s.is_empty());

            // --- ruolo_fanta: attr data-filter-role-classic sul <tr>,
            // fallback data-value sul nested span.role
            let pos_fanta: Option<String> = row
                .value()
                .attr("data-filter-role-classic")
                .map(|s| s.trim().to_uppercase())
                .or_else(|| {
                    row.select(&role_value_sel)
                        .next()
                        .and_then(|el| el.value().attr("data-value"))
                        .map(|s| s.trim().to_uppercase())
                })
                .filter(|s| !s.is_empty())
                .and_then(|s| match s.as_str() {
                    "P" | "D" | "C" | "A" => Some(s),
                    other => other
                        .chars()
                        .next()
                        .filter(|c| matches!(c, 'P' | 'D' | 'C' | 'A'))
                        .map(|c| c.to_string()),
                });

            // --- ruolo_reale: attr title del nested span dentro .player-role-mantra
            let _pos_real: Option<String> = row
                .select(&role_real_sel)
                .next()
                .and_then(|el| el.value().attr("title"))
                .map(|s| s.trim().to_string());

            let fvm = row
                .select(&fvm_sel)
                .next()
                .and_then(|el| parse_first_int(&el.text().collect::<String>()));

            // --- sanity check locale (mirror FIX A3 Python): se il 90%+ delle
            // righe non ha fvm, i selettori sono rotti
            // (controllo globale lasciato ad assert_valid lato Python nel workflow
            // GitHub Actions; qui logghiamo solo le righe senza fvm)

            Some(ListoneEntry {
                name,
                team,
                pos_fanta,
                fvm,
            })
        })
        .collect();

    if entries_iter.is_empty() {
        return Err(AppError::Generic(
            "Scraper inline: nessun giocatore estratto. Il sito fantacalcio.it ha probabilmente \
             cambiato layout — aggiornare i selettori in commands/listone.rs (funzione \
             scrape_listone_inline) e in scraper/scrape_fantacalcio.py del repo dossier-fanta-data."
                .into(),
        ));
    }

    // FIX A3 (mirror Rust): se <90% delle entries ha fvm Some, i selettori
    // sono probabilmente rotti. Solleva errore esplicito.
    let fvm_count = entries_iter.iter().filter(|e| e.fvm.is_some()).count();
    if fvm_count < entries_iter.len() * 9 / 10 {
        return Err(AppError::Generic(format!(
            "Scraper inline: solo {}/{} giocatori con FVM non-None. \
             Selettori HTML probabilmente rotti — aggiornare i selettori in \
             commands/listone.rs (funzione scrape_listone_inline).",
            fvm_count,
            entries_iter.len()
        )));
    }

    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let scraped_at = chrono::Utc::now().to_rfc3339();

    eprintln!(
        "[M3] scrape_listone_inline: {} giocatori estratti (fallback)",
        entries_iter.len()
    );

    Ok(ListoneData {
        tag: format!("fallback-{}", today),
        version: today,
        scraped_at,
        entries: entries_iter,
        from_fallback: true,
    })
}

/// Normalizza una stringa: trim + collapse spazi multipli + capitalize prima lettera.
fn normalize_string(s: &str) -> String {
    let cleaned: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if cleaned.is_empty() {
        return String::new();
    }
    let mut chars = cleaned.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// Estrae il primo intero da una stringa tipo "38 f₥" o "38" → Some(38).
fn parse_first_int(s: &str) -> Option<i64> {
    let cleaned = s.replace('\u{20a5}', "").replace(',', "");
    let mut buf = String::new();
    let mut started = false;
    let mut neg = false;
    for ch in cleaned.chars() {
        if ch == '-' && !started {
            neg = true;
            continue;
        }
        if ch.is_ascii_digit() {
            buf.push(ch);
            started = true;
        } else if started {
            break;
        }
    }
    if buf.is_empty() {
        return None;
    }
    let mut n: i64 = buf.parse().ok()?;
    if neg {
        n = -n;
    }
    Some(n)
}

// ----------------------------------------------------------------------
// Comandi ausiliari per la UI Aggiornamenti
// ----------------------------------------------------------------------

/// Ritorna lo stato corrente dell'auto-fetch: tag applicato (se in cache),
/// lista degli ultimi 5 aggiornamenti (dal log).
/// NON fa chiamate di rete — è una lettura cache locale.
#[tauri::command]
pub fn get_autofetch_status() -> AppResult<AutoFetchStatus> {
    let last_applied_tag = read_last_applied_tag().unwrap_or_default();
    let update_log = read_update_log();
    Ok(AutoFetchStatus {
        last_applied_tag,
        cache_path: cache_listone_path().to_string_lossy().to_string(),
        update_log,
    })
}

/// Stato dell'auto-fetch per la UI Aggiornamenti.
#[derive(Debug, Clone, Serialize)]
pub struct AutoFetchStatus {
    /// Tag dell'ultimo release applicato (vuoto se mai applicato).
    pub last_applied_tag: String,
    /// Path del file cache locale (per debugging UI).
    pub cache_path: String,
    /// Ultime 5 entry di aggiornamento.
    pub update_log: Vec<UpdateLogEntry>,
}

// ----------------------------------------------------------------------
// M3a.5 — Archiviazione giocatori con asterisco (fuori serie A)
// ----------------------------------------------------------------------

/// Archivia tutti i giocatori con `*` nel nome presenti nel `players` table.
///
/// La convenzione di fantacalcio.it è che i giocatori con asterisco nel nome
/// sono FUORI SERIE A (venduti all'estero, ritirati, in Serie B). NON vanno
/// mai nel `players` table attivo — vengono archiviati in `players_archive`
/// con `archived_reason = 'non_in_listone'`.
///
/// Comportamento:
///   1. SELECT id, db_id, name FROM players WHERE name LIKE '%*%' ORDER BY name
///   2. Per ognuno:
///      - Pre-check conflict resolution B.7: se l'utente ha editato
///        recentemente (updated_at > scraped_at), SKIP — non archiviare
///      - Pre-check: già in archive? SKIP — non duplicare
///      - Snapshot arricchito (player + auction_data + scouting_notes +
///        oracolo_projections + pressione_mercato) → JSON in last_known_data
///      - INSERT INTO players_archive con archived_reason='non_in_listone'
///      - DELETE FROM players (con cascade sulle tabelle collegate —
///        ma lo snapshot ha già preservato i dati)
///   3. Return count archived
///
/// Chiamato:
///   - Automaticamente in fondo a `import_listone` (pulizia post-import)
///   - Manualmente dal pulsante "Pulisci asterischi" nella ListoneInlineCard
///
/// NON distruttivo — i dati sono preservati in `last_known_data` e possono
/// essere recuperati via `restore_archived_player` se il giocatore torna
/// in Serie A.
pub fn archive_asterisk_players_inner(
    state: &DbState,
    active_id: &str,
    scraped_at: Option<&str>,
) -> AppResult<usize> {
    state.with_conn(active_id, |conn| {
        let mut archived: usize = 0;

        // SELECT tutti i player con `*` nel nome. LOWER/UPPER non serve —
        // LIKE '%*%' è case-insensitive di default in SQLite per ASCII.
        let mut stmt = conn.prepare(
            "SELECT id, name FROM players WHERE name LIKE '%*%' ORDER BY name",
        )?;
        let rows: Vec<(String, String)> = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .filter_map(Result::ok)
            .collect();
        drop(stmt); // rilascia statement prima di nuove query

        for (pid, pname) in &rows {
            // Conflict resolution B.7: se l'utente ha editato recentemente
            // questo player (updated_at > scraped_at), SKIP. Non bloccare
            // il cleanup globale per un solo player editato.
            if let Some(ref scraped) = scraped_at {
                if let Ok(true) = crate::commands::sync::player_has_recent_local_edit(
                    conn, pid, scraped,
                ) {
                    log::debug!(
                        "[M3a.5] skip asterisk {}: edit recente (B.7)",
                        pname
                    );
                    continue;
                }
            }

            // Pre-check: già in archive? SKIP — non duplicare.
            let already: bool = conn
                .query_row(
                    "SELECT 1 FROM players_archive WHERE id = ?1 LIMIT 1",
                    params![pid],
                    |_| Ok(true),
                )
                .unwrap_or(false);
            if already {
                log::debug!("[M3a.5] skip asterisk {}: già in archive", pname);
                continue;
            }

            // Snapshot arricchito (player + auction_data + scouting_notes +
            // oracolo_projections + pressione_mercato). Riutilizza l'helper
            // esistente in players.rs.
            let snapshot_value = _collect_player_snapshot(conn, pid);
            let snapshot_str = serde_json::to_string(&snapshot_value)
                .unwrap_or_else(|_| "{}".to_string());

            // Estrai campi minimi per i metadati dell'archivio.
            let player_obj = snapshot_value
                .get("player")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            let p_team = player_obj.get("team").and_then(|v| v.as_str());
            let p_pos_fanta = player_obj.get("pos_fanta").and_then(|v| v.as_str());
            let p_pos_real = player_obj.get("pos_real").and_then(|v| v.as_str());

            // Insert into archive + delete from players (atomic via tx).
            // M3a.5 — RIMUOVI l'asterisco dal nome quando archivi.
            // La convenzione di fantacalcio.it è che `*` = fuori serie A.
            // Quando archiviamo, puliamo il nome: "Rossi*" → "Rossi".
            let pname_clean = pname.replace('*', "").trim().to_string();
            let tx = conn.unchecked_transaction()?;
            let r: rusqlite::Result<()> = (|| {
                tx.execute(
                    r#"INSERT INTO players_archive
                       (id, db_id, name, team, pos_fanta, pos_real,
                        archived_at, archived_reason, last_known_data, source_db_id)
                       VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'), 'non_in_listone', ?7, ?8)"#,
                    params![
                        pid,
                        active_id,
                        pname_clean,
                        p_team,
                        p_pos_fanta,
                        p_pos_real,
                        snapshot_str,
                        active_id,
                    ],
                )?;
                tx.execute("DELETE FROM players WHERE id = ?1", params![pid])?;
                Ok(())
            })();
            match r {
                Ok(()) => {
                    tx.commit()?;
                    archived += 1;
                    log::info!("[M3a.5] archived asterisk player: {} ({})", pname, pid);
                }
                Err(e) => {
                    // Rollback e skip — non bloccare il loop per un errore singolo
                    let _ = tx.rollback();
                    log::warn!(
                        "[M3a.5] failed to archive asterisk {} ({}): {}",
                        pname, pid, e
                    );
                }
            }
        }

        Ok(archived)
    })
}

/// Comando Tauri: archivia tutti i giocatori con `*` nel nome.
///
/// Chiamato dal pulsante "Pulisci asterischi" nella ListoneInlineCard
/// del DatabaseManager. Ritorna il count dei player archiviati.
///
/// NOTA: non prende `scraped_at` come parametro (per uso manuale, non
/// contesto di listone update). Se l'utente ha editato recentemente
/// un player asterisk (B.7), viene skippato — il cleanup non blocca
/// le modifiche locali.
#[tauri::command]
pub fn archive_asterisk_players(state: State<'_, DbState>) -> AppResult<usize> {
    let active_id = state.active_db_id()?;
    archive_asterisk_players_inner(&*state, &active_id, None)
}
