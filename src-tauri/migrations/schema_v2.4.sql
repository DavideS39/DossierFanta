-- ============================================================
-- DossierFanta v2.4 — Schema SQLite sync_identity (M3a.3)
-- ============================================================
-- Versione schema: 4 (v2.4 — estensione additive di v2.3)
-- Data: ottobre 2026
-- Base: schema_v2.3.sql (M3a, invariato)
--
-- M3a.3 Deliverable 3 — Peer key persistente (Iroh).
--
-- PROBLEMA: in M3a.1, `iroh_start_node` genera `SecretKey::generate()` ad
-- ogni riavvio. La peer_key cambia ogni volta → l'utente deve ri-scambiare
-- la peer_key con tutti i peer fidati ad ogni boot dell'app.
--
-- SOLUZIONE: persistere la SecretKey Iroh (32 byte) nella tabella
-- `sync_identity`. Al boot, `iroh_start_node` la carica se esiste, altrimenti
-- la genera e la salva. La peer_key (NodeId pubblico derivato) è quindi
-- stabile cross-boot.
--
-- Vincoli HARD (NON violare):
--  1. ALTER TABLE additive: solo aggiunta colonne con default NULL.
--     Per v2.4 NON ci sono ALTER — solo CREATE TABLE IF NOT EXISTS.
--  2. Schema v2.2 + v2.3 invariati (vincolo M3a.3 #16: solo ALTER additive
--     per sync_identity).
--  3. La tabella contiene SOLO la SecretKey Iroh (32 byte random) +
--     il NodeId derivato (stringa base32) + display_name opzionale.
--     Nessun dato sensibile dell'utente (niente email, niente auth).
--  4. La SecretKey è crittograficamente equivalente a una chiave privata
--     SSH: chiunque la possiede può impersonare il peer. Va protetta a
--     livello filesystem (permessi 0600 sul file .db). NON va mai inviata
--     in chiaro via sync — la peer_key pubblica va scambiata, la secret
--     key resta locale.
--
-- MIGRATION STRATEGY:
--  - Su DB nuovo (no tabella `players`): il file `schema_v2.2.sql` crea
--    tutte le tabelle v2.2. Poi v2.3 + v2.4 creano le estensioni sync.
--  - Su DB esistente (v2.3 applicato, user_version = 3): applica solo
--    CREATE TABLE IF NOT EXISTS sync_identity (idempotente), set
--    PRAGMA user_version = 4.
--  - Su DB con user_version >= 4: skip (già migrato).
--
-- Idempotente con IF NOT EXISTS — sicuro eseguire più volte.
-- ============================================================

-- ------------------------------------------------------------
-- Tabella: sync_identity (NUOVA — M3a.3)
-- Single-row table (id=1 fissa) che persiste la SecretKey Iroh locale.
--
-- Perché single-row: ogni PC ha UNA sola identità sync. Il campo `id=1`
-- è un singleton — l'app lo cerca sempre lì.
--
-- Perché NON in `databases` o `sync_peers`: la SecretKey è un dato
-- di identità del NODO Iroh, non di un singolo DB. Condivide il
-- ciclo di vita dell'app, non del DB.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_identity (
  id              INTEGER PRIMARY KEY DEFAULT 1,  -- singleton (sempre 1)
  secret_key_bytes BLOB NOT NULL,                  -- 32 byte SecretKey Iroh
  peer_key        TEXT NOT NULL,                   -- NodeId base32 derivato
  display_name    TEXT,                             -- nome umano opzionale
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- FINE SCHEMA v2.4 (estensione additive di v2.3)
-- ============================================================
