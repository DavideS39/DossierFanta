-- ============================================================
-- DossierFanta v2.5 — M3a.3 Supabase Setup SQL
-- ============================================================
-- Eseguire una tantum sul proprio progetto Supabase:
--   1. https://supabase.com/dashboard → seleziona progetto
--      (es. https://liwfffxhokbvzyzhivzc.supabase.co)
--   2. Sidebar sinistra → "SQL Editor" → "New query"
--   3. Incolla questo file → "Run"
--   4. Verifica: deve apparire la tabella `yjs_updates` in
--      "Table Editor" → "public" → "yjs_updates"
--
-- Tempo stimato: 30 secondi.
-- Costo: 0€ (free tier Supabase basta per due peer).
--
-- Vincoli HARD (vedi syncConfig.ts):
--   #18: Supabase NON è authoritativo. SQLite locale è source of truth.
--   #19: URL + anonKey sono hardcoded nel frontend (syncConfig.ts),
--        non sono dati sensibili (chiave publishable).
--   #20: Tabella yjs_updates contiene SOLO bytes binari Yjs (CRDT diffs).
--        Nessun dato sensibile, decodificabile solo con il Y.Doc locale.
-- ============================================================

-- ------------------------------------------------------------
-- Tabella: yjs_updates
-- Una sola tabella per tutti i DB condivisi (colonna `room_name` separa
-- logicamente le stanze). Per M3a.3 un solo room_name globale
-- `dossierfanta-sync`, ma lo schema supporta già N stanze.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS yjs_updates (
  id          BIGSERIAL PRIMARY KEY,
  room_name   TEXT NOT NULL DEFAULT 'dossierfanta-sync',
  update_bytes BYTEA NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indice per query syncFromOffline (SELECT ... WHERE room_name = ? AND id > ? ORDER BY id)
CREATE INDEX IF NOT EXISTS idx_yjs_updates_room
  ON yjs_updates (room_name, id);

-- Indice secondario per cleanup (DELETE WHERE created_at < ?)
CREATE INDEX IF NOT EXISTS idx_yjs_updates_created_at
  ON yjs_updates (created_at);

-- ------------------------------------------------------------
-- Row Level Security (RLS)
-- La tabella è accessibile solo con la chiave `anon` pubblica, ma le
-- policies limitano cosa l'anon può fare:
--   - SELECT: chiunque (anon) può leggere (sync offline)
--   - INSERT: chiunque (anon) può inserire (broadcast persist)
--   - DELETE: chiunque (anon) può fare cleanup (solo record vecchi)
--
-- Per M3a.3 due peer fidati, va bene. Per produzione multi-tenant,
-- aggiungere auth.users JOIN e policy con `auth.uid() = ...`.
-- ------------------------------------------------------------

ALTER TABLE yjs_updates ENABLE ROW LEVEL SECURITY;

-- Policy: anon può leggere (syncFromOffline)
CREATE POLICY "anon_select_yjs_updates"
  ON yjs_updates
  FOR SELECT
  TO anon
  USING (true);

-- Policy: anon può inserire (persist update)
CREATE POLICY "anon_insert_yjs_updates"
  ON yjs_updates
  FOR INSERT
  TO anon
  WITH CHECK (true);

-- Policy: anon può fare cleanup (DELETE record vecchi — protetto da
-- `created_at < NOW() - INTERVAL '7 days'` per evitare DELETE arbitrari)
CREATE POLICY "anon_delete_old_yjs_updates"
  ON yjs_updates
  FOR DELETE
  TO anon
  USING (created_at < NOW() - INTERVAL '7 days');

-- ------------------------------------------------------------
-- Realtime: abilita la pubblicazione della tabella sul canale Realtime
-- (necessario per il broadcast live via WebSocket).
--
-- NOTA: per il sync M3a.3 usiamo BROADCAST (canale custom, non table
-- changes), quindi questa abilitazione è OPZIONALE. Attiviamola comunque
-- per future estensioni (es. cursori realtime via table).
-- ------------------------------------------------------------

ALTER PUBLICATION supabase_realtime ADD TABLE yjs_updates;

-- ------------------------------------------------------------
-- Tabella: pairings (NUOVA — M3a.5 — rendezvous per pairing 8-cifre)
-- Rendezvous point temporaneo per il pairing flow. Un row per codice
-- 8-cifre generato dall'initiator. Il responder lo legge per ottenere
-- la peer_key dell'initiator. Cleanup automatico dopo 5 min.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pairings (
  code            TEXT PRIMARY KEY,         -- 8 cifre "12345678"
  peer_key_initiator TEXT NOT NULL,         -- NodeId Iroh base32 dell'initiator
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pairings_created_at ON pairings(created_at);

ALTER TABLE pairings ENABLE ROW LEVEL SECURITY;

-- RLS: anon può INSERT (creare codice), SELECT (leggere per join),
-- DELETE (dopo successo o scadenza). Il codice 8-cifre è public
-- rendezvous, non contiene materiale crittografico.
CREATE POLICY "anon_pairings_all" ON pairings
  FOR ALL TO anon USING (true) WITH CHECK (true);

-- ============================================================
-- Verifica (eseguire dopo il setup per testare):
-- ============================================================
-- INSERT INTO yjs_updates (room_name, update_bytes)
--   VALUES ('dossierfanta-sync', E'\\x01020304');
-- SELECT id, room_name, update_bytes, created_at FROM yjs_updates;
-- DELETE FROM yjs_updates WHERE created_at < NOW() - INTERVAL '30 days';
--
-- Pairing test:
-- INSERT INTO pairings (code, peer_key_initiator)
--   VALUES ('12345678', 'test-peer-key-abc');
-- SELECT * FROM pairings WHERE code = '12345678';
-- DELETE FROM pairings WHERE code = '12345678';
-- ============================================================
-- FINE SETUP SQL — DossierFanta M3a.4 + M3a.5
-- ============================================================
