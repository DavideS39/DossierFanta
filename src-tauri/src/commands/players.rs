//! CRUD giocatore — comandi Tauri per la tabella `players`.
//!
//! M2: refactor multi-DB — tutti i comandi accettano un parametro `db_id`
//! esplicito (Option<String>). Se None, usano l'`active_db_id` dal DbState.
//! Le query filtrano sempre per `db_id`.
//!
//! Vincoli rispettati:
//! - `delete_player` NON usa ON DELETE CASCADE da solo: la cancellazione è
//!   sempre esplicita. Lo schema ha `ON DELETE CASCADE` su `scouting_notes` e
//!   `auction_data` (FK), quindi la cancellazione di un player cancella anche
//!   i suoi record 1:1. Questo è corretto e fa parte del comportamento atteso.
//! - `archive_player` sposta il giocatore in `players_archive` (NON lo cancella).
//!   In M2 c'è anche l'archiviazione automatica via `import_listone` (vedi
//!   commands/listone.rs). Il comando manuale rimane per uso futuro.
//! - Tutti i campi sono validati lato Rust prima di scrivere sul DB.
//! - I comandi write fanno `ensure_writable_db`: rifiutano scritture su DB
//!   di tipo `listone` (read-only per vincolo M2).
//!
//! Terminologia f₥ / M / MV / FVM (v2.2):
//! - `fmil_spesi` (INTEGER) — Fantamilioni spesi all'asta (simbolo UI: f₥)
//! - `med` (REAL 0-10) — Med, media voto pura senza bonus (simbolo UI: M)
//! - `medv` (REAL 0-10) — MedV, FantaMedia con bonus/malus (simbolo UI: MV)
//! - `fvm` (INTEGER) — FVM, FantaValoreMedio da listone (simbolo UI: FVM)

use crate::commands::database::ensure_writable_db;
use crate::commands::{AppError, AppResult};
use crate::db::new_uuid;
use crate::DbState;
use rusqlite::{params, params_from_iter, types::Value as SqlValue};
use serde::{Deserialize, Serialize};
use tauri::State;

// ----------------------------------------------------------------------
// M2.1 — Snapshot arricchito (FIX A2, B5) + restore con ricreazione collegati (FIX A3, B12)
// ----------------------------------------------------------------------
//
// Lo snapshot JSON di `last_known_data` in players_archive ora include non
// solo la riga di `players` ma anche le righe delle 4 tabelle collegate:
// scouting_notes (multi-row), auction_data (1:1), oracolo_projections (1:1),
// pressione_mercato (1:1). Tutte hanno FK ON DELETE CASCADE verso players,
// quindi il DELETE FROM players le cancella: devono essere lette PRIMA e
// serializzate nello snapshot. Al restore, le righe vengono ricreate PRIMA
// di spostare il player da archive a players (ordine FK corretto).

