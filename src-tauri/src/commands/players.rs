//! CRUD giocatore — comandi Tauri per la tabella `players`.
//!
//! Vincoli rispettati:
//! - `delete_player` NON usa ON DELETE CASCADE da solo: la cancellazione è
//!   sempre esplicita. Lo schema ha `ON DELETE CASCADE` su `scouting_notes` e
//!   `auction_data` (FK), quindi la cancellazione di un player cancella anche
//!   i suoi record 1:1. Questo è corretto e fa parte del comportamento atteso.
//! - `archive_player` sposta il giocatore in `players_archive` (NON lo cancella).
//!   M1 non espone archiviazione automatica (solo manuale), ma il comando
//!   esiste per completezza e verrà usato in M2/M3.
//! - Tutti i campi sono validati lato Rust prima di scrivere sul DB.
//!
//! Terminologia f₥ / M / MV / FVM (v2.2):
//! - `fmil_spesi` (INTEGER) — Fantamilioni spesi all'asta (simbolo UI: f₥)
//! - `med` (REAL 0-10) — Med, media voto pura senza bonus (simbolo UI: M)
//! - `medv` (REAL 0-10) — MedV, FantaMedia con bonus/malus (simbolo UI: MV)
//! - `fvm` (INTEGER) — FVM, FantaValoreMedio da listone (simbolo UI: FVM)

use crate::commands::{AppError, AppResult};
use crate::db::new_uuid;
use crate::DbState;
use rusqlite::{params, params_from_iter, types::Value as SqlValue};
use serde::{Deserialize, Serialize};
use tauri::State;

// ----------------------------------------------------------------------
// Tipi esposti al frontend
// ----------------------------------------------------------------------

/// Rappresentazione completa di un giocatore. Usata in lettura e scrittura.
/// I campi opzionali sono `Option<T>` perché lo schema lo permette.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Player {
    pub id: String,
    pub db_id: String,
    pub name: String,
    pub team: Option<String>,
    pub pos_fanta: Option<String>,
    pub pos_real: Option<String>,
    pub status: String,
    pub fascia: Option<String>,
    pub priority: i64,
    pub fmil_spesi: Option<i64>,
    pub med: Option<f64>,
    pub medv: Option<f64>,
    pub fvm: Option<i64>,
    pub updated_at: Option<String>,
    pub updated_by: Option<String>,
}

/// Payload per creare un nuovo giocatore. `id` è generato lato Rust (UUID v4);
/// `db_id` è sempre "default-personal" in M1 (single-DB).
#[derive(Debug, Deserialize)]
pub struct CreatePlayerInput {
    pub name: String,
    pub team: Option<String>,
    pub pos_fanta: Option<String>,
    pub pos_real: Option<String>,
    pub fascia: Option<String>,
    #[serde(default)]
    pub priority: Option<i64>,
    pub fmil_spesi: Option<i64>,
    pub med: Option<f64>,
    pub medv: Option<f64>,
    pub fvm: Option<i64>,
}

/// Payload per aggiornare un giocatore. Tutti i campi editabili sono
/// `Option<T>`: `None` significa "non modificare", `Some(None)` significa
/// "imposta a NULL", `Some(Some(v))` significa "imposta a v".
/// Per semplicità M1 usiamo un payload "full replace" (tutti i campi editabili
/// vengono sovrascritti con i valori passati).
#[derive(Debug, Deserialize)]
pub struct UpdatePlayerInput {
    pub id: String,
    pub name: String,
    pub team: Option<String>,
    pub pos_fanta: Option<String>,
    pub pos_real: Option<String>,
    pub fascia: Option<String>,
    pub priority: i64,
    pub fmil_spesi: Option<i64>,
    pub med: Option<f64>,
    pub medv: Option<f64>,
    pub fvm: Option<i64>,
}

/// Filtri per `list_players`. Tutti opzionali.
/// - `search`: case-insensitive LIKE su `name` (e `team` se presente)
/// - `pos_fanta`: 'P' | 'D' | 'C' | 'A' | null (tutti)
/// - `status': 'totali' | 'scoutato' | 'da_fare' | null (tutti)
/// - `fascia`: una delle 5 fasce, o null
/// - `limit` / `offset`: paginazione (default 500 / 0)
#[derive(Debug, Deserialize, Default)]
pub struct ListFilters {
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub pos_fanta: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub fascia: Option<String>,
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub offset: Option<i64>,
}

