// Wrapper per le invoke Tauri. Un singolo posto per tutti i comandi Rust.
// Se la signature di un comando cambia lato Rust, basta aggiornare qui.

import { invoke } from "@tauri-apps/api/core";
import type {
  ArchivedPlayer,
  CreatePlayerInput,
  DatabaseMeta,
  DbInfo,
  ImportSummary,
  ListFilters,
  Player,
  UpdatePlayerInput,
} from "@/types/player";

export const api = {
  // ===== database (M1) =====

  /** Inizializza il DB (idempotente). Ritorna il path del file mio.db. */
  initDb: () => invoke<string>("init_db"),

  /** Recupera metadati DB: path, versione schema, conteggi, DB attivo. */
  getDbInfo: () => invoke<DbInfo>("get_db_info"),

  // ===== database (M2 — multi-DB workspace) =====

  /** Elenca tutti i DB logici (righe della tabella `databases`). */
  listDatabases: () => invoke<DatabaseMeta[]>("list_databases"),

  /** Crea un nuovo DB (PERSONALE o CONDIVISO). Ritorna i metadati. */
  createDatabase: (name: string, type?: "personal" | "shared" | "listone") =>
    invoke<DatabaseMeta>("create_database", { name, dbType: type ?? "personal" }),

  /** Elimina un DB (cascade sui suoi players). Non permette default-personal. */
  deleteDatabase: (id: string) => invoke<boolean>("delete_database", { id }),

  /** Imposta il DB attivo. Ritorna i metadati del DB appena attivato. */
  setActiveDatabase: (id: string) =>
    invoke<DatabaseMeta>("set_active_database", { id }),

  /** Ritorna i metadati del DB attualmente attivo. */
  getActiveDatabase: () => invoke<DatabaseMeta>("get_active_database"),

  // ===== players (M1 + M2 refactor) =====

  /** Elenca giocatori applicando i filtri passati. */
  listPlayers: (filters?: ListFilters) =>
    invoke<Player[]>("list_players", { filters: filters ?? null }),

  /** Conta giocatori con gli stessi filtri di listPlayers. */
  countPlayers: (filters?: ListFilters) =>
    invoke<number>("count_players", { filters: filters ?? null }),

  /** Crea un nuovo giocatore. Valida i campi lato Rust. */
  createPlayer: (input: CreatePlayerInput) =>
    invoke<Player>("create_player", { input }),

  /** Aggiorna un giocatore esistente (full replace). */
  updatePlayer: (input: UpdatePlayerInput) =>
    invoke<Player>("update_player", { input }),

  /**
   * Elimina un giocatore. Esplicita — il frontend DEVE confermare con
   * dialog prima di chiamare questo metodo (vincolo hard specifica v2.2).
   */
  deletePlayer: (id: string) => invoke<boolean>("delete_player", { id }),

  /** Archivia un giocatore (lo sposta in players_archive, NON distruttivo). */
  archivePlayer: (id: string, reason?: string) =>
    invoke<boolean>("archive_player", { id, reason: reason ?? null }),

  /** Elenca giocatori archiviati (M1 API — JSON non tipato). */
  listArchive: (search?: string, limit?: number) =>
    invoke<unknown[]>("list_archive", {
      search: search ?? null,
      limit: limit ?? null,
    }),

  // ===== listone + archiviazione automatica (M2) =====

  /**
   * Importa un listone Serie A (JSON string) e applica la logica di
   * archiviazione automatica. Vedi backend commands/listone.rs per il
   * flusso completo (create/update/archive/restore).
   */
  importListone: (playersJson: string) =>
    invoke<ImportSummary>("import_listone", {
      playersJson,
    }),

  /** Elenca giocatori archiviati (M2 API tipata). */
  listArchivedPlayers: (search?: string, role?: string) =>
    invoke<ArchivedPlayer[]>("list_archived_players", {
      search: search ?? null,
      role: role ?? null,
    }),

  /** Ripristina un giocatore dall'archivio (mossa archive → players). */
  restoreArchivedPlayer: (playerId: string) =>
    invoke<boolean>("restore_archived_player", { playerId }),
};