/// Raccoglie lo snapshot arricchito di un giocatore: riga di players + tutte
/// le righe delle tabelle collegate (scouting_notes, auction_data,
/// oracolo_projections, pressione_mercato). Ritorna un `serde_json::Value`
/// pronto da serializzare in `last_known_data`.
///
/// Struct JSON:
/// ```json
/// {
///   "player": {...},
///   "scouting_notes": [...],
///   "auction_data": {...} | null,
///   "oracolo_projections": {...} | null,
///   "pressione_mercato": {...} | null
/// }
/// ```
fn collect_player_snapshot(conn: &rusqlite::Connection, player_id: &str) -> serde_json::Value {
    // 1. Riga di players (lo snapshot "core" come in M2 base)
    let player_row = conn
        .query_row(
            r#"SELECT id, db_id, name, team, pos_fanta, pos_real, status, fascia,
                      priority, fmil_spesi, med, medv, fvm, updated_at, updated_by
               FROM players WHERE id = ?1"#,
            params![player_id],
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
        .ok();

    // 2. scouting_notes (multi-row)
    let scouting_notes: Vec<serde_json::Value> = {
        let mut stmt = match conn.prepare(
            r#"SELECT id, kind, label, content, source, created_at
               FROM scouting_notes WHERE player_id = ?1
               ORDER BY id ASC"#,
        ) {
            Ok(s) => s,
            Err(_) => return serde_json::Value::Null,
        };
        let rows = stmt
            .query_map(params![player_id], |row| {
                Ok(serde_json::json!({
                    "id": row.get::<_, i64>(0)?,
                    "kind": row.get::<_, String>(1)?,
                    "label": row.get::<_, Option<String>>(2)?,
                    "content": row.get::<_, Option<String>>(3)?,
                    "source": row.get::<_, Option<String>>(4)?,
                    "created_at": row.get::<_, Option<String>>(5)?,
                }))
            });
        match rows {
            Ok(rows) => rows.filter_map(Result::ok).collect(),
            Err(_) => Vec::new(),
        }
    };

    // 3. auction_data (1:1)
    let auction_data: Option<serde_json::Value> = conn
        .query_row(
            r#"SELECT player_id, titolarita, infortuni, quick_note,
                      fmil_max, assigned_to, fmil_paid, assigned_at
               FROM auction_data WHERE player_id = ?1"#,
            params![player_id],
            |row| {
                Ok(serde_json::json!({
                    "player_id": row.get::<_, String>(0)?,
                    "titolarita": row.get::<_, Option<i64>>(1)?,
                    "infortuni": row.get::<_, Option<String>>(2)?,
                    "quick_note": row.get::<_, Option<String>>(3)?,
                    "fmil_max": row.get::<_, Option<i64>>(4)?,
                    "assigned_to": row.get::<_, Option<String>>(5)?,
                    "fmil_paid": row.get::<_, Option<i64>>(6)?,
                    "assigned_at": row.get::<_, Option<String>>(7)?,
                }))
            },
        )
        .ok();

    // 4. oracolo_projections (1:1)
    let oracolo_projections: Option<serde_json::Value> = conn
        .query_row(
            r#"SELECT player_id, fmil_atteso, confidence, components_json,
                      human_override, verdict, computed_at
               FROM oracolo_projections WHERE player_id = ?1"#,
            params![player_id],
            |row| {
                let components: Option<String> = row.get(3)?;
                let components_json: serde_json::Value = components
                    .as_deref()
                    .and_then(|s| serde_json::from_str(s).ok())
                    .unwrap_or(serde_json::Value::Null);
                Ok(serde_json::json!({
                    "player_id": row.get::<_, String>(0)?,
                    "fmil_atteso": row.get::<_, Option<f64>>(1)?,
                    "confidence": row.get::<_, Option<f64>>(2)?,
                    "components_json": components_json,
                    "human_override": row.get::<_, Option<f64>>(4)?,
                    "verdict": row.get::<_, Option<String>>(5)?,
                    "computed_at": row.get::<_, Option<String>>(6)?,
                }))
            },
        )
        .ok();

    // 5. pressione_mercato (1:1)
    let pressione_mercato: Option<serde_json::Value> = conn
        .query_row(
            r#"SELECT player_id, pm_esterna, pm_locale, pm_source, pm_updated
               FROM pressione_mercato WHERE player_id = ?1"#,
            params![player_id],
            |row| {
                Ok(serde_json::json!({
                    "player_id": row.get::<_, String>(0)?,
                    "pm_esterna": row.get::<_, Option<i64>>(1)?,
                    "pm_locale": row.get::<_, Option<f64>>(2)?,
                    "pm_source": row.get::<_, Option<String>>(3)?,
                    "pm_updated": row.get::<_, Option<String>>(4)?,
                }))
            },
        )
        .ok();

    serde_json::json!({
        "player": player_row,
        "scouting_notes": scouting_notes,
        "auction_data": auction_data,
        "oracolo_projections": oracolo_projections,
        "pressione_mercato": pressione_mercato,
    })
}

/// Helper: ricrea le righe delle tabelle collegate a un player dallo snapshot
/// arricchito (inversa di `collect_player_snapshot`). Da chiamare DOPO che
/// il player è stato re-inserito in `players` (le FK puntano a players.id).
fn recreate_connected_tables(
    conn: &rusqlite::Connection,
    snapshot: &serde_json::Value,
) -> Result<(), rusqlite::Error> {
    // scouting_notes: ricrea ogni riga come INSERT esplicita con i campi dallo snapshot.
    if let Some(notes) = snapshot.get("scouting_notes").and_then(|v| v.as_array()) {
        for n in notes {
            // Skip se mancano kind o content vuoto (la FK è player_id, non può essere NULL)
            let kind = n.get("kind").and_then(|v| v.as_str()).unwrap_or("note");
            let content: Option<&str> = n.get("content").and_then(|v| v.as_str());
            // Per rispettare il CHECK kind IN ('data','link','note'), se kind è altro lo forzo a 'note'
            let kind = match kind {
                "data" | "link" | "note" => kind,
                _ => "note",
            };
            conn.execute(
                r#"INSERT INTO scouting_notes
                   (player_id, kind, label, content, source, created_at)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6)"#,
                params![
                    snapshot
                        .get("player")
                        .and_then(|p| p.get("id"))
                        .and_then(|v| v.as_str())
                        .unwrap_or(""),
                    kind,
                    n.get("label").and_then(|v| v.as_str()),
                    content,
                    n.get("source").and_then(|v| v.as_str()),
                    n.get("created_at").and_then(|v| v.as_str()),
                ],
            )?;
        }
    }

    // auction_data (1:1)
    if let Some(a) = snapshot.get("auction_data") {
        if !a.is_null() {
            conn.execute(
                r#"INSERT INTO auction_data
                   (player_id, titolarita, infortuni, quick_note,
                    fmil_max, assigned_to, fmil_paid, assigned_at)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"#,
                params![
                    a.get("player_id").and_then(|v| v.as_str()),
                    a.get("titolarita").and_then(|v| v.as_i64()),
                    a.get("infortuni").and_then(|v| v.as_str()),
                    a.get("quick_note").and_then(|v| v.as_str()),
                    a.get("fmil_max").and_then(|v| v.as_i64()),
                    a.get("assigned_to").and_then(|v| v.as_str()),
                    a.get("fmil_paid").and_then(|v| v.as_i64()),
                    a.get("assigned_at").and_then(|v| v.as_str()),
                ],
            )?;
        }
    }

    // oracolo_projections (1:1)
    if let Some(o) = snapshot.get("oracolo_projections") {
        if !o.is_null() {
            let components_json_str: Option<String> = o
                .get("components_json")
                .and_then(|v| {
                    if v.is_null() {
                        Some(None)
                    } else {
                        serde_json::to_string(v).ok().map(Some).or(Some(None))
                    }
                })
                .unwrap_or(None);
            conn.execute(
                r#"INSERT INTO oracolo_projections
                   (player_id, fmil_atteso, confidence, components_json,
                    human_override, verdict, computed_at)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"#,
                params![
                    o.get("player_id").and_then(|v| v.as_str()),
                    o.get("fmil_atteso").and_then(|v| v.as_f64()),
                    o.get("confidence").and_then(|v| v.as_f64()),
                    components_json_str,
                    o.get("human_override").and_then(|v| v.as_f64()),
                    o.get("verdict").and_then(|v| v.as_str()),
                    o.get("computed_at").and_then(|v| v.as_str()),
                ],
            )?;
        }
    }

    // pressione_mercato (1:1)
    if let Some(pm) = snapshot.get("pressione_mercato") {
        if !pm.is_null() {
            conn.execute(
                r#"INSERT INTO pressione_mercato
                   (player_id, pm_esterna, pm_locale, pm_source, pm_updated)
                   VALUES (?1, ?2, ?3, ?4, ?5)"#,
                params![
                    pm.get("player_id").and_then(|v| v.as_str()),
                    pm.get("pm_esterna").and_then(|v| v.as_i64()),
                    pm.get("pm_locale").and_then(|v| v.as_f64()),
                    pm.get("pm_source").and_then(|v| v.as_str()),
                    pm.get("pm_updated").and_then(|v| v.as_str()),
                ],
            )?;
        }
    }

    Ok(())
}

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
/// `db_id` è esplicito (M2): se `None`, usa l'`active_db_id` del DbState.
#[derive(Debug, Deserialize)]
pub struct CreatePlayerInput {
    pub db_id: Option<String>, // M2: esplicito, None → active_db_id
    pub name: String,
    pub team: Option<String>,
    pub pos_fanta: Option<String>,
    pub pos_real: Option<String>,
    #[serde(default)]
    pub status: Option<String>, // M2: permette di creare con status='da_fare' dal listone
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
/// Per semplicità M1/M2 usiamo un payload "full replace" (tutti i campi editabili
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
/// - `db_id`: filtro per DB logico (M2). None → active_db_id, "all" → tutti i DB.
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
    pub db_id: Option<String>, // M2: None → active, "all" → tutti
    #[serde(default)]
    pub include_archive: Option<bool>, // M2: se true, include archived
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

/// Risolve il `db_id` effettivo: se il filtro esplicito è `None`, usa l'`active_db_id`.
/// Se il filtro è `"all"`, ritorna `None` (significa: nessun filtro db_id).
fn resolve_db_filter(state: &State<'_, DbState>, db_id: &Option<String>) -> Result<Option<String>, AppError> {
    match db_id.as_deref() {
        None => state.active_db_id().map(Some),
        Some("all") => Ok(None),
        Some(other) => Ok(Some(other.to_string())),
    }
}

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

