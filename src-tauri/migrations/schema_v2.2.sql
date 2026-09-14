-- ============================================================
-- DossierFanta v2.2 — Schema SQLite locale
-- ============================================================
-- Versione schema: 3 (v2.2)
-- Data: settembre 2026
-- Target: SQLite 3.40+ con mode WAL
-- Bridge: tauri-plugin-sql
--
-- Note vincoli hard (NON violare):
--  1. Niente cancellazioni automatiche di giocatori — solo esplicita con conferma
--  2. Giocatori non più in Serie A → archiviati in players_archive (NON flag)
--  3. Terminologia valuta disambiguata:
--     - fmil_*  = Fantamilioni (f₥, Unicode U+20A5) — valuta della lega
--     - med     = Med (M) — media voto pura senza bonus, range 0-10
--     - medv    = MedV (MV) — FantaMedia con bonus/malus, range 0-10
--     - fvm     = FVM — FantaValoreMedio da listone auto-fetch
-- ============================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------
-- Tabella: databases
-- Metadati dei database locali (multi-DB workspace)
-- ------------------------------------------------------------
CREATE TABLE databases (
  id          TEXT PRIMARY KEY,                     -- UUID v4
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('personal', 'shared', 'listone')),
  owner       TEXT,                                 -- 'me' | 'marco' | 'auto-fetch' | NULL
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  last_sync   TEXT,                                 -- ISO 8601, NULL se mai syncato
  schema_ver  INTEGER NOT NULL DEFAULT 3
);

-- ------------------------------------------------------------
-- Tabella: players
-- Giocatori attivi (in Serie A). Stato scouting esplicito.
-- ------------------------------------------------------------
CREATE TABLE players (
  id           TEXT PRIMARY KEY,                    -- UUID, stabile nel tempo
  db_id        TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  team         TEXT,                                -- nome squadra reale Serie A
  pos_fanta    TEXT CHECK (pos_fanta IN ('P', 'D', 'C', 'A')),
  pos_real     TEXT,                                -- testo libero, autocomplete UI
  status       TEXT NOT NULL DEFAULT 'totali'
               CHECK (status IN ('totali', 'scoutato', 'da_fare')),
  fascia       TEXT CHECK (fascia IN ('Top', 'Semitop', 'Medio', 'Regolarista', 'Scommessa')),
  priority     INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 5),

  -- Valuta disambiguata (v2.2)
  fmil_spesi   INTEGER,                             -- f₥ Fantamilioni spesi all'asta (storico)
  med          REAL CHECK (med BETWEEN 0 AND 10),   -- M  media voto pura (senza bonus)
  medv         REAL CHECK (medv BETWEEN 0 AND 10),  -- MV FantaMedia (con bonus/malus)
  fvm          INTEGER,                             -- FVM FantaValoreMedio (da listone auto-fetch)

  custom_data  TEXT,                                -- JSON per campi liberi + arricchimento
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by   TEXT,                                -- 'me' | 'marco' | 'auto-fetch'
  source_hash  TEXT                                 -- per staleness AI summary
);

CREATE INDEX idx_players_db       ON players(db_id);
CREATE INDEX idx_players_status   ON players(db_id, status);
CREATE INDEX idx_players_role     ON players(db_id, pos_fanta);
CREATE INDEX idx_players_fascia   ON players(db_id, fascia);
CREATE INDEX idx_players_name     ON players(db_id, name COLLATE NOCASE);

-- ------------------------------------------------------------
-- Tabella: players_archive
-- Giocatori non più in Serie A. Nascosti dalla vista principale.
-- Recuperabili via search "includi archivio".
-- NON distruttiva: se il giocatore torna in Serie A, viene ripristinato.
-- ------------------------------------------------------------
CREATE TABLE players_archive (
  id              TEXT PRIMARY KEY,
  db_id           TEXT NOT NULL,
  name            TEXT NOT NULL,
  team            TEXT,
  pos_fanta       TEXT,
  pos_real        TEXT,
  archived_at     TEXT NOT NULL DEFAULT (datetime('now')),
  archived_reason TEXT NOT NULL CHECK (archived_reason IN (
                  'trasferito_estero', 'ritirato', 'serie_b',
                  'non_in_listone', 'migrate_v1')),
  last_known_data TEXT,                             -- snapshot JSON al momento archiviazione
  source_db_id    TEXT                              -- da dove è stato spostato
);

