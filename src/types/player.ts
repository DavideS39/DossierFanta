// Tipi TypeScript mirror dei tipi Rust in src-tauri/src/commands/players.rs.
// MANTENERE SINCRONIZZATO con le struct Rust: ogni campo qui deve esistere là.

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
  name: string;
  team: string | null;
  pos_fanta: PosFanta | null;
  pos_real: string | null;
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
  limit?: number | null;
  offset?: number | null;
}

/** Metadati DB restituiti da get_db_info. */
export interface DbInfo {
  db_path: string;
  schema_version: number;
  players_count: number;
  archived_count: number;
  default_db_id: string;
  default_db_name: string;
}
