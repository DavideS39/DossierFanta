// Tipi TypeScript mirror dei tipi Rust in src-tauri/src/commands/.
// MANTENERE SINCRONIZZATO con le struct Rust: ogni campo qui deve esistere là.
//
// M2 aggiunge:
// - DatabaseMeta, ListFilters.db_id, CreatePlayerInput.db_id + status
// - ListoneEntry, ImportSummary, ArchivedPlayer (per commands/listone.rs)

export type PosFanta = "P" | "D" | "C" | "A";
export type Fascia = "Top" | "Semitop" | "Medio" | "Regolarista" | "Scommessa";
export type Status = "totali" | "scoutato" | "da_fare";

export const POS_FANTA_VALUES: PosFanta[] = ["P", "D", "C", "A"];
export const FASCIA_VALUES: Fascia[] = [
  "Top",
  "Semitop",
  "Medio",
  "Regolarista",
  "Scommessa",
];
export const STATUS_VALUES: Status[] = ["totali", "scoutato", "da_fare"];

/** Label umane per i ruoli fantacalcio. */
export const POS_FANTA_LABELS: Record<PosFanta, string> = {
  P: "Portiere",
  D: "Difensore",
  C: "Centrocampista",
  A: "Attaccante",
};

/** Tipi di database (M2). */
export type DatabaseType = "personal" | "shared" | "listone";

export const DATABASE_TYPE_LABELS: Record<DatabaseType, string> = {
  personal: "Personale",
  shared: "Condiviso",
  listone: "Listone (read-only)",
};

/**
 * Rappresentazione completa di un giocatore restituita dal backend Rust.
 * I campi nullable sono `T | null` per rispecchiare `Option<T>` di Rust.
 */
export interface Player {
  id: string;
  db_id: string;
  name: string;
  team: string | null;
  pos_fanta: PosFanta | null;
  pos_real: string | null;
  status: Status;
  fascia: Fascia | null;
  priority: number;
  fmil_spesi: number | null; // f₥ Fantamilioni spesi
  med: number | null; // M Med (media voto pura, 0-10)
  medv: number | null; // MV MedV (FantaMedia con bonus/malus, 0-10)
  fvm: number | null; // FVM FantaValoreMedio (da listone)
  updated_at: string | null;
  updated_by: string | null;
}

/** Payload per creare un nuovo giocatore. I campi opzionali sono `T | null`. */
export interface CreatePlayerInput {
  db_id?: string | null; // M2: esplicito, None → active_db_id
  name: string;
  team: string | null;
  pos_fanta: PosFanta | null;
  pos_real: string | null;
  status?: Status | null; // M2: permette di creare con status='da_fare' dal listone
  fascia: Fascia | null;
  priority?: number;
  fmil_spesi: number | null;
  med: number | null;
  medv: number | null;
  fvm: number | null;
}

/** Payload per aggiornare un giocatore (full replace). */
export interface UpdatePlayerInput {
  id: string;
  name: string;
  team: string | null;
  pos_fanta: PosFanta | null;
  pos_real: string | null;
  fascia: Fascia | null;
  priority: number;
  fmil_spesi: number | null;
  med: number | null;
  medv: number | null;
  fvm: number | null;
}

/** Filtri per list_players. Tutti opzionali. */
export interface ListFilters {
  search?: string | null;
  pos_fanta?: PosFanta | null;
  status?: Status | null;
  fascia?: Fascia | null;
  db_id?: string | null; // M2: None → active, "all" → tutti i DB
  include_archive?: boolean | null; // M2: se true, include archived
  limit?: number | null;
  offset?: number | null;
}

/** Metadati DB restituiti da get_db_info (M1 + M2 extension). */
export interface DbInfo {
  db_path: string;
  schema_version: number;
  players_count: number;
  archived_count: number;
  default_db_id: string;
  default_db_name: string;
  databases_count: number; // M2
  active_db_id: string; // M2
  active_db_name: string; // M2
}

// ----------------------------------------------------------------------
// M2 — multi-DB workspace
// ----------------------------------------------------------------------

/** Metadati di un DB logico (riga di `databases`). */
export interface DatabaseMeta {
  id: string;
  name: string;
  type: DatabaseType;
  owner: string | null;
  created_at: string | null;
  last_sync: string | null;
  schema_ver: number;
}

// ----------------------------------------------------------------------
// M2 — listone + archiviazione automatica
// ----------------------------------------------------------------------

/** Riga del listone Serie A (input JSON). Campi obbligatori: name. */
export interface ListoneEntry {
  name: string;
  team?: string | null;
  pos_fanta?: PosFanta | null;
  fvm?: number | null;
}

/** Risultato di un'importazione del listone. */
export interface ImportSummary {
  created: number;
  updated: number;
  archived: number;
  restored: number;
  errors: number;
  total_listone: number;
  active_db_id: string;
  active_db_name: string;
  error_messages: string[];
}

/** Giocatore archiviato (in players_archive). */
export interface ArchivedPlayer {
  id: string;
  db_id: string;
  name: string;
  team: string | null;
  pos_fanta: PosFanta | null;
  pos_real: string | null;
  archived_at: string;
  archived_reason: string;
  last_known_data: unknown; // snapshot JSON del player al momento dell'archiviazione
}

