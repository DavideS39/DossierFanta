//! `commands/pairing.rs` — Pairing flow M3a.4 (CRUD) + M3a.5 (8-digit code flow).
//!
//! Implementa:
//!  - **CRUD `sync_pairings`**: list/save/delete pairings (M3a.4)
//!  - **Crypto Tauri commands**: `derive_shared_secret`, `encrypt_update`,
//!    `decrypt_update` — espongono i helper di `crypto.rs` al frontend
//!  - **Pairing flow M3a.5**: `pairing_create` (initiator) + `pairing_join`
//!    (responder) + `pairing_complete` (initiator) + `pairing_cancel`.
//!
//! # Flusso pairing M3a.5 (8-digit code + ECDH)
//!
//! ```text
//! A (initiator)                       B (responder)
//! ---------------------              ---------------------
//! 1. pairing_create()
//!    - generate code "12345678"
//!    - get my_peer_key from sync_identity
//!    - INSERT Supabase pairings { code, peer_key_initiator: my_peer_key }
//!    - subscribe Realtime "pairing-12345678" (listen for B's response)
//!    - INSERT sync_pairings_pending (local, for crash-resume)
//!    - return { code, expires_at }
//!
//! 2. A tells B the code (out-of-band: voice/SMS/in-person)
//!
//!                                    3. pairing_join("12345678")
//!                                       - SELECT Supabase pairings WHERE code →
//!                                         get peer_key_initiator (A's key)
//!                                       - derive_shared_secret(peer_key_initiator)
//!                                         → 32-byte shared_secret (ECDH)
//!                                       - derive_room_name(shared_secret)
//!                                       - broadcast Realtime "pairing-12345678":
//!                                         { kind: 'response', peer_key_responder: B's key }
//!                                       - save sync_pairings locally
//!                                       - iroh_connect(peer_key_initiator)
//!                                       - return { peer_key_other, room_name, shared_secret }
//!
//! 4. A's Realtime listener fires with B's response
//!    - pairing_complete("12345678", peer_key_responder)
//!      - derive_shared_secret(peer_key_responder)
//!        → MATEMATICA ECDH: stessa shared_secret di B
//!      - derive_room_name → stesso room_name
//!      - save sync_pairings locally
//!      - iroh_connect(peer_key_responder)
//!      - DELETE Supabase pairings WHERE code
//!      - DELETE sync_pairings_pending WHERE code (local)
//!      - return { peer_key_other, room_name, shared_secret }
//! ```
//!
//! # Security model
//!
//!  - Il codice 8-cifre è SOLO un rendezvous point. NON contiene materiale
//!    crittografico. Anche se intercettato, senza il SecretKey di A o B,
//!    l'attaccante non può derivare shared_secret.
//!  - shared_secret è mai trasmessa. Derivata localmente via X25519 ECDH.
//!  - peer_keys (public) sono scambiate via Supabase pairings table. Sono
//!    pubbliche per definizione (X25519 PublicKeys possono essere condivise).
//!  - Codice scade 5 min dopo creazione (cleanup async su Supabase +
//!    sync_pairings_pending locale).

use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::crypto::{
    derive_room_name_inner, derive_shared_secret_inner, decrypt_update_inner,
    encrypt_update_inner, generate_pairing_code_inner,
};
use crate::commands::{AppError, AppResult};

// ----------------------------------------------------------------------
// Tipi serializzabili
// ----------------------------------------------------------------------

/// Pairing persistito in `sync_pairings` table.
/// Ritornato da `list_pairings` e `pairing_complete`/`pairing_join`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Pairing {
    /// NodeId Iroh (base32) del peer pairato.
    pub peer_key_other: String,
    /// 32-byte chiave ECDH (serializzata come array di u8 per JSON).
    pub shared_secret: Vec<u8>,
    /// room_name derivato ("df-sync-<hex16>").
    pub room_name: String,
    /// Nome umano opzionale.
    pub display_name: Option<String>,
    /// ISO 8601 primo pairing.
    pub paired_at: String,
    /// ISO 8601 ultimo sync.
    pub last_seen: Option<String>,
}