// ----------------------------------------------------------------------
// Validatori
// ----------------------------------------------------------------------

const POS_FANTA_VALUES: &[&str] = &["P", "D", "C", "A"];
const FASCIA_VALUES: &[&str] = &["Top", "Semitop", "Medio", "Regolarista", "Scommessa"];
const STATUS_VALUES: &[&str] = &["totali", "scoutato", "da_fare"];

fn validate_pos_fanta(v: &Option<String>) -> Result<(), AppError> {
    if let Some(s) = v.as_deref() {
        if !POS_FANTA_VALUES.contains(&s) {
            return Err(AppError::Validation(format!(
                "pos_fanta deve essere uno di {:?}, avuto {:?}",
                POS_FANTA_VALUES, s
            )));
        }
    }
    Ok(())
}

fn validate_fascia(v: &Option<String>) -> Result<(), AppError> {
    if let Some(s) = v.as_deref() {
        if !FASCIA_VALUES.contains(&s) {
            return Err(AppError::Validation(format!(
                "fascia deve essere uno di {:?}, avuto {:?}",
                FASCIA_VALUES, s
            )));
        }
    }
    Ok(())
}

fn validate_priority(p: i64) -> Result<(), AppError> {
    if !(0..=5).contains(&p) {
        return Err(AppError::Validation(format!(
            "priority deve essere 0-5, avuto {}",
            p
        )));
    }
    Ok(())
}

fn validate_med(v: &Option<f64>) -> Result<(), AppError> {
    if let Some(x) = v {
        if !(0.0..=10.0).contains(x) {
            return Err(AppError::Validation(format!(
                "med (M) deve essere 0-10, avuto {}",
                x
            )));
        }
    }
    Ok(())
}

fn validate_medv(v: &Option<f64>) -> Result<(), AppError> {
    if let Some(x) = v {
        if !(0.0..=10.0).contains(x) {
            return Err(AppError::Validation(format!(
                "medv (MV) deve essere 0-10, avuto {}",
                x
            )));
        }
    }
    Ok(())
}

fn validate_status(v: &Option<String>) -> Result<(), AppError> {
    if let Some(s) = v.as_deref() {
        if !STATUS_VALUES.contains(&s) {
            return Err(AppError::Validation(format!(
                "status deve essere uno di {:?}, avuto {:?}",
                STATUS_VALUES, s
            )));
        }
    }
    Ok(())
}

// ----------------------------------------------------------------------
// Comandi
// ----------------------------------------------------------------------

