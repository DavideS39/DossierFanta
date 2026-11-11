//! `commands/crypto.rs` — Crypto helpers per pairing M3a.4 + M3a.5.
//!
//! Implementa:
//!  - **X25519 ECDH** per derivare shared_secret tra due peer Iroh
//!    (my_SecretKey * their_PublicKey → 32-byte shared_secret)
//!  - **AES-256-GCM** per cifrare/decifrare i bytes Yjs scambiati via
//!    Supabase Realtime broadcast + tabella `yjs_updates`
//!  - **SHA-256** per derivare `room_name` dalla shared_secret
//!    (`df-sync-<hex(sha256(shared_secret))[:16]>`)
//!
//! # Perché Rust e non frontend?
//!
//! La SecretKey Iroh vive in `sync_identity` (SQLite locale, mai esposta).
//! Per derivare `shared_secret = X25519(my_secret, their_public)`, dobbiamo
//! accedere alla SecretKey — il frontend non ce l'ha (e NON deve averla).
//! Tutte le operazioni ECDH + AES-GCM vivono qui in Rust. Il frontend
//! chiama i comandi Tauri esposti sotto.
//!
//! # Security model
//!
//!  - **shared_secret** (32 byte) è crittograficamente equivalente a una
//!    chiave privata. Vive solo in memoria Rust durante il calcolo ECDH,
//!    e persistita in `sync_pairings.shared_secret` (BLOB SQLite locale).
//!    Mai trasmessa in chiaro, mai nel JS bundle.
//!  - **AES-256-GCM** con 12-byte random nonce (OsRng). nonce prepended
//!    al ciphertext. 16-byte tag di autenticazione appended. Formato
//!    bytes = `[nonce(12) || ciphertext(N) || tag(16)]`. Violazione del
//!    tag = reject (autenticazione garantita).
//!  - **room_name** è `df-sync-<hex(sha256(shared_secret))[:16]>` (16 char
//!    hex = 64 bit di entropia). Unguessable senza shared_secret. Anche se
//!    un attaccante può enumerare i room_name da `SELECT DISTINCT`, senza
//!    shared_secret non può decifrare i bytes.
//!
//! # Vincoli HARD rispettati
//!
//!  - #18: Supabase NON è authoritativo. SQLite locale è source of truth.
//!    La shared_secret è in sync_pairings, NON in Supabase.
//!  - #20 (esteso): tabella `yjs_updates` contiene SOLO bytes cifrati AES-GCM.
//!    Nessun dato sensibile in chiaro.
//!  - #19: SUPABASE_URL e SUPABASE_ANON_KEY hardcoded (chiave publishable).
//!    La sicurezza è garantita dalla cifratura end-to-end, non da Supabase.

use aes_gcm::aead::{Aead, KeyInit, OsRng as AesOsRng};
use rand::RngCore;  // for `OsRng::fill_bytes` (trait method)
use aes_gcm::{Aes256Gcm, Key, Nonce};
use curve25519_dalek::montgomery::MontgomeryPoint;
use curve25519_dalek::scalar::Scalar;
use rand::Rng;
use sha2::{Digest, Sha256};

use crate::commands::{AppError, AppResult};

// ----------------------------------------------------------------------
// ECDH X25519
// ----------------------------------------------------------------------

