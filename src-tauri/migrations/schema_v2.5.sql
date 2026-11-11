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
-- M4 (v2.6) — Tag & Filtri: estensione additive di v2.5
-- ------------------------------------------------------------
-- Tre nuove tabelle, tutte CREATE TABLE IF NOT EXISTS (idempotenti).
-- Lo schema v2.2/v2.3/v2.4 e le tabelle sync_* di M3a.4/M3a.5 sono
-- INVARIATE. Queste tabelle sono create nello stesso file v2.5 per
-- evitare un bump di user_version (M3a.4/5 già fisserà user_version=5
-- al boot): la funzione `ensure_m4_tables` in db.rs le crea
-- incondizionatamente a fine `open_and_migrate`, così i DB esistenti
-- a v2.5 (che skippano il batch v2.5) le ricevono comunque.
-- ============================================================

-- ------------------------------------------------------------
-- Tabella: player_tags (NUOVA — M4)
-- Tag-timbro a testo libero associato a un giocatore.
-- Colore + rotazione sono derivati da hash(label) lato Rust/UI
-- (stesso testo = stesso colore = stessa rotazione).
-- Multipli per player. ON DELETE CASCADE dal player.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS player_tags (
  id            TEXT PRIMARY KEY,                     -- UUID v4
  player_id     TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,                        -- testo libero (es. "rigorista", "ex-Milan")
  color         TEXT,                                 -- HSL string derivata da hash(label), cache
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  created_by    TEXT NOT NULL DEFAULT 'me',           -- 'me' | 'sync-live'
  last_sync_at  TEXT,                                 -- ISO 8601, NULL se mai syncato
  sync_node_id  TEXT                                  -- Iroh NodeId del peer originatore (per sync-live)
);

CREATE INDEX IF NOT EXISTS idx_tags_player ON player_tags(player_id);
CREATE INDEX IF NOT EXISTS idx_tags_label  ON player_tags(label);

-- ------------------------------------------------------------
-- Tabella: player_filters (NUOVA — M4)
-- Filtri salvati con nome. criteria_json contiene:
--   {tags: ["rigorista","ex-Milan"], role: "A", status: "scoutato",
--    sort_by: "priority", sort_dir: "desc"}
-- Non è legata a un player specifico: è uno strumento della vista Rosa.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS player_filters (
  id            TEXT PRIMARY KEY,                     -- UUID v4
  name          TEXT NOT NULL,                        -- nome del filtro (es. "Asta attaccanti")
  criteria_json TEXT NOT NULL,                        -- JSON serializzato di ListFilters + tag
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------
-- Tabella: player_links (NUOVA — M4, ma POPOLATA solo in M4.5)
-- Link esterni per scheda giocatore: FBref, Sofascore, Understat,
-- Transfermarkt. Lo schema esiste in M4 (vincolo #21) ma NON viene
-- popolato in M4: l'auto-fetch link è M4.5 (scraper nel repo
-- dossier-fanta-data). L'utente può aggiungere link manuali
-- (manual_links_json) già in M4, ma la UI LINK tab arriva con M4.5.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS player_links (
  player_id           TEXT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  fbref_url           TEXT,
  sofascore_url       TEXT,
  understat_url       TEXT,
  transfermarkt_url   TEXT,
  manual_links_json   TEXT,                           -- JSON array di link utente
  fetched_at          TEXT,                           -- ISO 8601, NULL se mai fetchato (M4.5)
  last_sync_at        TEXT,
  sync_node_id        TEXT
);

-- ============================================================
-- FINE SCHEMA v2.5 (estensione additive di v2.4 + M4 tag/filtri)
-- ============================================================
