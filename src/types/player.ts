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