/// Elenca i giocatori con filtri opzionali. Ordinamento: priority DESC,
/// name ASC (case-insensitive). Questo dà priorità visiva ai giocatori
/// con priorità alta, allineamento con la UX scout.
#[tauri::command]
pub fn list_players(
    state: State<'_, DbState>,
    filters: Option<ListFilters>,
) -> AppResult<Vec<Player>> {
    let f = filters.unwrap_or_default();
    validate_pos_fanta(&f.pos_fanta)?;
    validate_fascia(&f.fascia)?;
    validate_status(&f.status)?;

    let limit = f.limit.unwrap_or(500);
    let offset = f.offset.unwrap_or(0);

    let mut sql = String::from(
        r#"SELECT id, db_id, name, team, pos_fanta, pos_real, status, fascia,
                  priority, fmil_spesi, med, medv, fvm, updated_at, updated_by
           FROM players WHERE 1=1"#,
    );
    let mut bind_values: Vec<SqlValue> = Vec::new();

    if let Some(s) = &f.search {
        let like = format!("%{}%", s.trim());
        sql.push_str(" AND (name LIKE ? COLLATE NOCASE OR COALESCE(team,'') LIKE ? COLLATE NOCASE)");
        bind_values.push(SqlValue::Text(like.clone()));
        bind_values.push(SqlValue::Text(like));
    }
    if let Some(p) = &f.pos_fanta {
        sql.push_str(" AND pos_fanta = ?");
        bind_values.push(SqlValue::Text(p.clone()));
    }
    if let Some(st) = &f.status {
        sql.push_str(" AND status = ?");
        bind_values.push(SqlValue::Text(st.clone()));
    }
    if let Some(fc) = &f.fascia {
        sql.push_str(" AND fascia = ?");
        bind_values.push(SqlValue::Text(fc.clone()));
    }

    sql.push_str(" ORDER BY priority DESC, name COLLATE NOCASE ASC LIMIT ? OFFSET ?");
    bind_values.push(SqlValue::Integer(limit));
    bind_values.push(SqlValue::Integer(offset));

    let conn = state.0.lock().map_err(|e| AppError::Generic(e.to_string()))?;
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(bind_values.iter()), |row| {
        Ok(Player {
            id: row.get(0)?,
            db_id: row.get(1)?,
            name: row.get(2)?,
            team: row.get(3)?,
            pos_fanta: row.get(4)?,
            pos_real: row.get(5)?,
            status: row.get(6)?,
            fascia: row.get(7)?,
            priority: row.get(8)?,
            fmil_spesi: row.get(9)?,
            med: row.get(10)?,
            medv: row.get(11)?,
            fvm: row.get(12)?,
            updated_at: row.get(13)?,
            updated_by: row.get(14)?,
        })
    })?;

    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Conta i giocatori, con gli stessi filtri di `list_players` (ignora
/// limit/offset). Utile per mostrare un contatore in UI.
#[tauri::command]
pub fn count_players(state: State<'_, DbState>, filters: Option<ListFilters>) -> AppResult<i64> {
    let f = filters.unwrap_or_default();
    let mut sql = String::from("SELECT COUNT(*) FROM players WHERE 1=1");
    let mut bind_values: Vec<SqlValue> = Vec::new();

    if let Some(s) = &f.search {
        let like = format!("%{}%", s.trim());
        sql.push_str(" AND (name LIKE ? COLLATE NOCASE OR COALESCE(team,'') LIKE ? COLLATE NOCASE)");
        bind_values.push(SqlValue::Text(like.clone()));
        bind_values.push(SqlValue::Text(like));
    }
    if let Some(p) = &f.pos_fanta {
        sql.push_str(" AND pos_fanta = ?");
        bind_values.push(SqlValue::Text(p.clone()));
    }
    if let Some(st) = &f.status {
        sql.push_str(" AND status = ?");
        bind_values.push(SqlValue::Text(st.clone()));
    }
    if let Some(fc) = &f.fascia {
        sql.push_str(" AND fascia = ?");
        bind_values.push(SqlValue::Text(fc.clone()));
    }

    let conn = state.0.lock().map_err(|e| AppError::Generic(e.to_string()))?;
    let count: i64 = conn.query_row(&sql, params_from_iter(bind_values.iter()), |row| row.get(0))?;
    Ok(count)
}

/// Crea un nuovo giocatore. Valida tutti i campi e genera UUID v4.
/// `db_id` è hard-coded a "default-personal" (M1 = single-DB).
#[tauri::command]
pub fn create_player(state: State<'_, DbState>, input: CreatePlayerInput) -> AppResult<Player> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::Validation("name è obbligatorio".to_string()));
    }
    validate_pos_fanta(&input.pos_fanta)?;
    validate_fascia(&input.fascia)?;
    validate_priority(input.priority.unwrap_or(0))?;
    validate_med(&input.med)?;
    validate_medv(&input.medv)?;

    let id = new_uuid();
    let db_id = "default-personal".to_string();
    let priority = input.priority.unwrap_or(0);
    let status = "totali".to_string();
    let updated_by = "me".to_string();

    let conn = state.0.lock().map_err(|e| AppError::Generic(e.to_string()))?;
    conn.execute(
        r#"INSERT INTO players
           (id, db_id, name, team, pos_fanta, pos_real, status, fascia, priority,
            fmil_spesi, med, medv, fvm, updated_by)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)"#,
        params![
            id,
            db_id,
            name,
            input.team,
            input.pos_fanta,
            input.pos_real,
            status,
            input.fascia,
            priority,
            input.fmil_spesi,
            input.med,
            input.medv,
            input.fvm,
            updated_by,
        ],
    )?;

    // Re-read the row so we return the canonical stored state
    let player = conn
        .query_row(
            r#"SELECT id, db_id, name, team, pos_fanta, pos_real, status, fascia,
                      priority, fmil_spesi, med, medv, fvm, updated_at, updated_by
               FROM players WHERE id = ?1"#,
            params![id],
            |row| {
                Ok(Player {
                    id: row.get(0)?,
                    db_id: row.get(1)?,
                    name: row.get(2)?,
                    team: row.get(3)?,
                    pos_fanta: row.get(4)?,
                    pos_real: row.get(5)?,
                    status: row.get(6)?,
                    fascia: row.get(7)?,
                    priority: row.get(8)?,
                    fmil_spesi: row.get(9)?,
                    med: row.get(10)?,
                    medv: row.get(11)?,
                    fvm: row.get(12)?,
                    updated_at: row.get(13)?,
                    updated_by: row.get(14)?,
                })
            },
        )
        .map_err(|e| AppError::Db(e))?;

    Ok(player)
}