CREATE INDEX idx_archive_db    ON players_archive(db_id);
CREATE INDEX idx_archive_name  ON players_archive(db_id, name COLLATE NOCASE);

-- ------------------------------------------------------------
-- Tabella: scouting_notes
-- Note/dati/link di scouting per giocatore. Multipli per player.
-- kind: 'data' (numero/testo con fonte) | 'link' (URL esterno) | 'note' (texto libero)
-- ------------------------------------------------------------
CREATE TABLE scouting_notes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id    TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('data', 'link', 'note')),
  label        TEXT,                                -- es. "xG 2025/26", "SofaScore"
  content      TEXT,                                -- valore, URL, o testo libero
  source       TEXT,                                -- 'fbref' | 'understat' | 'sofascore' | 'manual'
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_notes_player ON scouting_notes(player_id);

-- ------------------------------------------------------------
-- Tabella: auction_data
-- Campi dedicati all'asta, 1 riga per giocatore (1:1 con players).
-- Pensati per consultazione rapida durante la chiamata.
-- ------------------------------------------------------------
CREATE TABLE auction_data (
  player_id    TEXT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  titolarita   INTEGER CHECK (titolarita BETWEEN 1 AND 10),
  infortuni    TEXT CHECK (infortuni IN ('nessuno', 'lieve', 'grave')),
  quick_note   TEXT,                                -- 1-2 righe, per asta live
  fmil_max     INTEGER,                             -- f₥ budget max all'asta
  assigned_to  TEXT,                                -- team lega, NULL se non assegnato
  fmil_paid    INTEGER,                             -- f₥ prezzo di assegnazione effettivo
  assigned_at  TEXT                                 -- timestamp assegnazione
);

