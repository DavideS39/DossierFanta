// Wrapper per le invoke Tauri. Un singolo posto per tutti i comandi Rust.
// Se la signature di un comando cambia lato Rust, basta aggiornare qui.

import { invoke } from "@tauri-apps/api/core";
import type {
  CreatePlayerInput,
  DbInfo,
  ListFilters,
  Player,
  UpdatePlayerInput,
} from "@/types/player";

export const api = {
  /** Inizializza il DB (idempotente). Ritorna il path del file mio.db. */
  initDb: () => invoke<string>("init_db"),

  /** Recupera metadati DB: path, versione schema, conteggi. */
  getDbInfo: () => invoke<DbInfo>("get_db_info"),

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

  /** Elenca giocatori archiviati (non più in Serie A). */
  listArchive: (search?: string, limit?: number) =>
    invoke<unknown[]>("list_archive", {
      search: search ?? null,
      limit: limit ?? null,
    }),
};
