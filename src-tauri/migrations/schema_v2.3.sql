-- ============================================================
-- DossierFanta v2.3 — Schema SQLite sync-live (M3a)
-- ============================================================
-- Versione schema: 3 (v2.3 — estensione additive di v2.2)
-- Data: ottobre 2026
-- Base: schema_v2.2.sql (M2, invariato)
--
-- Vincoli HARD (NON violare):
--  1. ALTER TABLE additive: solo aggiunta colonne con default NULL.
--     Niente DROP, niente RENAME, niente type change.
--  2. Il CHECK constraint su `updated_by` NON viene toccato (SQLite non
--     supporta ALTER CHECK senza ricreare la tabella — troppo invasivo).
--     La validazione del nuovo valore 'sync-live' avviene solo lato Rust
--     nei comandi save_*_from_sync (vedi B.8).
--  3. La tabella `players_archive` non viene estesa: i campi sync sono
--     solo per tabelle "live" (players, scouting_notes, auction_data).
--     I giocatori archiviati sono storici e non hanno sync.
--
-- MIGRATION STRATEGY:
--  - Su DB nuovo (no tabella `players`): il file `schema_v2.2.sql` crea
--    tutte le tabelle v2.2. Questo file poi aggiunge i campi sync.
--  - Su DB esistente (tabella `players` presente, user_version < 3):
--    applica gli ALTER additive + CREATE TABLE sync_peers, set
--    PRAGMA user_version = 3.
--  - Su DB con user_version >= 3: skip (già migrato).
--
-- Gli ALTER sono implementati in Rust (db.rs::migrate_v22_to_v23) perché
-- SQLite non ha ALTER ... IF NOT EXISTS e il file SQL puro non è
-- idempotente. Questo file contiene SOLO la CREATE TABLE sync_peers
-- (idempotente con IF NOT EXISTS) + documentazione di riferimento.
-- ============================================================

-- ------------------------------------------------------------
-- Tabella: sync_peers (NUOVA — M3a)
-- Peer Iroh connessi per il sync live CRDT.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_peers (
  peer_id      TEXT PRIMARY KEY,    -- Iroh node ID (base32 string)
  display_name TEXT,                -- nome umano opzionale (es. "marco")
  paired_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen    TEXT,                 -- ISO 8601 ultimo heartbeat
  trusted      INTEGER NOT NULL DEFAULT 0  -- 0/1, trusted per auto-accept
);

CREATE INDEX IF NOT EXISTS idx_sync_peers_last_seen ON sync_peers(last_seen);

-- ============================================================
-- RIFERIMENTO: ALTER additive applicati da Rust (db.rs)
-- ============================================================
-- ALTER TABLE players ADD COLUMN last_sync_at TEXT;
-- ALTER TABLE players ADD COLUMN sync_node_id TEXT;
-- ALTER TABLE scouting_notes ADD COLUMN last_sync_at TEXT;
-- ALTER TABLE scouting_notes ADD COLUMN sync_node_id TEXT;
-- ALTER TABLE auction_data ADD COLUMN last_sync_at TEXT;
-- ALTER TABLE auction_data ADD COLUMN sync_node_id TEXT;
--
-- Tutte le nuove colonne sono TEXT con default NULL:
--  - last_sync_at: ISO 8601 ultimo update CRDT ricevuto dal sync
--  - sync_node_id: Iroh node ID del peer che ha originato l'update
-- ============================================================
-- FINE SCHEMA v2.3 (estensione additive di v2.2)
-- ============================================================
