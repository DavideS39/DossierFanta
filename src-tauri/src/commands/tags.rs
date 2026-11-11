//! M4 (v2.6) — Comandi Tauri per Tag & Filtri.
//!
//! Tre famiglie di comandi:
//!  1. **Tag CRUD**: create_tag, list_tags, delete_tag, list_all_tag_labels.
//!     Tag-timbro a testo libero, colore HSL derivato da hash(label)
//!     (stesso testo = stesso colore = stessa rotazione, sempre).
//!  2. **Filtri salvati**: save_filter, list_filters, delete_filter, apply_filter.
//!     Persiste un set di filtri attivi con nome, per riaprirli poi.
//!  3. **Sync-live**: save_tag_from_sync. Persiste tag ricevuto dal CRDT Yjs
//!     con `created_by='sync-live'`. NON emette evento (anti-loop A→B→A,
//!     come save_player_from_sync).
//!  4. **Autocomplete posReale**: list_pos_reale_values — DISTINCT pos_real
//!     per giocatori dello stesso pos_fanta (per datalist PlayerForm).
//!
//! Vincoli HARD M4:
//!  - #20: niente overhaul grafico. I TagStamp usano CSS base (M4.G farà SVG).
//!  - #21: tabella `player_links` creata nello schema ma NON popolata in M4.
//!         Nessun comando Rust tocca player_links in M4.
//!  - #22: tag-timbro testo libero, colore hash-based, rotazione hash-based.
//!         Niente tag predefiniti.
//!
//! Anti-loop sync-live (PB4-A pattern Yjs):
//!   Path LOCALE: utente crea tag → create_tag commit (created_by='me')
//!     → updateYDocTag → yTags.set(...) [transazione LOCALE Yjs]
//!     → Y.Doc 'update' con origin=undefined → provider broadcast
//!     → listener yTags.observe: transaction.local === true → SKIP persistenza
//!
//!   Path REMOTO: peer riceve update via sync-update-received
//!     → Y.applyUpdate(ydoc, bytes, this) → Y.Doc 'update' con origin=this
//!     → provider: origin === this → SKIP re-broadcast (anti-loop nativo)
//!     → listener yTags.observe: transaction.local === false → PROCEED
//!       → save_tag_from_sync (created_by='sync-live')
//!
//!   save_tag_from_sync NON triggera updateYDocTag (è un INSERT/UPDATE SQL
//!   diretto, non un bridge Yjs) → il peer ricevente NON ritrasmette. ✓

use crate::commands::{AppError, AppResult};
use crate::db::new_uuid;
use crate::DbState;
use rusqlite::{params, params_from_iter, types::Value as SqlValue};
use serde::{Deserialize, Serialize};

// ----------------------------------------------------------------------
// Tipi esposti al frontend
// ----------------------------------------------------------------------

/// Rappresentazione di un tag-timbro associato a un giocatore.
/// `color` è una stringa HSL derivata da hash(label) (cache su DB per
/// coherence tra Rust e UI, ma l'algoritmo è deterministico).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tag {
    pub id: String,
    pub player_id: String,
    pub label: String,
    /// HSL string in formato CSS: "hsl(42, 45%, 35%)". Derivata da hash(label).
    pub color: Option<String>,
    pub created_at: String,
    pub created_by: String,
    pub last_sync_at: Option<String>,
    pub sync_node_id: Option<String>,
}

/// Payload per `save_tag_from_sync` (tag ricevuto dal CRDT Yjs).
/// Mirror lato Rust di `TagSyncInput` lato TS.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TagSyncInput {
    pub id: String,
    pub player_id: String,
    pub label: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub sync_node_id: Option<String>,
}

/// Riga di `player_filters`: un filtro salvato con nome.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Filter {
    pub id: String,
    pub name: String,
    /// JSON string con i criteri: {tags, role, status, sort_by, sort_dir, ...}
    pub criteria_json: String,
    pub created_at: String,
}

/// Conteggio di tag per label (per la filter bar: "rigorista (3)").
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TagLabelCount {
    pub label: String,
    pub count: i64,
}