/// Output di `pairing_create` (initiator side).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairingCode {
    /// 8-cifre "12345678".
    pub code: String,
    /// ISO 8601 scadenza (5 min dopo created_at).
    pub expires_at: String,
    /// M3a.3 fix post-review — Lista di codici pending precedentemente attivi
    /// che sono stati revocati da questo `pairing_create` (per garantire
    /// 1 solo codice alla volta). Il frontend li DELETE su Supabase
    /// `pairings` table.
    pub revoked_codes: Vec<String>,
}

/// Output di `pairing_join` (responder) e `pairing_complete` (initiator).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairingResult {
    /// peer_key del peer appena pairato (per Iroh connect lato frontend).
    pub peer_key_other: String,
    /// room_name derivato dalla shared_secret.
    pub room_name: String,
    /// shared_secret (32 byte) — per il frontend SupabaseYjsProvider.
    /// È anche persistita in sync_pairings.shared_secret dal lato Rust.
    pub shared_secret: Vec<u8>,
}

// ----------------------------------------------------------------------
// M3a.4 — Crypto Tauri commands
// ----------------------------------------------------------------------

/// Deriva la shared_secret (32 byte) dal mio SecretKey Iroh + their peer_key.
///
/// Usa X25519 ECDH: `my_secret_scalar * their_public_point`. Il risultato
/// è la STESSA shared_secret che l'altro peer deriva dal suo SecretKey +
/// la mia peer_key (proprietà ECDH).
#[tauri::command]
pub fn derive_shared_secret(
    state: State<'_, crate::DbState>,
    their_peer_key: String,
) -> AppResult<Vec<u8>> {
    let db_id = state.active_db_id()?;
    state.with_conn(&db_id, |conn| {
        derive_shared_secret_inner(conn, &their_peer_key)
    })
}

/// Cifra `update` (Yjs bytes binari) con AES-256-GCM usando `shared_secret`.
///
/// Output: `[nonce(12) || ciphertext || tag(16)]`. Da inviare via Supabase
/// Realtime broadcast o persistire in `yjs_updates.update_bytes`.
#[tauri::command]
pub fn encrypt_update(
    update: Vec<u8>,
    shared_secret: Vec<u8>,
) -> AppResult<Vec<u8>> {
    encrypt_update_inner(&update, &shared_secret)
}

/// Decifra `ciphertext` (formato `[nonce(12) || ciphertext || tag(16)]`)
/// con AES-256-GCM usando `shared_secret`.
///
/// Ritorna plaintext (Yjs bytes) se il tag è valido.
/// Ritorna `Err` se il tag è invalido (ciphertext manipolato, wrong key).
#[tauri::command]
pub fn decrypt_update(
    ciphertext: Vec<u8>,
    shared_secret: Vec<u8>,
) -> AppResult<Vec<u8>> {
    decrypt_update_inner(&ciphertext, &shared_secret)
}

// ----------------------------------------------------------------------
// M3a.4 — sync_pairings CRUD
// ----------------------------------------------------------------------