    let active_id = state.active_db_id()?;
    let db_filter = match f.db_id.as_deref() {
        None => Some(active_id.clone()),
        Some("all") => None,
        Some(other) => Some(other.to_string()),
    };

    let mut sql = String::from(
        r#"SELECT id, db_id, name, team, pos_fanta, pos_real, status, fascia,
                  priority, fmil_spesi, med, medv, fvm, updated_at, updated_by
           FROM players WHERE 1=1"#,
    );
    let mut bind_values: Vec<SqlValue> = Vec::new();

    if let Some(d) = &db_filter {
        sql.push_str(" AND db_id = ?");
        bind_values.push(SqlValue::Text(d.clone()));
    }
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

    // Usa la connessione del default-personal (o del db_filter se presente).
    // Tutte le connessioni puntano allo stesso file, quindi una qualunque va bene.
    let conn_key = db_filter.clone().unwrap_or_else(|| "default-personal".to_string());
    state.with_conn(&conn_key, |conn| {
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
    })
}

/// Conta i giocatori, con gli stessi filtri di `list_players` (ignora
/// limit/offset). Utile per mostrare un contatore in UI.
#[tauri::command]
pub fn count_players(state: State<'_, DbState>, filters: Option<ListFilters>) -> AppResult<i64> {
    let f = filters.unwrap_or_default();
    let active_id = state.active_db_id()?;
    let db_filter = match f.db_id.as_deref() {
        None => Some(active_id),
        Some("all") => None,
        Some(other) => Some(other.to_string()),
    };

    let mut sql = String::from("SELECT COUNT(*) FROM players WHERE 1=1");
    let mut bind_values: Vec<SqlValue> = Vec::new();

    if let Some(d) = &db_filter {
        sql.push_str(" AND db_id = ?");
        bind_values.push(SqlValue::Text(d.clone()));
    }
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

    let conn_key = db_filter.unwrap_or_else(|| "default-personal".to_string());
    state.with_conn(&conn_key, |conn| {
        let count: i64 =
            conn.query_row(&sql, params_from_iter(bind_values.iter()), |row| row.get(0))?;
        Ok(count)
    })
}