// ----------------------------------------------------------------------
// Helper: hash → colore HSL
// ----------------------------------------------------------------------

/// Calcola il colore HSL di un label via hash deterministico.
///
/// Algoritmo (vincolo M4 #22):
///   - hue = hash(label) % 360
///   - saturation = 45% (colori saturi ma non al neon)
///   - lightness = 35% (colori scuri su carta chiara #F4ECD8)
///
/// Stesso testo → stesso colore, sempre. L'UI usa lo stesso algoritmo
/// per la rotazione (hash(label) % 20 - 10 → ±10°), così tag con stesso
/// label hanno lo stesso aspetto su tutte le card e tutte le sessioni.
///
/// Implementazione: FNV-1a 32-bit (stesso algoritmo del frontend TS, così
/// i colori coincidono tra Rust e JS anche senza scambiarseli via wire).
pub fn hash_to_color(label: &str) -> String {
    let mut h: u32 = 0x811c9dc5;
    for b in label.as_bytes() {
        h ^= *b as u32;
        h = h.wrapping_mul(0x01000193);
    }
    let hue = h % 360;
    format!("hsl({}, 45%, 35%)", hue)
}

/// Calcola la rotazione (in gradi) di un tag via hash deterministico.
/// Range ±10° (più timbro-like, non eccessivo).
pub fn hash_to_rotation_deg(label: &str) -> f32 {
    let mut h: u32 = 0x811c9dc5;
    // Seed diverso da hash_to_color per indipendenza statistica del hue/rot.
    for b in label.as_bytes() {
        h = h.wrapping_add(*b as u32);
        h ^= h << 13;
        h ^= h >> 17;
        h ^= h << 5;
    }
    // 0..20 → -10..+10
    ((h % 20) as f32) - 10.0
}

// ----------------------------------------------------------------------
// Tag CRUD
// ----------------------------------------------------------------------

/// Crea un tag-timbro associato a un giocatore.
///
/// - `label` è testo libero (vincolo #22): "rigorista", "ex-Milan",
///   "occhio infortuni", qualsiasi cosa lo scout voglia marcire.
/// - Colore derivato da hash(label) (stesso testo = stesso colore).
/// - id = UUID v4. created_by = 'me'.
/// - Se il player appartiene al DB listone, rifiuta (no tag su read-only).
///
/// Non c'è un constraint UNIQUE(player_id, label): l'utente può in
/// principio creare lo stesso tag due volte, ma l'UI non offre il
/// pulsante se il tag esiste già. In futuro si può aggiungere un
/// UNIQUE constraint senza breaking change (vincolo additive).
#[tauri::command]
pub fn create_tag(
    state: tauri::State<'_, DbState>,
    player_id: String,
    label: String,
) -> AppResult<Tag> {
    let label_trim = label.trim().to_string();
    if label_trim.is_empty() {
        return Err(AppError::Validation(
            "label è obbligatorio (non può essere vuoto)".to_string(),
        ));
    }
    if label_trim.len() > 60 {
        return Err(AppError::Validation(
            "label troppo lungo (max 60 caratteri)".to_string(),
        ));
    }

    // Risolvi il db_id del player per:
    //  (a) ensure_writable_db (rifiuta tag su DB listone read-only)
    //  (b) usare la connessione giusta (anche se tutte puntano allo stesso file)
    let db_id = state.with_conn("default-personal", |conn| {
        let row: Option<String> = conn
            .query_row(
                "SELECT db_id FROM players WHERE id = ?1 LIMIT 1",
                params![&player_id],
                |r| r.get(0),
            )
            .ok();
        Ok::<_, AppError>(row)
    })?;

    let db_id = db_id.ok_or_else(|| {
        AppError::NotFound(format!(
            "player_id={} non trovato: impossibile creare tag",
            player_id
        ))
    })?;

    // M3a.5 — Il DB listone è read-only: niente tag su giocatori del listone.
    if db_id == "default-listone" {
        return Err(AppError::Validation(
            "i giocatori del DB listone sono read-only: impossibile aggiungere tag"
                .to_string(),
        ));
    }

    let id = new_uuid();
    let color = hash_to_color(&label_trim);
    let now = chrono::Utc::now().to_rfc3339();

    state.with_conn(&db_id, |conn| {
        conn.execute(
            "INSERT INTO player_tags (id, player_id, label, color, created_at, created_by, last_sync_at) \
             VALUES (?1, ?2, ?3, ?4, datetime('now'), 'me', ?5)",
            params![&id, &player_id, &label_trim, &color, &now],
        )?;
        // Re-read per avere created_at coerente col default SQLite (datetime('now')).
        let tag = conn.query_row(
            "SELECT id, player_id, label, color, created_at, created_by, last_sync_at, sync_node_id \
             FROM player_tags WHERE id = ?1",
            params![&id],
            |r| {
                Ok(Tag {
                    id: r.get(0)?,
                    player_id: r.get(1)?,
                    label: r.get(2)?,
                    color: r.get(3)?,
                    created_at: r.get(4)?,
                    created_by: r.get(5)?,
                    last_sync_at: r.get(6)?,
                    sync_node_id: r.get(7)?,
                })
            },
        )?;
        Ok(tag)
    })
}