/// Lista tutti i pairings salvati (per boot auto-connect del SupabaseYjsProvider).
#[tauri::command]
pub fn list_pairings(state: State<'_, crate::DbState>) -> AppResult<Vec<Pairing>> {
    let db_id = state.active_db_id()?;
    state.with_conn(&db_id, |conn| {
        let table_exists: bool = conn
            .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_pairings' LIMIT 1")?
            .exists([])?;
        if !table_exists {
            return Ok(Vec::new()); // DB pre-v2.5
        }
        let mut stmt = conn.prepare(
            "SELECT peer_key_other, shared_secret, room_name, display_name, paired_at, last_seen
             FROM sync_pairings ORDER BY paired_at DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(Pairing {
                peer_key_other: r.get(0)?,
                shared_secret: r.get(1)?,
                room_name: r.get(2)?,
                display_name: r.get(3)?,
                paired_at: r.get(4)?,
                last_seen: r.get(5)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    })
}

/// Salva un pairing in `sync_pairings` (chiamato da `pairing_join` /
/// `pairing_complete`, ma anche esponibile per UI manuale in casi limite).
///
/// Idempotente via INSERT OR REPLACE (chiave UNIQUE su peer_key_other).
#[tauri::command]
pub fn save_pairing(
    state: State<'_, crate::DbState>,
    peer_key_other: String,
    shared_secret: Vec<u8>,
    room_name: String,
    display_name: Option<String>,
) -> AppResult<()> {
    let db_id = state.active_db_id()?;
    state.with_conn(&db_id, |conn| {
        let table_exists: bool = conn
            .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_pairings' LIMIT 1")?
            .exists([])?;
        if !table_exists {
            return Err(AppError::Generic(
                "sync_pairings table non esistente (DB pre-v2.5). Aggiorna il DB.".into(),
            ));
        }
        conn.execute(
            "INSERT OR REPLACE INTO sync_pairings
               (peer_key_other, shared_secret, room_name, display_name, paired_at)
             VALUES (?1, ?2, ?3, ?4, datetime('now'))",
            params![peer_key_other, shared_secret, room_name, display_name],
        )?;
        log::info!(
            "[M3a.4] save_pairing: peer={} room={} (cifrato ECDH)",
            peer_key_other.get(..16).unwrap_or(&peer_key_other),
            room_name
        );
        Ok(())
    })
}

/// Rimuove un pairing (imposta trusted=0 — ma qui non c'è flag trusted,
/// semplicemente DELETE, perché il pairing è l'identità del channel cifrato;
/// se lo rimuovi non puoi più decifrare i suoi bytes accumulati. Per
/// il tracciamento storico si può aggiungere una colonna `archived` in futuro).
///
/// NON tocca sync_peers (lista Iroh) — quelli sono trusted peer separati.
/// Se vuoi rimuovere completamente, chiama anche `remove_trusted_peer`.
#[tauri::command]
pub fn delete_pairing(
    state: State<'_, crate::DbState>,
    peer_key_other: String,
) -> AppResult<()> {
    let db_id = state.active_db_id()?;
    state.with_conn(&db_id, |conn| {
        let n = conn.execute(
            "DELETE FROM sync_pairings WHERE peer_key_other = ?1",
            params![peer_key_other],
        )?;
        if n == 0 {
            log::debug!(
                "[M3a.4] delete_pairing: peer {} non trovato in sync_pairings.",
                peer_key_other
            );
        } else {
            log::info!(
                "[M3a.4] delete_pairing: peer {} rimosso. Bytes accumulati non più decifrabili.",
                peer_key_other
            );
        }
        Ok(())
    })
}

// ----------------------------------------------------------------------
// M3a.5 — Pairing flow con 8-digit code
// ----------------------------------------------------------------------

/// Genera un codice 8-cifre + lo persiste in `sync_pairings_pending` locale.
///
/// **M3a.3 fix post-review — 1 solo codice alla volta.** Prima di generare il
/// nuovo codice, revoca TUTTI i codici pending esistenti per questo utente:
///   1. SELECT sync_pairings_pending (per ottenere la lista vecchi codici)
///   2. DELETE FROM sync_pairings_pending (locale)
///   3. Ritorna la lista dei vecchi codici al chiamante (frontend), che poi
///      farà DELETE su Supabase `pairings` table per ognuno.
///
/// NOTA: la pubblicazione su Supabase `pairings` table è gestita dal frontend
/// (chiama Supabase client diretto). Questo comando Rust genera solo il codice
/// + lo salva localmente per tracking/crash-resume + revoca i precedenti.
///
/// Return: `PairingCode { code: "12345678", expires_at: "...", revoked_codes: [...] }`.
#[tauri::command]
pub fn pairing_create(
    state: State<'_, crate::DbState>,
) -> AppResult<PairingCode> {
    let db_id = state.active_db_id()?;

    // Recupera il mio peer_key da sync_identity (deve esistere — se non
    // esiste, l'utente deve prima avviare Iroh per generare SecretKey).
    let my_peer_key: String = state.with_conn(&db_id, |conn| {
        let table_exists: bool = conn
            .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_identity' LIMIT 1")?
            .exists([])?;
        if !table_exists {
            return Err(AppError::Generic(
                "sync_identity table non esistente. Avvia Iroh prima (iroh_start_node).".into(),
            ));
        }
        let pk: String = conn.query_row(
            "SELECT peer_key FROM sync_identity WHERE id = 1 LIMIT 1",
            [],
            |r| r.get(0),
        ).map_err(|e| AppError::Generic(format!(
            "sync_identity row non trovata (iroh_start_node chiamato?): {}", e
        )))?;
        Ok(pk)
    })?;

    // M3a.3 fix post-review — Revoca tutti i codici pending precedenti
    // per garantire 1 solo codice attivo alla volta (anche cross-restart).
    // I vecchi codici vengono restituiti al frontend che li DELETE su Supabase.
    let revoked_codes: Vec<String> = state.with_conn(&db_id, |conn| {
        let table_exists: bool = conn
            .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_pairings_pending' LIMIT 1")?
            .exists([])?;
        if !table_exists {
            return Err(AppError::Generic(
                "sync_pairings_pending table non esistente (DB pre-v2.5).".into(),
            ));
        }
        // SELECT vecchi codici (escluso quello che stiamo per generare —
        // generazione dopo, quindi qui è tutto "vecchio").
        let mut stmt = conn.prepare(
            "SELECT code FROM sync_pairings_pending ORDER BY created_at DESC",
        )?;
        let old_codes: Vec<String> = stmt.query_map([], |r| r.get::<_, String>(0))?
            .filter_map(|r| r.ok())
            .collect();
        if !old_codes.is_empty() {
            log::info!(
                "[M3a.5] pairing_create: revocati {} codice/i pending precedenti: {:?}",
                old_codes.len(),
                old_codes
            );
            // DELETE tutti i pending precedenti.
            conn.execute("DELETE FROM sync_pairings_pending", [])?;
        }
        Ok(old_codes)
    })?;

    // Genera il nuovo codice.
    let code = generate_pairing_code_inner();

    // Salva in sync_pairings_pending (local tracking per crash-resume).
    state.with_conn(&db_id, |conn| {
        let table_exists: bool = conn
            .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_pairings_pending' LIMIT 1")?
            .exists([])?;
        if !table_exists {
            return Err(AppError::Generic(
                "sync_pairings_pending table non esistente (DB pre-v2.5).".into(),
            ));
        }
        conn.execute(
            "INSERT OR REPLACE INTO sync_pairings_pending (code, peer_key_initiator, created_at)
             VALUES (?1, ?2, datetime('now'))",
            params![code, my_peer_key],
        )?;
        Ok(())
    })?;

    // Calcola expires_at (5 min da ora).
    let now = chrono::Utc::now();
    let expires_at = (now + chrono::Duration::minutes(5)).to_rfc3339();

    log::info!(
        "[M3a.5] pairing_create: code={} expires_at={} revoked={} (pubblicazione su Supabase gestita dal frontend)",
        code,
        expires_at,
        revoked_codes.len()
    );

    Ok(PairingCode { code, expires_at, revoked_codes })
}

/// Completa il pairing dal lato initiator: quando il responder risponde via
/// Realtime broadcast sul canale `pairing-<code>`, l'initiator chiama questo
/// comando con la peer_key del responder.
///
/// Comportamento:
///  1. Deriva shared_secret = ECDH(my_secret, their_peer_key_responder)
///  2. Deriva room_name = "df-sync-<hex(sha256(shared_secret))[:16]>"
///  3. Salva pairing in sync_pairings (INSERT OR REPLACE)
///  4. Cleanup sync_pairings_pending (DELETE WHERE code)
///  5. Ritorna PairingResult per il frontend (per il SupabaseYjsProvider)
///
/// Il cleanup della tabella Supabase `pairings` + unsubscribe Realtime
/// è gestito dal frontend.
#[tauri::command]
pub fn pairing_complete(
    state: State<'_, crate::DbState>,
    code: String,
    peer_key_responder: String,
) -> AppResult<PairingResult> {
    let db_id = state.active_db_id()?;
    let shared_secret = state.with_conn(&db_id, |conn| {
        derive_shared_secret_inner(conn, &peer_key_responder)
    })?;
    let room_name = derive_room_name_inner(&shared_secret);

    // Salva pairing localmente.
    state.with_conn(&db_id, |conn| {
        let table_exists: bool = conn
            .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_pairings' LIMIT 1")?
            .exists([])?;
        if !table_exists {
            return Err(AppError::Generic(
                "sync_pairings table non esistente (DB pre-v2.5).".into(),
            ));
        }
        conn.execute(
            "INSERT OR REPLACE INTO sync_pairings
               (peer_key_other, shared_secret, room_name, display_name, paired_at)
             VALUES (?1, ?2, ?3, NULL, datetime('now'))",
            params![peer_key_responder, &shared_secret, &room_name],
        )?;
        // Cleanup sync_pairings_pending locale.
        conn.execute(
            "DELETE FROM sync_pairings_pending WHERE code = ?1",
            params![code],
        )?;
        Ok::<(), AppError>(())
    })?;

    log::info!(
        "[M3a.5] pairing_complete: code={} → pairato con {} (room={})",
        code,
        peer_key_responder.get(..16).unwrap_or(&peer_key_responder),
        room_name
    );

    Ok(PairingResult {
        peer_key_other: peer_key_responder,
        room_name,
        shared_secret,
    })
}

/// Lato responder: entra il codice 8-cifre ricevuto dall'initiator, deriva
/// shared_secret + room_name, salva pairing, ritorna PairingResult.
///
/// NOTA: la lettura della tabella Supabase `pairings` (per ottenere
/// peer_key_initiator) è gestita dal frontend. Questo comando Riceve la
/// peer_key_initiator come parametro.
///
/// Comportamento:
///  1. Deriva shared_secret = ECDH(my_secret, peer_key_initiator)
///  2. Deriva room_name
///  3. Salva pairing in sync_pairings
///  4. Ritorna PairingResult
///
/// Il frontend poi:
///  - Broadcast su Realtime `pairing-<code>`: { peer_key_responder: my_peer_key }
///  - iroh_connect(peer_key_initiator)
///  - SupabaseYjsProvider.subscribe(room_name, shared_secret)
#[tauri::command]
pub fn pairing_join(
    state: State<'_, crate::DbState>,
    code: String,
    peer_key_initiator: String,
) -> AppResult<PairingResult> {
    let db_id = state.active_db_id()?;
    let shared_secret = state.with_conn(&db_id, |conn| {
        derive_shared_secret_inner(conn, &peer_key_initiator)
    })?;
    let room_name = derive_room_name_inner(&shared_secret);

    // Salva pairing localmente.
    state.with_conn(&db_id, |conn| {
        let table_exists: bool = conn
            .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_pairings' LIMIT 1")?
            .exists([])?;
        if !table_exists {
            return Err(AppError::Generic(
                "sync_pairings table non esistente (DB pre-v2.5).".into(),
            ));
        }
        conn.execute(
            "INSERT OR REPLACE INTO sync_pairings
               (peer_key_other, shared_secret, room_name, display_name, paired_at)
             VALUES (?1, ?2, ?3, NULL, datetime('now'))",
            params![peer_key_initiator, &shared_secret, &room_name],
        )?;
        Ok::<(), AppError>(())
    })?;

    log::info!(
        "[M3a.5] pairing_join: code={} → pairato con {} (room={})",
        code,
        peer_key_initiator.get(..16).unwrap_or(&peer_key_initiator),
        room_name
    );

    Ok(PairingResult {
        peer_key_other: peer_key_initiator,
        room_name,
        shared_secret,
    })
}

/// Cancella un pairing in corso (initiator side). Rimuove il codice da
/// sync_pairings_pending locale. Il cleanup Supabase è gestito dal frontend.
#[tauri::command]
pub fn pairing_cancel(
    state: State<'_, crate::DbState>,
    code: String,
) -> AppResult<()> {
    let db_id = state.active_db_id()?;
    state.with_conn(&db_id, |conn| {
        let table_exists: bool = conn
            .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_pairings_pending' LIMIT 1")?
            .exists([])?;
        if !table_exists {
            return Ok(()); // DB pre-v2.5, niente da cancellare
        }
        let n = conn.execute(
            "DELETE FROM sync_pairings_pending WHERE code = ?1",
            params![code],
        )?;
        log::info!("[M3a.5] pairing_cancel: code={} ({} righe rimosse)", code, n);
        Ok(())
    })
}

/// Lista dei codici pairing pending (in corso, initiator side).
/// Per UI: mostra "codice attivo: 12345678, scade tra 3 min".
///
/// M3a.3 fix post-review — Filtra SOLO i codici non scaduti (created_at >
/// NOW() - 5 min). I codici scaduti restano nel DB ma non vengono mostrati
/// nella UI (verranno puliti dal cleanup schedulato — vedi
/// `cleanup_expired_pending_pairings`). Questo risolve il bug "il codice
/// rimane sempre in pending": se l'utente chiude l'app prima dello scadere
/// del countdown, al riavvio il codice vecchio non viene più mostrato.
#[tauri::command]
pub fn list_pending_pairings(
    state: State<'_, crate::DbState>,
) -> AppResult<Vec<PairingPending>> {
    let db_id = state.active_db_id()?;
    state.with_conn(&db_id, |conn| {
        let table_exists: bool = conn
            .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_pairings_pending' LIMIT 1")?
            .exists([])?;
        if !table_exists {
            return Ok(Vec::new()); // DB pre-v2.5
        }
        // M3a.3 fix post-review — Filtra solo codici non scaduti (< 5 min).
        // SQLite `datetime('now', '-5 minutes')` ritorna timestamp UTC in
        // formato ISO 8601 (stesso formato usato da `datetime('now')` nelle
        // INSERT). Confronto string-based funziona perché il formato è
        // lessicograficamente ordinabile.
        let mut stmt = conn.prepare(
            "SELECT code, peer_key_initiator, created_at
             FROM sync_pairings_pending
             WHERE created_at > datetime('now', '-5 minutes')
             ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(PairingPending {
                code: r.get(0)?,
                peer_key_initiator: r.get(1)?,
                created_at: r.get(2)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    })
}

/// Codice pairing pending (in corso).
#[derive(Debug, Clone, Serialize)]
pub struct PairingPending {
    pub code: String,
    pub peer_key_initiator: String,
    pub created_at: String,
}

/// M3a.3 fix post-review — Pulisce i codici pairing pending scaduti dal DB
/// locale (`sync_pairings_pending`). Scaduti = `created_at < NOW() - 5 min`.
///
/// Chiamato dal frontend:
///  - Al boot dell'app (App.tsx) per pulire codici lasciati da sessioni
///    precedenti chiuse male (es. utente ha chiuso l'app prima dello
///    scadere del countdown, il cleanup automatico non è partito).
///  - Ogni 60 secondi dal polling di SyncView, insieme al cleanup Supabase
///    `cleanupExpiredPairings`.
///
/// Ritorna il numero di righe eliminate (per logging).
#[tauri::command]
pub fn cleanup_expired_pending_pairings(
    state: State<'_, crate::DbState>,
) -> AppResult<i64> {
    let db_id = state.active_db_id()?;
    state.with_conn(&db_id, |conn| {
        let table_exists: bool = conn
            .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_pairings_pending' LIMIT 1")?
            .exists([])?;
        if !table_exists {
            return Ok(0); // DB pre-v2.5
        }
        let n = conn.execute(
            "DELETE FROM sync_pairings_pending WHERE created_at < datetime('now', '-5 minutes')",
            [],
        )?;
        if n > 0 {
            log::info!("[M3a.5] cleanup_expired_pending_pairings: {} codice/i scaduto/i rimossi", n);
        }
        Ok(n as i64)
    })
}

/// M3a.3 fix post-review (Round 5) — Cancella TUTTI i codici pairing pending
/// dal DB locale, indipendentemente dall'età. Diverso da `cleanup_expired_pending_pairings`
/// che cancella solo i scaduti (>5 min).
///
/// Casi d'uso:
///  - **Boot dell'app**: cancella TUTTI i pending orfani lasciati da sessioni
///    precedenti. Al boot non c'è countdown UI attivo, quindi qualsiasi codice
///    pending è orfano (l'initiator non può più ricevere risposte). Cancellarli
///    tutti è safe e risolve il bug "codice rimane sempre in pending".
///  - **Pulsante "cancella tutti" nella UI**: più efficiente di N chiamate
///    `pairing_cancel` separate (una singola DELETE vs N DELETE).
///
/// Ritorna il numero di righe eliminate (per logging).
#[tauri::command]
pub fn cleanup_all_pending_pairings(
    state: State<'_, crate::DbState>,
) -> AppResult<i64> {
    let db_id = state.active_db_id()?;
    state.with_conn(&db_id, |conn| {
        let table_exists: bool = conn
            .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_pairings_pending' LIMIT 1")?
            .exists([])?;
        if !table_exists {
            return Ok(0); // DB pre-v2.5
        }
        let n = conn.execute("DELETE FROM sync_pairings_pending", [])?;
        if n > 0 {
            log::info!("[M3a.5] cleanup_all_pending_pairings: {} codice/i rimossi (boot/pulsante cancella tutti)", n);
        }
        Ok(n as i64)
    })
}

/// Aggiorna last_seen di un pairing (chiamato ogni volta che il
/// SupabaseYjsProvider riceve un update da quel pairing).
#[tauri::command]
pub fn touch_pairing_last_seen(
    state: State<'_, crate::DbState>,
    peer_key_other: String,
) -> AppResult<()> {
    let db_id = state.active_db_id()?;
    state.with_conn(&db_id, |conn| {
        let _ = conn.execute(
            "UPDATE sync_pairings SET last_seen = datetime('now') WHERE peer_key_other = ?1",
            params![peer_key_other],
        );
        Ok(())
    })
}

/// Imposta il display_name di un pairing (es. "Giorgio").
#[tauri::command]
pub fn set_pairing_display_name(
    state: State<'_, crate::DbState>,
    peer_key_other: String,
    name: String,
) -> AppResult<()> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("display_name vuoto non ammesso".into()));
    }
    if trimmed.len() > 64 {
        return Err(AppError::Validation(format!(
            "display_name troppo lungo (max 64, dati {})",
            trimmed.len()
        )));
    }
    let db_id = state.active_db_id()?;
    state.with_conn(&db_id, |conn| {
        let n = conn.execute(
            "UPDATE sync_pairings SET display_name = ?1 WHERE peer_key_other = ?2",
            params![trimmed, peer_key_other],
        )?;
        if n == 0 {
            return Err(AppError::Generic(format!(
                "Pairing con peer {} non trovato in sync_pairings.",
                peer_key_other
            )));
        }
        Ok(())
    })
}