// ----------------------------------------------------------------------
// M2.1 — anteprima import con diff (FIX A5, B7)
// ----------------------------------------------------------------------

/** Voce di anteprima: giocatore che verrà CREATO (non esiste nel DB). */
export interface PreviewCreated {
  name: string;
  team: string | null;
  pos_fanta: PosFanta | null;
  fvm: number | null;
}

/** Voce di anteprima: giocatore che verrà ARCHIVIATO (non più in listone). */
export interface PreviewArchived {
  id: string;
  name: string;
  team: string | null;
  reason: string;
}

/** Voce di anteprima: giocatore che verrà AGGIORNATO (FVM nuovo). */
export interface PreviewUpdated {
  id: string;
  name: string;
  field_changed: string;
  old: number;
  new: number;
}

/** Voce di anteprima: giocatore che verrà RIPRISTINATO dall'archivio. */
export interface PreviewRestored {
  id: string;
  name: string;
  team: string | null;
}

/** Risultato della preview: 4 liste + totali + DB attivo. */
export interface ImportPreview {
  created: PreviewCreated[];
  archived: PreviewArchived[];
  updated: PreviewUpdated[];
  restored: PreviewRestored[];
  total_listone: number;
  active_db_id: string;
  active_db_name: string;
}

// ----------------------------------------------------------------------
// M2.1 — scouting notes (auto-toggle B3)
// ----------------------------------------------------------------------

export type ScoutingNoteKind = "data" | "link" | "note";

/** Payload per save_scouting_note. */
export interface SaveScoutingNoteInput {
  player_id: string;
  kind: ScoutingNoteKind;
  label?: string | null;
  content?: string | null;
  source?: string | null;
}

// ----------------------------------------------------------------------
// M2.1.1 — Cap.9: auction_data + scouting_notes tipizzati
// ----------------------------------------------------------------------

/** Riga 1:1 di `auction_data` per un giocatore. */
export interface AuctionData {
  player_id: string;
  /** Titolarità stimata 1-10 (10 = titolare inamovibile) */
  titolarita: number | null;
  /** Stato infortunistico: 'nessuno' | 'lieve' | 'grave' */
  infortuni: string | null;
  /** Nota rapida per consultazione durante la chiamata d'asta */
  quick_note: string | null;
  /** f₥ BUDGET MAX che SON DISPOSTO a spendere all'asta corrente (diverso da fmil_spesi storico) */
  fmil_max: number | null;
  /** Team lega a cui è stato assegnato il giocatore (NULL se non ancora assegnato) */
  assigned_to: string | null;
  /** f₥ prezzo di assegnazione effettivo (NULL se non ancora assegnato) */
  fmil_paid: number | null;
  /** Timestamp ISO di assegnazione */
  assigned_at: string | null;
}

/** Riga di `scouting_notes` (multi-row per player). */
export interface ScoutingNote {
  id: number;
  player_id: string;
  kind: ScoutingNoteKind;
  label: string | null;
  content: string | null;
  source: string | null;
  created_at: string | null;
}

// ----------------------------------------------------------------------
// M3 — Auto-fetch listone via GitHub Releases (Cap.7 design doc v2.5)
// ----------------------------------------------------------------------

/**
 * Metadati dell'ultima release del repo dossier-fanta-data.
 * Ritornato da `check_latest_listone_version`. NON contiene il file,
 * solo l'URL da passare a `download_listone`.
 */
export interface ListoneVersionInfo {
  tag: string;
  name: string;
  published_at: string;
  /** URL pubblico per il download diretto del file players.json. */
  asset_url: string;
  /** Dimensione in bytes del file (per progress UI). */
  asset_size_bytes: number;
  /** True se la release ha un asset "players.json" (sanity check). */
  has_players_json: boolean;
}

/**
 * Rappresentazione del file players.json scaricato dal repo dossier-fanta-data
 * (o generato dal fallback inline scraper).
 */
export interface ListoneData {
  /** Tag della release da cui deriva questo dato (per cache + skip). */
  tag: string;
  /** Versione (YYYY-MM-DD dal JSON source). */
  version: string;
  /** Timestamp ISO UTC di scraping. */
  scraped_at: string;
  /** Lista giocatori nel formato atteso da import_listone. */
  entries: ListoneEntry[];
  /** True se il dato deriva dal fallback inline scraper (per UI badge). */
  from_fallback: boolean;
}

/** Voce del log storico aggiornamenti (ultimi 5). */
export interface UpdateLogEntry {
  /** Timestamp ISO UTC dell'apply. */
  applied_at: string;
  /** Tag della release applicata. */
  tag: string;
  /** Sorgente: "github" se dalla release, "fallback" se scraper inline. */
  source: string;
  created: number;
  archived: number;
  updated: number;
  restored: number;
}

/** Stato dell'auto-fetch per la UI Aggiornamenti. */
export interface AutoFetchStatus {
  /** Tag dell'ultimo release applicato (vuoto se mai applicato). */
  last_applied_tag: string;
  /** Path del file cache locale (per debugging UI). */
  cache_path: string;
  /** Ultime 5 entry di aggiornamento. */
  update_log: UpdateLogEntry[];
}
