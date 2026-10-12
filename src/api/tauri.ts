// Wrapper per le invoke Tauri. Un singolo posto per tutti i comandi Rust.
// Se la signature di un comando cambia lato Rust, basta aggiornare qui.
//
// v2.3.2 — GATE ANTEPRIMA WEB: fuori da Tauri (browser, `npm run dev`)
// l'app usa il backend in-memory `mock.ts` (dati dimostrativi, badge
// "anteprima web · mock" nel masthead). Dentro il binario desktop questo
// file usa SOLO i comandi Rust: zero rischio production.

import { invoke } from "@tauri-apps/api/core";
// M2.2 — FIX A2 (F12, Cap.17): import `listen` da @tauri-apps/api/event
// per sottoscrivere l'evento `player-updated` emesso dal backend Rust
// dopo save_scouting_note / save_auction_data / set_player_status /
// assign_player. Permette alla finestra OS e alla main window di
// refreshare la vista senza intervento manuale.
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { mockApi } from "./mock";
import type {
  ArchivedPlayer,
  AuctionData,
  CreatePlayerInput,
  DatabaseMeta,
  DbInfo,
  ImportPreview,
  ImportSummary,
  ListFilters,
  Player,
  SaveScoutingNoteInput,
  ScoutingNote,
  Status,
  UpdatePlayerInput,
} from "@/types/player";

export const tauriApi = {
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

  // ===== M2.1 — FIX A5 (B7): preview import con diff =====

  /**
   * Anteprima import: calcola cosa succederebbe senza applicare modifiche.
   * Ritorna 4 liste (created/archived/updated/restored) con dettagli.
   * L'UI mostra il risultato in un modale di conferma prima di chiamare
   * il vero `importListone`.
   */
  previewImportListone: (playersJson: string) =>
    invoke<ImportPreview>("preview_import_listone", {
      playersJson,
    }),

  // ===== M2.1 — IMPROVEMENT B3: stato scoutato (auto-toggle + manuale) =====

  /**
   * Imposta lo status di un giocatore (toggle manuale dal timbro).
   * `new_status` deve essere uno tra 'totali', 'scoutato', 'da_fare'.
   */
  setPlayerStatus: (playerId: string, newStatus: Status) =>
    invoke<Player>("set_player_status", { playerId, newStatus }),

  /**
   * Salva una nota scouting per un giocatore. Se il giocatore è in
   * 'da_fare' e la nota è kind='note' o 'data' con content non vuoto,
   * status viene automaticamente promosso a 'scoutato' (auto-toggle).
   */
  saveScoutingNote: (input: SaveScoutingNoteInput) =>
    invoke<boolean>("save_scouting_note", { input }),

  /**
   * M2.1 B5 — Legge un singolo giocatore per id (usato dalla finestra OS
   * nativa `/player/:id` che non ha il Zustand store con la lista caricata).
   */
  getPlayer: (playerId: string) =>
    invoke<Player>("get_player", { playerId }),

  // ===== M2.1.1 — Cap.9: auction_data + scouting_notes CRUD =====

  /** Legge i dati asta di un giocatore (1:1 da auction_data). null se non esiste. */
  getAuctionData: (playerId: string) =>
    invoke<AuctionData | null>("get_auction_data", { playerId }),

  /**
   * Upsert dati asta. Solo i campi passati vengono aggiornati.
   * Passa null per i campi che non vuoi toccare.
   */
  saveAuctionData: (
    playerId: string,
    titolarita: number | null,
    infortuni: string | null,
    fmilMax: number | null,
    quickNote: string | null,
  ) =>
    invoke<boolean>("save_auction_data", {
      playerId,
      titolarita,
      infortuni,
      fmilMax,
      quickNote,
    }),

  /** Elenca le note scouting di un giocatore (multi-row). */
  listScoutingNotes: (playerId: string) =>
    invoke<ScoutingNote[]>("list_scouting_notes", { playerId }),

  /**
   * Assegna un giocatore a un team lega con prezzo pagato.
   * Setta auction_data.assigned_to + fmil_paid + assigned_at.
   */
  assignPlayer: (playerId: string, assignedTo: string, fmilPaid: number) =>
    invoke<boolean>("assign_player", { playerId, assignedTo, fmilPaid }),

  // ===== M2.1 — IMPROVEMENT B5 (Cap.17): multi-window OS nativa =====

  /**
   * Crea una nuova finestra OS nativa per un giocatore (URL /player/:id).
   * Max 6 finestre contemporanee. Se già aperta, focus + return.
   */
  openPlayerWindow: (playerId: string) =>
    invoke<boolean>("open_player_window", { playerId }),

  /** Chiude una finestra OS aperta per un giocatore. */
  closePlayerWindow: (playerId: string) =>
    invoke<boolean>("close_player_window", { playerId }),

  /** Elenca gli id dei giocatori con finestra OS aperta (per UI badge). */
  listOsPlayerWindows: () => invoke<string[]>("list_os_player_windows"),

  // ===== M2.2 — FIX A2 (F12): eventi Tauri per sync tra finestre =====

  /**
   * Sottoscrive l'evento `player-updated` emesso dal backend Rust dopo
   * save_scouting_note / save_auction_data / set_player_status /
   * assign_player. Il payload è `{ id: string }` (player_id aggiornato).
   *
   * Ritorna una `UnlistenFn` da chiamare per disiscrivere (cleanup).
   *
   * Use case: quando l'utente modifica una scheda nella finestra OS nativa,
   * la main window (RosaView + usePlayersStore) refresha la lista Rosa;
   * viceversa, modifiche nella main window refreshano la finestra OS.
   * Senza questo, l'utente dovrebbe chiudere/riaprire la scheda per vedere
   * i cambiamenti (TODO esplicito nel report di ispezione M2.1, F12).
   *
   * In anteprima web (mock) è no-op: ritorna una funzione vuota.
   */
  onPlayerUpdated: (callback: (id: string) => void): Promise<UnlistenFn> =>
    listen<{ id: string }>("player-updated", (e) => callback(e.payload.id)),
};

/** True solo dentro il binario Tauri (WebView con internals iniettati). */
export const isDesktop =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * API attiva: comandi Rust dentro Tauri, mock in-memory nel browser
 * (anteprima web dev-only). Tutti i componenti consumano solo `api`.
 */
export const api = isDesktop ? tauriApi : mockApi;