/// Deriva la shared_secret (32 byte) dal mio SecretKey Iroh + la peer_key
/// (PublicKey base32) dell'altro peer.
///
/// Comportamento:
///  1. Legge il mio SecretKey da `sync_identity` (singleton row id=1).
///  2. Parsa `their_peer_key` (stringa base32) in `iroh_base::key::PublicKey`.
///  3. Converte entrambi in tipi curve25519-dalek (`Scalar` + `MontgomeryPoint`).
///  4. Calcola `shared_secret = my_scalar * their_point` (X25519 ECDH).
///  5. Hasha con SHA-256 per derivare la AES-256 key (defense-in-depth,
///     anche se X25519 output è già 32 byte).
///  6. Ritorna 32 byte.
///
/// Proprietà ECDH: `my_scalar * their_point == their_scalar * my_point`.
/// Quindi sia A che B derivano la STESSA shared_secret senza mai
/// trasmetterla.
pub fn derive_shared_secret_inner(
    conn: &rusqlite::Connection,
    their_peer_key: &str,
) -> AppResult<Vec<u8>> {
    // 1. Carica il mio SecretKey da sync_identity (32 byte raw).
    let my_secret_bytes: Vec<u8> = conn
        .query_row(
            "SELECT secret_key_bytes FROM sync_identity WHERE id = 1 LIMIT 1",
            [],
            |r| r.get::<_, Vec<u8>>(0),
        )
        .map_err(|e| {
            AppError::Generic(format!(
                "sync_identity.secret_key_bytes non trovato (iroh_start_node chiamato?): {}",
                e
            ))
        })?;
    if my_secret_bytes.len() != 32 {
        return Err(AppError::Generic(format!(
            "SecretKey bytes len {} != 32 (corrotto?).",
            my_secret_bytes.len()
        )));
    }
    let mut sk_arr = [0u8; 32];
    sk_arr.copy_from_slice(&my_secret_bytes);

    // 2. Parsa their_peer_key (stringa base32 Iroh) in PublicKey, poi
    //    estrai i 32 byte raw X25519.
    let their_public: iroh_base::key::PublicKey = their_peer_key
        .parse()
        .map_err(|e| AppError::Validation(format!("peer key non valida: {}", e)))?;
    let their_public_bytes = *their_public.as_bytes();

    // 3. curve25519-dalek ECDH.
    //    - `Scalar::from_bytes_mod_order` converte 32 byte in uno Scalar
    //      X25519 (riduce mod ordine del sottogruppo).
    //    - `MontgomeryPoint(bytes)` wrap i 32 byte del punto pubblico.
    //    - La moltiplicazione `scalar * point` ritorna un MontgomeryPoint
    //      (il risultato ECDH, 32 byte).
    let my_scalar = Scalar::from_bytes_mod_order(sk_arr);
    let their_point = MontgomeryPoint(their_public_bytes);
    let shared_point = (my_scalar * their_point).0; // [u8; 32]

    // 4. SHA-256 sul risultato ECDH per derivare la AES-256 key.
    //    (Defense-in-depth: X25519 output ha proprietà matematiche strane
    //    in alcuni casi limite; SHA-256 le appiattisce in uniform-random 32 byte.)
    let mut hasher = Sha256::new();
    hasher.update(b"dossierfanta-m3a4-ecdh-v1");
    hasher.update(&shared_point);
    let shared_secret = hasher.finalize(); // GenericArray<u8, U32>

    Ok(shared_secret.to_vec())
}

/// Deriva il `room_name` dalla shared_secret (32 byte).
///
/// Formato: `df-sync-<hex(sha256(shared_secret))[:16]>` (16 char hex = 64 bit).
///
/// Deterministico: stessa shared_secret → stesso room_name. Entrambi i peer
/// (A e B) derivano lo stesso room_name senza doverlo trasmettere.
pub fn derive_room_name_inner(shared_secret: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"dossierfanta-m3a4-room-v1");
    hasher.update(shared_secret);
    let hash = hasher.finalize();
    // Prendi i primi 8 byte (16 char hex) — 64 bit di entropia.
    let prefix_bytes = &hash[..8];
    let prefix_hex = hex::encode(prefix_bytes);
    format!("df-sync-{}", prefix_hex)
}

// ----------------------------------------------------------------------
// AES-256-GCM
// ----------------------------------------------------------------------