/// Crea un nuovo giocatore. Valida tutti i campi e genera UUID v4.
/// `db_id` è esplicito (M2): se `None`, usa l'`active_db_id`.
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
    validate_status(&input.status)?;

    // Risolvi db_id (None → active_db_id).
    let db_id = match input.db_id.as_deref() {
        Some(d) if !d.is_empty() && d != "all" => d.to_string(),
        _ => state.active_db_id()?,
    };

    let id = new_uuid();
    let priority = input.priority.unwrap_or(0);
    let status = input.status.unwrap_or_else(|| "totali".to_string());
    let updated_by = "me".to_string();

    state.with_conn(&db_id, |conn| {
        // Check: DB di tipo listone è read-only.
        ensure_writable_db(conn, &db_id)?;

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
    })
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

    // Trova il db_id del giocatore (per aprire la connessione giusta e fare
    // il check ensure_writable_db).
    let active_id = state.active_db_id()?;
    let db_id = state.with_conn(&active_id, |conn| {
        let d: String = conn
            .query_row(
                "SELECT db_id FROM players WHERE id = ?1",
                params![&input.id],
                |r| r.get(0),
            )
            .ok()
            .ok_or_else(|| {
                AppError::NotFound(format!("giocatore id={} non trovato", input.id))
            })?;
        Ok(d)
    })?;

    state.with_conn(&db_id, |conn| {
        ensure_writable_db(conn, &db_id)?;

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
    })
}

/// Elimina un giocatore. Esplicita: il frontend DEVE chiedere conferma
/// all'utente prima di chiamare questo comando (vincolo HARD dello specifica).
///
/// Lo schema ha `ON DELETE CASCADE` su `scouting_notes` e `auction_data`,
/// quindi la cancellazione del player rimuove anche i suoi record 1:1.
/// Questo è il comportamento corretto (no orfani).
#[tauri::command]
pub fn delete_player(state: State<'_, DbState>, id: String) -> AppResult<bool> {
    // Trova db_id del player (per check writability + aprire conn giusta)
    let active_id = state.active_db_id()?;
    let db_id = state.with_conn(&active_id, |conn| {
        let d: String = conn
            .query_row(
                "SELECT db_id FROM players WHERE id = ?1",
                params![&id],
                |r| r.get(0),
            )
            .ok()
            .ok_or_else(|| AppError::NotFound(format!("giocatore id={} non trovato", id)))?;
        Ok(d)
    })?;

    state.with_conn(&db_id, |conn| {
        ensure_writable_db(conn, &db_id)?;
        let affected = conn.execute("DELETE FROM players WHERE id = ?1", params![id])?;
        if affected == 0 {
            return Err(AppError::NotFound(format!(
                "giocatore id={} non trovato",
                id
            )));
        }
        Ok(true)
    })
}