/// Elenca i tag di un giocatore (se `player_id = Some`) o TUTTI i tag
/// (se `player_id = None`, per la filter bar autocomplete).
///
/// Il risultato è ordinato per `created_at ASC` (ordine di inserimento).
#[tauri::command]
pub fn list_tags(
    state: tauri::State<'_, DbState>,
    player_id: Option<String>,
) -> AppResult<Vec<Tag>> {
    state.with_conn("default-personal", |conn| {
        let mut sql = String::from(
            "SELECT id, player_id, label, color, created_at, created_by, last_sync_at, sync_node_id \
             FROM player_tags WHERE 1=1",
        );
        let mut bind_values: Vec<SqlValue> = Vec::new();
        if let Some(pid) = &player_id {
            sql.push_str(" AND player_id = ?");
            bind_values.push(SqlValue::Text(pid.clone()));
        }
        sql.push_str(" ORDER BY created_at ASC, id ASC");

        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(bind_values.iter()), |r| {
            Ok(Tag {
                id: r.get(0)?,
                player_id: r.get(1)?,
                label: r.get(2)?,
                color: r.get(3)?,
                created_at: r.get(4)?,
                created_by: r.get(5)?,
                last_sync_at: r.get(6)?,
                sync_node_id: r.get(7)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    })
}

/// Elimina un tag per id. NON richiede conferma lato Rust: eliminare un
/// tag non perde dati scouting (a differenza di eliminare un player).
/// La conferma è lato UI (con undo snackbar opzionale in futuro).
#[tauri::command]
pub fn delete_tag(state: tauri::State<'_, DbState>, id: String) -> AppResult<bool> {
    // Trova il db_id del player associato al tag (per la connessione giusta).
    let db_id = state.with_conn("default-personal", |conn| {
        let row: Option<String> = conn
            .query_row(
                "SELECT p.db_id FROM player_tags t JOIN players p ON p.id = t.player_id \
                 WHERE t.id = ?1 LIMIT 1",
                params![&id],
                |r| r.get(0),
            )
            .ok();
        Ok::<_, AppError>(row)
    })?;

    let db_id = db_id.ok_or_else(|| {
        // Tag non trovato — potrebbe essere già stato eliminato.
        // Ritorniamo false (no-op) invece di errore, per idempotenza UI.
        AppError::NotFound(format!("tag id={} non trovato", id))
    })?;

    if db_id == "default-listone" {
        return Err(AppError::Validation(
            "impossibile eliminare tag dal DB listone (read-only)".to_string(),
        ));
    }

    state.with_conn(&db_id, |conn| {
        let n = conn.execute("DELETE FROM player_tags WHERE id = ?1", params![&id])?;
        Ok(n > 0)
    })
}

/// Ritorna tutte le label di tag DISTINTE con conteggio (quanti player
/// hanno quel tag). Per la filter bar che mostra:
///   "rigorista (3)  ex-Milan (5)  occhio infortuni (1)"
///
/// Ordinamento per count DESC (i tag più usati prima), poi label ASC.
#[tauri::command]
pub fn list_all_tag_labels(
    state: tauri::State<'_, DbState>,
) -> AppResult<Vec<TagLabelCount>> {
    state.with_conn("default-personal", |conn| {
        let mut stmt = conn.prepare(
            "SELECT label, COUNT(DISTINCT player_id) AS n \
             FROM player_tags \
             GROUP BY label \
             ORDER BY n DESC, label COLLATE NOCASE ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(TagLabelCount {
                label: r.get(0)?,
                count: r.get(1)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    })
}

// ----------------------------------------------------------------------
// Sync-live: save_tag_from_sync
// ----------------------------------------------------------------------

/// Persiste un tag ricevuto dal sync CRDT Yjs.
///
/// Imposta `created_by='sync-live'` e `last_sync_at` (timestamp UTC).
/// NON emette evento Tauri (anti-loop A→B→A, come save_player_from_sync).
///
/// UPSERT: se il tag id esiste già, aggiorna label/color/sync_node_id.
/// Altrimenti INSERT. In entrambi i casi created_by forza a 'sync-live'
/// (un tag proveniente da sync non deve mai avere created_by='me' sul
/// peer ricevente, altrimenti auto-toggle spuri).
#[tauri::command]
pub fn save_tag_from_sync(
    state: tauri::State<'_, DbState>,
    input: TagSyncInput,
) -> AppResult<()> {
    if input.label.trim().is_empty() {
        return Err(AppError::Validation(
            "save_tag_from_sync: label vuoto non ammesso".to_string(),
        ));
    }

    // Risolvi il db_id del player per la connessione giusta + check listone.
    let db_id = state.with_conn("default-personal", |conn| {
        let row: Option<String> = conn
            .query_row(
                "SELECT db_id FROM players WHERE id = ?1 LIMIT 1",
                params![&input.player_id],
                |r| r.get(0),
            )
            .ok();
        Ok::<_, AppError>(row)
    })?;

    // Se il player non esiste ancora (sync iniziale non completato),
    // il tag viene droppato silenziosamente. Sarà riapplicato quando
    // il player arriva. Non è un errore: il CRDT Yjs lo mantiene in memoria.
    let db_id = match db_id {
        Some(d) => d,
        None => {
            log::warn!(
                "[sync] save_tag_from_sync: player_id={} non trovato (tag {} droppato, sarà riapplicato)",
                input.player_id, input.id
            );
            return Ok(());
        }
    };

    // Skip listone: i tag su giocatori del listone non hanno senso
    // (read-only, no sync).
    if db_id == "default-listone" {
        log::debug!(
            "[sync] save_tag_from_sync: skip tag su giocatore listone (read-only)"
        );
        return Ok(());
    }

    let color = input
        .color
        .clone()
        .unwrap_or_else(|| hash_to_color(&input.label));
    let now = chrono::Utc::now().to_rfc3339();

    state.with_conn(&db_id, |conn| {
        let exists: bool = conn
            .prepare("SELECT 1 FROM player_tags WHERE id = ?1 LIMIT 1")?
            .exists([&input.id])?;

        if exists {
            conn.execute(
                "UPDATE player_tags SET \
                   player_id = ?2, label = ?3, color = ?4, \
                   created_by = 'sync-live', last_sync_at = ?5, \
                   sync_node_id = COALESCE(?6, sync_node_id) \
                 WHERE id = ?1",
                params![
                    &input.id,
                    &input.player_id,
                    &input.label,
                    &color,
                    &now,
                    &input.sync_node_id,
                ],
            )?;
        } else {
            conn.execute(
                "INSERT INTO player_tags \
                   (id, player_id, label, color, created_at, created_by, last_sync_at, sync_node_id) \
                 VALUES (?1, ?2, ?3, ?4, datetime('now'), 'sync-live', ?5, ?6)",
                params![
                    &input.id,
                    &input.player_id,
                    &input.label,
                    &color,
                    &now,
                    &input.sync_node_id,
                ],
            )?;
        }
        Ok(())
    })
}

// ----------------------------------------------------------------------
// Filtri salvati
// ----------------------------------------------------------------------

/// Salva un filtro con nome. `criteria_json` è una stringa JSON con i
/// criteri (tags, role, status, sort_by, sort_dir, search, ...).
///
/// Esempio criteria_json:
///   {"tags":["rigorista","ex-Milan"],"role":"A","status":"scoutato",
///    "sort_by":"priority","sort_dir":"desc"}
///
/// Se esiste già un filtro con lo stesso `name`, viene sovrascritto
/// (UPDATE del criteria_json). Altrimenti INSERT nuovo.
#[tauri::command]
pub fn save_filter(
    state: tauri::State<'_, DbState>,
    name: String,
    criteria_json: String,
) -> AppResult<Filter> {
    let name_trim = name.trim().to_string();
    if name_trim.is_empty() {
        return Err(AppError::Validation(
            "name è obbligatorio (filtro senza nome non ammesso)".to_string(),
        ));
    }
    // Sanity check: criteria_json è JSON valido.
    serde_json::from_str::<serde_json::Value>(&criteria_json)
        .map_err(|e| AppError::Validation(format!("criteria_json non è JSON valido: {}", e)))?;

    let id = new_uuid();

    state.with_conn("default-personal", |conn| {
        // Upsert su name: se esiste, update criteria_json + id esistente.
        let existing_id: Option<String> = conn
            .query_row(
                "SELECT id FROM player_filters WHERE name = ?1 COLLATE NOCASE LIMIT 1",
                params![&name_trim],
                |r| r.get(0),
            )
            .ok();

        let final_id = match existing_id {
            Some(eid) => {
                conn.execute(
                    "UPDATE player_filters SET criteria_json = ?2 WHERE id = ?1",
                    params![&eid, &criteria_json],
                )?;
                eid
            }
            None => {
                conn.execute(
                    "INSERT INTO player_filters (id, name, criteria_json) VALUES (?1, ?2, ?3)",
                    params![&id, &name_trim, &criteria_json],
                )?;
                id.clone()
            }
        };

        let filter = conn.query_row(
            "SELECT id, name, criteria_json, created_at FROM player_filters WHERE id = ?1",
            params![&final_id],
            |r| {
                Ok(Filter {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    criteria_json: r.get(2)?,
                    created_at: r.get(3)?,
                })
            },
        )?;
        Ok(filter)
    })
}

/// Elenca tutti i filtri salvati, ordinati per name ASC.
#[tauri::command]
pub fn list_filters(state: tauri::State<'_, DbState>) -> AppResult<Vec<Filter>> {
    state.with_conn("default-personal", |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, criteria_json, created_at FROM player_filters \
             ORDER BY name COLLATE NOCASE ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(Filter {
                id: r.get(0)?,
                name: r.get(1)?,
                criteria_json: r.get(2)?,
                created_at: r.get(3)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    })
}

/// Elimina un filtro salvato per id. Idempotente (ritorna true se eliminato,
/// false se non esisteva).
#[tauri::command]
pub fn delete_filter(state: tauri::State<'_, DbState>, id: String) -> AppResult<bool> {
    state.with_conn("default-personal", |conn| {
        let n = conn.execute("DELETE FROM player_filters WHERE id = ?1", params![&id])?;
        Ok(n > 0)
    })
}

/// Applica un filtro salvato: ritorna la lista di `player_id` che matchano
/// i criteri salvati nel filtro.
///
/// Implementazione: deserializza criteria_json, applica gli stessi filtri
/// di `list_players` (search, role, status, fascia, db_id, tags) ma ritorna
/// solo gli id (non le righe complete) — il frontend può poi fare fetch
/// dettagliato se serve.
///
/// Tags filter: AND logico (il player deve avere TUTTI i tag specificati).
#[tauri::command]
pub fn apply_filter(
    state: tauri::State<'_, DbState>,
    id: String,
) -> AppResult<Vec<String>> {
    state.with_conn("default-personal", |conn| {
        let criteria_json: String = conn
            .query_row(
                "SELECT criteria_json FROM player_filters WHERE id = ?1",
                params![&id],
                |r| r.get(0),
            )
            .map_err(|_| {
                AppError::NotFound(format!("filtro id={} non trovato", id))
            })?;

        let criteria: serde_json::Value = serde_json::from_str(&criteria_json)
            .map_err(|e| AppError::Generic(format!("criteria_json invalido: {}", e)))?;

        // Costruisci query dinamica
        let mut sql = String::from("SELECT DISTINCT p.id FROM players p WHERE 1=1");
        let mut bind_values: Vec<SqlValue> = Vec::new();

        // Search
        if let Some(s) = criteria.get("search").and_then(|v| v.as_str()) {
            let like = format!("%{}%", s.trim());
            sql.push_str(" AND (p.name LIKE ? COLLATE NOCASE OR COALESCE(p.team,'') LIKE ? COLLATE NOCASE)");
            bind_values.push(SqlValue::Text(like.clone()));
            bind_values.push(SqlValue::Text(like));
        }
        // Role
        if let Some(r) = criteria.get("role").and_then(|v| v.as_str()) {
            sql.push_str(" AND p.pos_fanta = ?");
            bind_values.push(SqlValue::Text(r.to_string()));
        }
        // Status
        if let Some(st) = criteria.get("status").and_then(|v| v.as_str()) {
            sql.push_str(" AND p.status = ?");
            bind_values.push(SqlValue::Text(st.to_string()));
        }
        // Fascia
        if let Some(f) = criteria.get("fascia").and_then(|v| v.as_str()) {
            sql.push_str(" AND p.fascia = ?");
            bind_values.push(SqlValue::Text(f.to_string()));
        }
        // Tags: AND logico — per ogni tag, il player deve avere una riga in player_tags.
        if let Some(tags) = criteria.get("tags").and_then(|v| v.as_array()) {
            for tag_v in tags {
                if let Some(t) = tag_v.as_str() {
                    // EXISTS subquery: il player ha una riga con questa label.
                    sql.push_str(
                        " AND EXISTS (SELECT 1 FROM player_tags t WHERE t.player_id = p.id AND t.label = ? COLLATE NOCASE)",
                    );
                    bind_values.push(SqlValue::Text(t.to_string()));
                }
            }
        }

        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(bind_values.iter()), |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    })
}

// ----------------------------------------------------------------------
// Autocomplete posReale (Deliverable 10)
// ----------------------------------------------------------------------

/// Ritorna i valori DISTINCT di `pos_real` per i giocatori dello stesso
/// `pos_fanta` del player corrente. Per la `<datalist>` nel PlayerForm
/// che suggerisce ruoli reali già usati (es. "Punta centrale", "Ala destra").
///
/// Query:
///   SELECT DISTINCT pos_real FROM players
///   WHERE db_id = ? AND pos_fanta = ? AND pos_real IS NOT NULL
///   ORDER BY pos_real
///
/// `db_id` esplicito (M2 pattern): se None, usa active_db_id.
#[tauri::command]
pub fn list_pos_reale_values(
    state: tauri::State<'_, DbState>,
    db_id: Option<String>,
    pos_fanta: String,
) -> AppResult<Vec<String>> {
    // Validate pos_fanta.
    const POS_FANTA_VALUES: &[&str] = &["P", "D", "C", "A"];
    if !POS_FANTA_VALUES.contains(&pos_fanta.as_str()) {
        return Err(AppError::Validation(format!(
            "pos_fanta deve essere uno di {:?}, avuto {:?}",
            POS_FANTA_VALUES, pos_fanta
        )));
    }

    let active_id = state.active_db_id()?;
    let effective_db_id = match db_id.as_deref() {
        Some(d) if !d.is_empty() && d != "all" => d.to_string(),
        _ => active_id,
    };

    state.with_conn(&effective_db_id, |conn| {
        let mut stmt = conn.prepare(
            "SELECT DISTINCT pos_real FROM players \
             WHERE db_id = ?1 AND pos_fanta = ?2 AND pos_real IS NOT NULL AND pos_real != '' \
             ORDER BY pos_real COLLATE NOCASE ASC",
        )?;
        let rows = stmt.query_map(params![&effective_db_id, &pos_fanta], |r| {
            r.get::<_, String>(0)
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    })
}