-- ------------------------------------------------------------
-- Tabella: roster_plans
-- Piano Rosa v3: 1 piano per reparto, slot con target.
-- slots_json contiene la struttura completa (vedi design doc Cap.13).
-- ------------------------------------------------------------
CREATE TABLE roster_plans (
  id           TEXT PRIMARY KEY,
  db_id        TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  name         TEXT,
  reparto      TEXT CHECK (reparto IN ('P', 'D', 'C', 'A') OR reparto IS NULL),
  slots_json   TEXT NOT NULL,                       -- array di slot con forks/target
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_plans_db ON roster_plans(db_id);

-- ------------------------------------------------------------
-- Tabella: modificatore_presets
-- Preset modificatore difesa: 3/6/8 fasce + custom
-- fasce_json: array di {min, max, bonus}
-- ------------------------------------------------------------
CREATE TABLE modificatore_presets (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  fasce_json   TEXT NOT NULL,
  is_default   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Preset preinstallati (inseriti al primo avvio dell'app)
INSERT INTO modificatore_presets (id, name, fasce_json, is_default) VALUES
('preset-3fasce', '3 fasce (classico)',
 '[{"min":6.00,"max":6.50,"bonus":1},{"min":6.50,"max":7.00,"bonus":3},{"min":7.00,"max":null,"bonus":6}]',
 1),
('preset-6fasce', '6 fasce (granulare)',
 '[{"min":6.00,"max":6.25,"bonus":1},{"min":6.25,"max":6.50,"bonus":2},{"min":6.50,"max":6.75,"bonus":3},{"min":6.75,"max":7.00,"bonus":4},{"min":7.00,"max":7.25,"bonus":5},{"min":7.25,"max":null,"bonus":6}]',
 0),
('preset-8fasce-custom-v1', '8 fasce custom (v1 legacy)',
 '[{"min":0,"max":6.00,"bonus":0},{"min":6.00,"max":6.25,"bonus":1},{"min":6.25,"max":6.50,"bonus":2},{"min":6.50,"max":6.75,"bonus":3},{"min":6.75,"max":7.00,"bonus":4},{"min":7.00,"max":7.25,"bonus":5},{"min":7.25,"max":7.50,"bonus":5},{"min":7.50,"max":null,"bonus":6}]',
 0);

-- ------------------------------------------------------------
-- Tabella: oracolo_projections
-- Proiezioni Oracolo v2. 1 riga per giocatore.
-- Modulare: components_json contiene il breakdown pesi per spiegabilità.
-- ------------------------------------------------------------
CREATE TABLE oracolo_projections (
  player_id        TEXT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  fmil_atteso      REAL,                            -- output modulare in f₥
  confidence       REAL CHECK (confidence BETWEEN 0 AND 1),
  components_json  TEXT,                            -- breakdown pesi per spiegabilità
  human_override   REAL,                            -- se utente corregge, in f₥
  verdict          TEXT CHECK (verdict IN (
                   'up_strong', 'up', 'flat', 'down', 'down_strong', 'unknown')),
  computed_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------
-- Tabella: pressione_mercato
-- PM v2 — rimpiazza Temperatura v1.
-- PM_esterna: prezzo medio reale aste pubbliche (TO-DO fonte M6, può essere NULL)
-- PM_locale:  ratio fmil_paid / pm_esterna, calcolato dopo assegnazione
-- ------------------------------------------------------------
CREATE TABLE pressione_mercato (
  player_id    TEXT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  pm_esterna   INTEGER,                             -- f₥ prezzo medio aste pubbliche
  pm_locale    REAL,                                -- ratio fmil_paid / pm_esterna
  pm_source    TEXT,                                -- identificatore fonte dati esterna
  pm_updated   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------
-- Tabella: sync_log
-- Log dei sync effettuati (per audit e debug).
-- ------------------------------------------------------------
CREATE TABLE sync_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  db_id        TEXT NOT NULL,
  peer_db_id   TEXT,
  via          TEXT NOT NULL CHECK (via IN ('iroh', 'wifi_lan', 'bt_ble', 'bt_classic', 'file')),
  started_at   TEXT,
  finished_at  TEXT,
  records_tx   INTEGER,
  records_rx   INTEGER,
  status       TEXT CHECK (status IN ('ok', 'conflict', 'error', 'partial'))
);

CREATE INDEX idx_synclog_db ON sync_log(db_id, started_at);

-- ============================================================
-- Trigger: aggiornamento updated_at automatico
-- ============================================================
CREATE TRIGGER trg_players_updated_at
AFTER UPDATE ON players
FOR EACH ROW
BEGIN
  UPDATE players SET updated_at = datetime('now') WHERE id = OLD.id;
END;

CREATE TRIGGER trg_roster_plans_updated_at
AFTER UPDATE ON roster_plans
FOR EACH ROW
BEGIN
  UPDATE roster_plans SET updated_at = datetime('now') WHERE id = OLD.id;
END;

-- ============================================================
-- Vista: v_players_full (opzionale, per query UI)
-- Join player + auction_data + oracolo + pressione_mercato
-- ============================================================
CREATE VIEW v_players_full AS
SELECT
  p.id, p.db_id, p.name, p.team, p.pos_fanta, p.pos_real, p.status,
  p.fascia, p.priority,
  p.fmil_spesi, p.med, p.medv, p.fvm,
  p.updated_at, p.updated_by,
  a.titolarita, a.infortuni, a.quick_note, a.fmil_max,
  a.assigned_to, a.fmil_paid, a.assigned_at,
  o.fmil_atteso, o.confidence, o.verdict AS oracolo_verdict,
  pm.pm_esterna, pm.pm_locale
FROM players p
LEFT JOIN auction_data a        ON a.player_id = p.id
LEFT JOIN oracolo_projections o ON o.player_id = p.id
LEFT JOIN pressione_mercato pm  ON pm.player_id = p.id;

-- ============================================================
-- Inizializzazione: database di default "mio.db"
-- L'app crea questo database al primo avvio.
-- ============================================================
INSERT INTO databases (id, name, type, owner) VALUES
('default-personal', 'mio.db', 'personal', 'me');

-- ============================================================
-- FINE SCHEMA v2.2
-- ============================================================