/// Archivia un giocatore (lo sposta in `players_archive`). NON distruttivo:
/// il record viene preservato con un snapshot JSON dei dati correnti.
/// In M2 c'è anche l'archiviazione automatica via `import_listone`, ma il
/// comando manuale rimane per uso futuro (es. ritirato, trasferito estero).
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

    let active_id = state.active_db_id()?;
    let db_id = state.with_conn(&active_id, |conn| {
        let d: String = conn
            .query_row(
                "SELECT db_id FROM players WHERE id = ?1",
                params![&id],
                |r| r.get(0),
            )
            .ok()
            .ok_or_else(|| AppError::NotFound(format!("giocatore id={} non trovato", id)))?;
        Ok(d)
    })?;

    state.with_conn(&db_id, |conn| {
        // Read current player data (FIX A2: ora raccoglie anche le tabelle collegate)
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

        // FIX A2 (B5) — Snapshot arricchito: player + scouting_notes + auction_data
        // + oracolo_projections + pressione_mercato. Prima di fare DELETE FROM players
        // (che triggerà ON DELETE CASCADE sulle 4 tabelle collegate), raccogliamo
        // tutti i dati in un unico JSON da mettere in `last_known_data`.
        let snapshot_value = collect_player_snapshot(conn, &id);
        let snapshot = serde_json::to_string(&snapshot_value)
            .unwrap_or_else(|_| "{}".to_string());

        // Pre-check: il giocatore è già in archivio? Se sì, NON duplicare.
        let already_archived: bool = conn
            .query_row(
                "SELECT 1 FROM players_archive WHERE id = ?1 LIMIT 1",
                params![&id],
                |_| Ok(true),
            )
            .unwrap_or(false);
        if already_archived {
            return Err(AppError::Validation(format!(
                "giocatore id={} è già archiviato (non si duplica)",
                id
            )));
        }

        // Insert into archive, then delete from players (atomic via tx).
        // Il DELETE FROM players triggerà ON DELETE CASCADE su scouting_notes,
        // auction_data, oracolo_projections, pressione_mercato (lo snapshot
        // arricchito li ha già preservati in `last_known_data`).
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
    })
}