/// Cifra `plaintext` con AES-256-GCM usando `shared_secret` (32 byte).
///
/// Output format: `[nonce(12) || ciphertext(N) || tag(16)]`
/// - nonce: 12 byte random (OsRng). Generato nuovo per ogni chiamata.
/// - ciphertext: stesso lunghezza del plaintext (AES-GCM è stream cipher).
/// - tag: 16 byte di autenticazione (GCM MAC). Verificato su decrypt.
///
/// Nonce NON viene riutilizzato: ogni chiamata genera un nonce nuovo.
/// AES-GCM con nonce casuale 12-byte è sicuro fino a ~2^32 messaggi
/// con la stessa key (collisione nonce probabilità ~2^-32).
pub fn encrypt_update_inner(
    plaintext: &[u8],
    shared_secret: &[u8],
) -> AppResult<Vec<u8>> {
    if shared_secret.len() != 32 {
        return Err(AppError::Validation(format!(
            "shared_secret len {} != 32",
            shared_secret.len()
        )));
    }
    let mut key_arr = [0u8; 32];
    key_arr.copy_from_slice(shared_secret);
    let key = Key::<Aes256Gcm>::from_slice(&key_arr);
    let cipher = Aes256Gcm::new(key);

    // 12-byte random nonce (AES-GCM standard nonce size).
    let mut nonce_arr = [0u8; 12];
    AesOsRng.fill_bytes(&mut nonce_arr);
    let nonce = Nonce::from_slice(&nonce_arr);

    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| AppError::Generic(format!("AES-GCM encrypt: {}", e)))?;

    // Output: nonce || ciphertext (ciphertext include già il tag di 16 byte)
    let mut output = Vec::with_capacity(12 + ciphertext.len());
    output.extend_from_slice(&nonce_arr);
    output.extend_from_slice(&ciphertext);
    Ok(output)
}

/// Decifra `ciphertext` (formato `[nonce(12) || ciphertext(N) || tag(16)]`)
/// con AES-256-GCM usando `shared_secret` (32 byte).
///
/// Ritorna `AppResult<Vec<u8>>` (plaintext) se il tag è valido.
/// Ritorna `Err` se il tag è invalido (ciphertext manipolato, wrong key,
/// nonce sbagliato, ecc.).
pub fn decrypt_update_inner(
    ciphertext: &[u8],
    shared_secret: &[u8],
) -> AppResult<Vec<u8>> {
    if shared_secret.len() != 32 {
        return Err(AppError::Validation(format!(
            "shared_secret len {} != 32",
            shared_secret.len()
        )));
    }
    // Formato: 12-byte nonce + ciphertext (che include il 16-byte GCM tag).
    // AES-GCM tag è di 16 byte (default per aes-gcm crate). Minimo ciphertext
    // size = 16 (solo tag, no plaintext). Quindi input minimo = 12 + 16 = 28.
    if ciphertext.len() < 28 {
        return Err(AppError::Validation(format!(
            "ciphertext troppo corto (len {}, min 28 = 12 nonce + 16 tag)",
            ciphertext.len()
        )));
    }
    let nonce_arr = &ciphertext[..12];
    let ct_payload = &ciphertext[12..];

    let mut key_arr = [0u8; 32];
    key_arr.copy_from_slice(shared_secret);
    let key = Key::<Aes256Gcm>::from_slice(&key_arr);
    let cipher = Aes256Gcm::new(key);
    let nonce = Nonce::from_slice(nonce_arr);

    let plaintext = cipher
        .decrypt(nonce, ct_payload)
        .map_err(|e| AppError::Generic(format!("AES-GCM decrypt (tag fail o wrong key): {}", e)))?;
    Ok(plaintext)
}

// ----------------------------------------------------------------------
// 8-digit pairing code generation
// ----------------------------------------------------------------------

/// Genera un codice 8-cifre casuale (range 10000000..=99999999).
///
/// Spazio di ricerca: 10^8 = 100M combinazioni.
/// Con rate-limit 10 tentativi/IP/5min + 5-min TTL, brute-force ha ~0.016%
/// probabilità di successo per finestra.
pub fn generate_pairing_code_inner() -> String {
    let mut rng = rand::thread_rng();
    let code: u32 = rng.gen_range(10_000_000..=99_999_999);
    format!("{}", code)
}