/// Aggiorna un giocatore esistente. Full replace di tutti i campi editabili.
/// `id` è obbligatorio e identifica il record da aggiornare.
#[tauri::command]
pub fn update_player(state: State<'_, DbState>, input: UpdatePlayerInput) -> AppResult<Player> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::Validation("name è obbligatorio".to_string()));
    }
    validate_pos_fanta(&input.pos_fanta)?;
    validate_fascia(&input.fascia)?;
    validate_priority(input.priority)?;
    validate_med(&input.med)?;
    validate_medv(&input.medv)?;

    let conn = state.0.lock().map_err(|e| AppError::Generic(e.to_string()))?;

    let affected = conn.execute(
        r#"UPDATE players SET
             name = ?2,
             team = ?3,
             pos_fanta = ?4,
             pos_real = ?5,
             fascia = ?6,
             priority = ?7,
             fmil_spesi = ?8,
             med = ?9,
             medv = ?10,
             fvm = ?11,
             updated_by = 'me'
           WHERE id = ?1"#,
        params![
            input.id,
            name,
            input.team,
            input.pos_fanta,
            input.pos_real,
            input.fascia,
            input.priority,
            input.fmil_spesi,
            input.med,
            input.medv,
            input.fvm,
        ],
    )?;

    if affected == 0 {
        return Err(AppError::NotFound(format!(
            "giocatore id={} non trovato",
            input.id
        )));
    }

    // Re-read canonical
    let player = conn
        .query_row(
            r#"SELECT id, db_id, name, team, pos_fanta, pos_real, status, fascia,
                      priority, fmil_spesi, med, medv, fvm, updated_at, updated_by
               FROM players WHERE id = ?1"#,
            params![input.id],
            |row| {
                Ok(Player {
                    id: row.get(0)?,
                    db_id: row.get(1)?,
                    name: row.get(2)?,
                    team: row.get(3)?,
                    pos_fanta: row.get(4)?,
                    pos_real: row.get(5)?,
                    status: row.get(6)?,
                    fascia: row.get(7)?,
                    priority: row.get(8)?,
                    fmil_spesi: row.get(9)?,
                    med: row.get(10)?,
                    medv: row.get(11)?,
                    fvm: row.get(12)?,
                    updated_at: row.get(13)?,
                    updated_by: row.get(14)?,
                })
            },
        )
        .map_err(|e| AppError::Db(e))?;

    Ok(player)
}

/// Elimina un giocatore. Esplicita: il frontend DEVE chiedere conferma
/// all'utente prima di chiamare questo comando (vincolo HARD dello specifica).
///
/// Lo schema ha `ON DELETE CASCADE` su `scouting_notes` e `auction_data`,
/// quindi la cancellazione del player rimuove anche i suoi record 1:1.
/// Questo è il comportamento corretto (no orfani).
#[tauri::command]
pub fn delete_player(state: State<'_, DbState>, id: String) -> AppResult<bool> {
    let conn = state.0.lock().map_err(|e| AppError::Generic(e.to_string()))?;
    let affected = conn.execute("DELETE FROM players WHERE id = ?1", params![id])?;
    if affected == 0 {
        return Err(AppError::NotFound(format!(
            "giocatore id={} non trovato",
            id
        )));
    }
    Ok(true)
}