/// M2.1 — IMPROVEMENT B3: set_player_status.
///
/// Imposta lo status di un giocatore (scoutato / da_fare / totali) con
/// validazione lato Rust (rispetta il CHECK constraint dello schema).
/// Usato dal toggle manuale (click sul timbro) e può essere chiamato anche
/// dall'auto-toggle lato Rust (vedi save_scouting_note).
///
/// Validazione: `new_status` DEVE essere uno tra 'totali', 'scoutato', 'da_fare'.
#[tauri::command]
pub fn set_player_status(
    state: State<'_, DbState>,
    player_id: String,
    new_status: String,
) -> AppResult<Player> {
    // Validazione inline (con i stessi valori di STATUS_VALUES)
    let valid = ["totali", "scoutato", "da_fare"];
    if !valid.contains(&new_status.as_str()) {
        return Err(AppError::Validation(format!(
            "new_status deve essere uno di {:?}, avuto {:?}",
            valid, new_status
        )));
    }

    // Trova il db_id del giocatore
    let active_id = state.active_db_id()?;
    let db_id = state.with_conn(&active_id, |conn| {
        let d: String = conn
            .query_row(
                "SELECT db_id FROM players WHERE id = ?1",
                params![&player_id],
                |r| r.get(0),
            )
            .ok()
            .ok_or_else(|| {
                AppError::NotFound(format!("giocatore id={} non trovato", player_id))
            })?;
        Ok(d)
    })?;

    state.with_conn(&db_id, |conn| {
        ensure_writable_db(conn, &db_id)?;
        let affected = conn.execute(
            "UPDATE players SET status = ?2, updated_by = 'me' WHERE id = ?1",
            params![&player_id, &new_status],
        )?;
        if affected == 0 {
            return Err(AppError::NotFound(format!(
                "giocatore id={} non trovato",
                player_id
            )));
        }

        // Re-read canonical
        let player = conn
            .query_row(
                r#"SELECT id, db_id, name, team, pos_fanta, pos_real, status, fascia,
                          priority, fmil_spesi, med, medv, fvm, updated_at, updated_by
                   FROM players WHERE id = ?1"#,
                params![&player_id],
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
    })
}

/// M2.1 — IMPROVEMENT B3: save_scouting_note con auto-toggle status.
///
/// Crea una riga in `scouting_notes` per il giocatore. Se il giocatore ha
/// `status='da_fare'` e la nota ha `kind='note'` con `content` non vuoto,
/// OPPURE `kind='data'` con `content` non vuoto, lo status viene
/// automaticamente promosso a 'scoutato' (auto-toggle).
///
/// Non torna mai indietro automaticamente (se l'utente vuole rimettere
/// 'da_fare', usa il toggle manuale sul timbro).
#[tauri::command]
pub fn save_scouting_note(
    state: State<'_, DbState>,
    player_id: String,
    kind: String,
    label: Option<String>,
    content: Option<String>,
    source: Option<String>,
) -> AppResult<bool> {
    // Validazione kind (rispetta il CHECK constraint)
    let valid_kinds = ["data", "link", "note"];
    if !valid_kinds.contains(&kind.as_str()) {
        return Err(AppError::Validation(format!(
            "kind deve essere uno di {:?}, avuto {:?}",
            valid_kinds, kind
        )));
    }

    let active_id = state.active_db_id()?;
    // Trova il db_id del giocatore
    let db_id = state.with_conn(&active_id, |conn| {
        let d: String = conn
            .query_row(
                "SELECT db_id FROM players WHERE id = ?1",
                params![&player_id],
                |r| r.get(0),
            )
            .ok()
            .ok_or_else(|| {
                AppError::NotFound(format!("giocatore id={} non trovato", player_id))
            })?;
        Ok(d)
    })?;

    state.with_conn(&db_id, |conn| {
        ensure_writable_db(conn, &db_id)?;

        let tx = conn.unchecked_transaction()?;

        // Insert scouting note
        tx.execute(
            r#"INSERT INTO scouting_notes
               (player_id, kind, label, content, source)
               VALUES (?1, ?2, ?3, ?4, ?5)"#,
            params![
                &player_id,
                &kind,
                &label,
                &content,
                &source,
            ],
        )?;

        // Auto-toggle status: se kind IN ('note','data') e content è non vuoto
        // e il giocatore è in 'da_fare' → promuovi a 'scoutato'
        let should_promote = matches!(kind.as_str(), "note" | "data")
            && content.as_deref().map(|c| !c.trim().is_empty()).unwrap_or(false);

        if should_promote {
            let current_status: Option<String> = tx
                .query_row(
                    "SELECT status FROM players WHERE id = ?1",
                    params![&player_id],
                    |r| r.get(0),
                )
                .ok();
            if current_status.as_deref() == Some("da_fare") {
                tx.execute(
                    "UPDATE players SET status = 'scoutato', updated_by = 'me' WHERE id = ?1",
                    params![&player_id],
                )?;
            }
        }

        tx.commit()?;
        Ok(true)
    })
}

/// M2.1 — Helper esposto per listone.rs: collect_player_snapshot (snapshot arricchito).
/// Permette a `import_listone` di usare lo stesso snapshot arricchito di `archive_player`.
#[allow(dead_code)]
pub(crate) fn _collect_player_snapshot(
    conn: &rusqlite::Connection,
    player_id: &str,
) -> serde_json::Value {
    collect_player_snapshot(conn, player_id)
}

/// M2.1 — B5: legge un singolo giocatore per id (usato dalla finestra OS nativa
/// che non ha il Zustand store con la lista players caricata).
#[tauri::command]
pub fn get_player(state: State<'_, DbState>, player_id: String) -> AppResult<Player> {
    let active_id = state.active_db_id()?;
    state.with_conn(&active_id, |conn| {
        let player = conn
            .query_row(
                r#"SELECT id, db_id, name, team, pos_fanta, pos_real, status, fascia,
                          priority, fmil_spesi, med, medv, fvm, updated_at, updated_by
                   FROM players WHERE id = ?1"#,
                params![&player_id],
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
                    AppError::NotFound(format!("giocatore id={} non trovato", player_id))
                }
                other => AppError::Db(other),
            })?;
        Ok(player)
    })
}

/// M2.1 — Helper esposto per listone.rs: recreate_connected_tables.
/// Permette a `restore_archived_player` di listone.rs di ricreare le 4 tabelle
/// collegate dallo snapshot arricchito (inversa di collect_player_snapshot).
#[allow(dead_code)]
pub(crate) fn _recreate_connected_tables(
    conn: &rusqlite::Connection,
    snapshot: &serde_json::Value,
) -> Result<(), rusqlite::Error> {
    recreate_connected_tables(conn, snapshot)
}

