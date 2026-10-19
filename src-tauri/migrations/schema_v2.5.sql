-- ============================================================
-- DossierFanta v2.5 — Schema SQLite sync_pairings (M3a.4 + M3a.5)
-- ============================================================
-- Versione schema: 5 (v2.5 — estensione additive di v2.4)
-- Data: ottobre 2026
-- Base: schema_v2.4.sql (M3a.3, invariato)
--
-- M3a.4 + M3a.5 — Pairing tramite codice 8-cifre + ECDH X25519 + AES-GCM.
--
-- PROBLEMA risolto: in M3a.3 la tabella yjs_updates su Supabase era
-- globale (un solo room_name 'dossierfanta-sync' per tutti). Qualsiasi
-- utente con l'app installata (stesso URL+anonKey hardcoded) poteva
-- leggere TUTTI gli update di TUTTI i pairing via SELECT *.
--
-- SOLUZIONE: per-pairing encryption. Ogni pairing (A-B) deriva una
-- shared_secret via ECDH X25519 (my_iroh_secret * their_peer_key) —
-- mai trasmessa. La room_name è derivata dalla shared_secret
-- (unguessable senza entrambe le chiavi private). Tutti i bytes
-- Yjs broadcast/persistiti sono cifrati AES-256-GCM con la
-- shared_secret del pairing.
--
-- Tabella `sync_pairings` (NUOVA — M3a.4):
--   - Persiste la shared_secret di ogni pairing (32 byte)
--   - Persiste la room_name derivata (per SELECT su yjs_updates)
--   - Persiste display_name opzionale (es. "Giorgio")
--
-- Tabella `sync_pairings_pending` (NUOVA — M3a.5):
--   - Tracking locale dei codici 8-cifre IN CORSO (initiator side)
--   - Permette resume dopo crash dell'app: se l'app crasha mentre
--     aspetta risposta del responder, al riavvio può cancellare
--     o ritentare il pairing
--   - NOTA: la fonte di verità è la tabella Supabase `pairings`
--     (vedi docs/supabase-setup-m3a4.sql). Questa tabella locale
--     è solo per state tracking dell'initiator.
--
-- Vincoli HARD (NON violare):
--  1. ALTER TABLE additive: solo aggiunta colonne con default NULL.
--     Per v2.5 NON ci sono ALTER — solo CREATE TABLE IF NOT EXISTS.
--  2. Schema v2.2 + v2.3 + v2.4 invariati (vincolo M3a.3 #16 esteso).
--  3. La tabella sync_pairings contiene la shared_secret (32 byte) —
--     crittograficamente equivalente a una chiave privata. Va protetta
--     a livello filesystem (permessi 0600 sul file .db). NON va mai
--     inviata in chiaro — vive solo localmente.
--  4. sync_pairings_pending NON contiene shared_secret (solo codici
--     in corso, che sono public rendezvous points).
--
-- MIGRATION STRATEGY:
--  - Su DB nuovo: schema_v2.2 + v2.3 + v2.4 + v2.5 applicati in sequenza.
--  - Su DB esistente v2.4 (user_version = 4): applica solo CREATE TABLE
--    IF NOT EXISTS (idempotente), set PRAGMA user_version = 5.
--  - Su DB con user_version >= 5: skip.
-- ============================================================

-- ------------------------------------------------------------
-- Tabella: sync_pairings (NUOVA — M3a.4)
-- Un row per ogni peer pairato. La shared_secret + room_name
-- consentono al SupabaseYjsProvider di cifrare/decifrare gli
-- update Yjs scambiati con quel peer.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_pairings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  -- NodeId Iroh (base32) del peer pairato. UNIQUE — un solo pairing per peer.
  peer_key_other  TEXT NOT NULL UNIQUE,
  -- 32 byte chiave ECDH X25519 derivata da (my_SecretKey * their_PublicKey).
  -- Mai trasmessa in chiaro. Usata come AES-256 key.
  shared_secret   BLOB NOT NULL,
  -- "df-sync-<hex(sha256(shared_secret))[:16]>" — derivata deterministicamente.
  -- Usata come room_name per SELECT da yjs_updates + per nome canale Realtime.
  room_name       TEXT NOT NULL,
  -- Nome umano opzionale (es. "Giorgio", "Luca").
  display_name    TEXT,
  -- ISO 8601 primo pairing.
  paired_at       TEXT NOT NULL DEFAULT (datetime('now')),
  -- ISO 8601 ultimo sync/heartbeat. Aggiornato su ogni sync-update-received.
  last_seen       TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_pairings_room ON sync_pairings(room_name);
CREATE INDEX IF NOT EXISTS idx_sync_pairings_peer ON sync_pairings(peer_key_other);

-- ------------------------------------------------------------
-- Tabella: sync_pairings_pending (NUOVA — M3a.5)
-- Codici 8-cifre in corso di pairing (initiator side).
-- Un row per ogni codice generato da questo PC che è ancora in
-- attesa di risposta dal responder.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_pairings_pending (
  code            TEXT PRIMARY KEY,         -- 8 cifre "12345678"
  peer_key_initiator TEXT NOT NULL,         -- mio NodeId (per resume/cleanup)
  -- ISO 8601 generazione codice. Scade 5 min dopo (cleanup async).
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (length(code) = 8 AND code GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]')
);

CREATE INDEX IF NOT EXISTS idx_sync_pairings_pending_created ON sync_pairings_pending(created_at);

-- ============================================================
-- FINE SCHEMA v2.5 (estensione additive di v2.4)
-- ============================================================