/// Archivia un giocatore (lo sposta in `players_archive`). NON distruttivo:
/// il record viene preservato con un snapshot JSON dei dati correnti.
/// In M1 il comando esiste per completezza; l'archiviazione automatica
/// arriverà in M3 (auto-fetch GH Actions).
#[tauri::command]
pub fn archive_player(
    state: State<'_, DbState>,
    id: String,
    reason: Option<String>,
) -> AppResult<bool> {
    let reason = reason.unwrap_or_else(|| "non_in_listone".to_string());
    let valid_reasons = [
        "trasferito_estero",
        "ritirato",
        "serie_b",
        "non_in_listone",
        "migrate_v1",
    ];
    if !valid_reasons.contains(&reason.as_str()) {
        return Err(AppError::Validation(format!(
            "archived_reason non valido: {}",
            reason
        )));
    }

    let conn = state.0.lock().map_err(|e| AppError::Generic(e.to_string()))?;

    // Read current player data
    let player = conn
        .query_row(
            r#"SELECT id, db_id, name, team, pos_fanta, pos_real, status, fascia,
                      priority, fmil_spesi, med, medv, fvm, updated_at, updated_by
               FROM players WHERE id = ?1"#,
            params![id],
            |row| {
                Ok(Player {
                    id: row.get(0)?,
                    db_id: row.get(1)?,
                    name: row.get(2)?,
                    team: row.get(3)?,
                    pos_fanta: row.get(4)?,
                    pos_real: row.get(5)?,
                    status: row.get(6)?,
                    fascia: row.get(7)?,
                    priority: row.get(8)?,
                    fmil_spesi: row.get(9)?,
                    med: row.get(10)?,
                    medv: row.get(11)?,
                    fvm: row.get(12)?,
                    updated_at: row.get(13)?,
                    updated_by: row.get(14)?,
                })
            },
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
                AppError::NotFound(format!("giocatore id={} non trovato", id))
            }
            other => AppError::Db(other),
        })?;

    let snapshot = serde_json::to_string(&player).unwrap_or_else(|_| "{}".to_string());

    // Insert into archive, then delete from players (atomic via tx)
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        r#"INSERT INTO players_archive
           (id, db_id, name, team, pos_fanta, pos_real,
            archived_at, archived_reason, last_known_data, source_db_id)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'), ?7, ?8, ?9)"#,
        params![
            player.id,
            player.db_id,
            player.name,
            player.team,
            player.pos_fanta,
            player.pos_real,
            reason,
            snapshot,
            player.db_id,
        ],
    )?;
    tx.execute("DELETE FROM players WHERE id = ?1", params![id])?;
    tx.commit()?;

    Ok(true)
}

/// Elenca i giocatori archiviati (non più in Serie A).
#[tauri::command]
pub fn list_archive(
    state: State<'_, DbState>,
    search: Option<String>,
    limit: Option<i64>,
) -> AppResult<Vec<serde_json::Value>> {
    let limit = limit.unwrap_or(500);
    let mut sql = String::from(
        r#"SELECT id, db_id, name, team, pos_fanta, pos_real,
                  archived_at, archived_reason, last_known_data
           FROM players_archive WHERE 1=1"#,
    );
    let mut bind_values: Vec<SqlValue> = Vec::new();

    if let Some(s) = &search {
        let like = format!("%{}%", s.trim());
        sql.push_str(" AND name LIKE ? COLLATE NOCASE");
        bind_values.push(SqlValue::Text(like));
    }
    sql.push_str(" ORDER BY archived_at DESC LIMIT ?");
    bind_values.push(SqlValue::Integer(limit));

    let conn = state.0.lock().map_err(|e| AppError::Generic(e.to_string()))?;
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(bind_values.iter()), |row| {
        let last_known: Option<String> = row.get(8)?;
        let last_known_json: serde_json::Value = last_known
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(serde_json::Value::Null);
        Ok(serde_json::json!({
            "id": row.get::<_, String>(0)?,
            "db_id": row.get::<_, String>(1)?,
            "name": row.get::<_, String>(2)?,
            "team": row.get::<_, Option<String>>(3)?,
            "pos_fanta": row.get::<_, Option<String>>(4)?,
            "pos_real": row.get::<_, Option<String>>(5)?,
            "archived_at": row.get::<_, String>(6)?,
            "archived_reason": row.get::<_, String>(7)?,
            "last_known_data": last_known_json,
        }))
    })?;

    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}