/// Elenca i giocatori archiviati (non più in Serie A).
/// M2: aggiunto filtro `role` (pos_fanta) oltre a `search`.
#[tauri::command]
pub fn list_archive(
    state: State<'_, DbState>,
    search: Option<String>,
    role: Option<String>,
    limit: Option<i64>,
) -> AppResult<Vec<serde_json::Value>> {
    let limit = limit.unwrap_or(500);
    let active_id = state.active_db_id()?;

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
    if let Some(r) = &role {
        sql.push_str(" AND pos_fanta = ?");
        bind_values.push(SqlValue::Text(r.clone()));
    }
    sql.push_str(" ORDER BY archived_at DESC LIMIT ?");
    bind_values.push(SqlValue::Integer(limit));

    state.with_conn(&active_id, |conn| {
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
    })
}

// Helper usato da listone.rs (M2)
#[allow(dead_code)]
pub(crate) fn _resolve_db_filter(state: &State<'_, DbState>, db_id: &Option<String>) -> Result<Option<String>, AppError> {
    resolve_db_filter(state, db_id)
}

// ----------------------------------------------------------------------
// M2.1.1 — Cap.9: CRUD per auction_data + scouting_notes
// ----------------------------------------------------------------------
// Permette alla scheda giocatore (PlayerForm embedded in Window WM o
// finestra OS nativa) di leggere e scrivere i dati 1:1 di auction_data
// (titolarità, infortuni, budget max f₥, nota rapida, assegnazione) e
// di elencare le note scouting del giocatore.
// ----------------------------------------------------------------------

/// Rappresentazione di una riga di `auction_data` (1:1 con player).
/// Tutti i campi tranne `player_id` sono opzionali (lo schema lo permette).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuctionData {
    pub player_id: String,
    pub titolarita: Option<i64>,      // 1-10
    pub infortuni: Option<String>,    // 'nessuno' | 'lieve' | 'grave'
    pub quick_note: Option<String>,
    pub fmil_max: Option<i64>,        // f₥ budget max all'asta (NUOVO: quello che SON DISPOSTO a spendere)
    pub assigned_to: Option<String>,  // team lega, NULL se non assegnato
    pub fmil_paid: Option<i64>,       // f₥ prezzo di assegnazione effettivo
    pub assigned_at: Option<String>,
}

/// Rappresentazione di una riga di `scouting_notes` (multi-row per player).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScoutingNote {
    pub id: i64,
    pub player_id: String,
    pub kind: String,           // 'data' | 'link' | 'note'
    pub label: Option<String>,
    pub content: Option<String>,
    pub source: Option<String>,
    pub created_at: Option<String>,
}

/// Legge i dati asta di un giocatore (1:1 da `auction_data`).
/// Ritorna null se il giocatore non ha ancora dati asta.
#[tauri::command]
pub fn get_auction_data(
    state: State<'_, DbState>,
    player_id: String,
) -> AppResult<Option<AuctionData>> {
    let active_id = state.active_db_id()?;
    state.with_conn(&active_id, |conn| {
        let result = conn
            .query_row(
                r#"SELECT player_id, titolarita, infortuni, quick_note,
                          fmil_max, assigned_to, fmil_paid, assigned_at
                   FROM auction_data WHERE player_id = ?1"#,
                params![&player_id],
                |row| {
                    Ok(AuctionData {
                        player_id: row.get(0)?,
                        titolarita: row.get(1)?,
                        infortuni: row.get(2)?,
                        quick_note: row.get(3)?,
                        fmil_max: row.get(4)?,
                        assigned_to: row.get(5)?,
                        fmil_paid: row.get(6)?,
                        assigned_at: row.get(7)?,
                    })
                },
            )
            .ok();
        Ok(result)
    })
}

/// Salva (upsert) i dati asta di un giocatore. Solo i campi passati vengono
/// aggiornati; gli altri restano invariati. Inserisce la riga se non esiste.
///
/// Vincoli rispettati:
///  - titolarita in 1..=10 (CHECK schema)
///  - infortuni in ('nessuno', 'lieve', 'grave') (CHECK schema)
///  - fmil_max integer >= 0 (validazione Rust, schema permette NULL)
#[tauri::command]
pub fn save_auction_data(
    state: State<'_, DbState>,
    player_id: String,
    titolarita: Option<i64>,
    infortuni: Option<String>,
    fmil_max: Option<i64>,
    quick_note: Option<String>,
) -> AppResult<bool> {
    // Validazione
    if let Some(t) = titolarita {
        if !(1..=10).contains(&t) {
            return Err(AppError::Validation(format!("titolarita deve essere 1-10, avuto {}", t)));
        }
    }
    if let Some(ref inf) = infortuni {
        let valid = ["nessuno", "lieve", "grave"];
        if !valid.contains(&inf.as_str()) {
            return Err(AppError::Validation(format!(
                "infortuni deve essere uno di {:?}, avuto {:?}",
                valid, inf
            )));
        }
    }
    if let Some(fm) = fmil_max {
        if fm < 0 {
            return Err(AppError::Validation(format!("fmil_max deve essere >= 0, avuto {}", fm)));
        }
    }

    let active_id = state.active_db_id()?;
    // Verifica che il player esista + trova il suo db_id
    let db_id = state.with_conn(&active_id, |conn| {
        let d: String = conn
            .query_row(
                "SELECT db_id FROM players WHERE id = ?1",
                params![&player_id],
                |r| r.get(0),
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    AppError::NotFound(format!("giocatore id={} non trovato", player_id))
                }
                other => AppError::Db(other),
            })?;
        Ok(d)
    })?;

    state.with_conn(&db_id, |conn| {
        ensure_writable_db(conn, &db_id)?;

        // Upsert: INSERT OR REPLACE con i valori passati + COALESCE per i vecchi
        // Usiamo INSERT ... ON CONFLICT(player_id) DO UPDATE (SQLite 3.24+)
        conn.execute(
            r#"INSERT INTO auction_data (player_id, titolarita, infortuni, quick_note, fmil_max)
               VALUES (?1, ?2, ?3, ?4, ?5)
               ON CONFLICT(player_id) DO UPDATE SET
                 titolarita = COALESCE(excluded.titolarita, auction_data.titolarita),
                 infortuni = COALESCE(excluded.infortuni, auction_data.infortuni),
                 quick_note = COALESCE(excluded.quick_note, auction_data.quick_note),
                 fmil_max = COALESCE(excluded.fmil_max, auction_data.fmil_max)
               WHERE auction_data.player_id = ?1"#,
            params![&player_id, titolarita, infortuni, quick_note, fmil_max],
        )?;
        Ok(true)
    })
}

/// Elenca le note scouting di un giocatore (multi-row da `scouting_notes`).
/// Ordinate per id ASC (ordine di inserimento).
#[tauri::command]
pub fn list_scouting_notes(
    state: State<'_, DbState>,
    player_id: String,
) -> AppResult<Vec<ScoutingNote>> {
    let active_id = state.active_db_id()?;
    state.with_conn(&active_id, |conn| {
        let mut stmt = conn.prepare(
            r#"SELECT id, player_id, kind, label, content, source, created_at
               FROM scouting_notes WHERE player_id = ?1
               ORDER BY id ASC"#,
        )?;
        let rows = stmt.query_map(params![&player_id], |row| {
            Ok(ScoutingNote {
                id: row.get(0)?,
                player_id: row.get(1)?,
                kind: row.get(2)?,
                label: row.get(3)?,
                content: row.get(4)?,
                source: row.get(5)?,
                created_at: row.get(6)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    })
}

/// Assegna un giocatore a un team lega con un prezzo pagato (f₥).
/// Setta auction_data.assigned_to + fmil_paid + assigned_at.
/// Se la riga auction_data non esiste ancora, la crea.
#[tauri::command]
pub fn assign_player(
    state: State<'_, DbState>,
    player_id: String,
    assigned_to: String,
    fmil_paid: i64,
) -> AppResult<bool> {
    if fmil_paid < 0 {
        return Err(AppError::Validation(format!("fmil_paid deve essere >= 0, avuto {}", fmil_paid)));
    }
    if assigned_to.trim().is_empty() {
        return Err(AppError::Validation("assigned_to è obbligatorio".to_string()));
    }

    let active_id = state.active_db_id()?;
    let db_id = state.with_conn(&active_id, |conn| {
        let d: String = conn
            .query_row(
                "SELECT db_id FROM players WHERE id = ?1",
                params![&player_id],
                |r| r.get(0),
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    AppError::NotFound(format!("giocatore id={} non trovato", player_id))
                }
                other => AppError::Db(other),
            })?;
        Ok(d)
    })?;

    state.with_conn(&db_id, |conn| {
        ensure_writable_db(conn, &db_id)?;
        // Upsert con INSERT OR REPLACE su assigned_to/fmil_paid/assigned_at
        conn.execute(
            r#"INSERT INTO auction_data (player_id, assigned_to, fmil_paid, assigned_at)
               VALUES (?1, ?2, ?3, datetime('now'))
               ON CONFLICT(player_id) DO UPDATE SET
                 assigned_to = excluded.assigned_to,
                 fmil_paid = excluded.fmil_paid,
                 assigned_at = excluded.assigned_at
               WHERE auction_data.player_id = ?1"#,
            params![&player_id, &assigned_to, fmil_paid],
        )?;
        Ok(true)
    })
}
