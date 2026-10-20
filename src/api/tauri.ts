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
  AutoFetchStatus,
  CreatePlayerInput,
  DatabaseMeta,
  DbInfo,
  ImportPreview,
  ImportSummary,
  ListFilters,
  ListoneData,
  ListoneVersionInfo,
  Player,
  SaveScoutingNoteInput,
  ScoutingNote,
  Status,
  UpdatePlayerInput,
} from "@/types/player";
// M3a — Tipi sync_* mirror Rust (src-tauri/src/commands/sync.rs)
import type {
  AuctionDataSyncInput,
  PlayerSyncInput,
  ScoutingNoteSyncInput,
  // M3a.3 — nuovi tipi per sync_identity + trusted peers
  SyncIdentity,
  TrustedPeer,
  // M3a.3 — tipo evento sync-update-received
  SyncUpdateReceivedEvent,
  // M3a.4 + M3a.5 — tipi pairing cifrato
  Pairing,
  PairingCode,
  PairingResult,
  PairingPending,
} from "@/types/sync";

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
   *
   * M3a.1 (PB1 fix) — `scrapedAt` opzionale attiva la conflict resolution
   * auto-fetch vs sync-live (B.7): se un player ha `updated_at > scraped_at`
   * NON viene archiviato e un warning viene aggiunto a `error_messages`.
   * Passare `scrapedAt` dal ListoneData.scraped_at quando disponibile.
   */
  importListone: (playersJson: string, scrapedAt?: string) =>
    invoke<ImportSummary>("import_listone", {
      playersJson,
      scrapedAt: scrapedAt ?? null,
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

  // ===== M3 — Auto-fetch listone via GitHub Releases + fallback inline (Cap.7) =====

  /**
   * Interroga GitHub API per i metadati dell'ultima release del repo
   * dossier-fanta-data. NON scarica il file — ritorna tag/name/url/size.
   * Da usare all'avvio (App.tsx) + nella schermata Aggiornamenti.
   * Silenzioso su errore di rete (l'app continua a funzionare offline).
   */
  checkLatestListoneVersion: () =>
    invoke<ListoneVersionInfo>("check_latest_listone_version"),

  /**
   * Scarica il players.json dall'asset URL di una release GitHub.
   * Salva in cache locale (app data dir). Ritorna ListoneData già parsato.
   * Da chiamare dopo checkLatestListoneVersion con asset_url + tag.
   */
  downloadListone: (assetUrl: string, tag: string) =>
    invoke<ListoneData>("download_listone", { assetUrl, tag }),

  /**
   * Applica un ListoneData al DB attivo. Riusa la logica di import_listone:
   * Fase 1 match + Fase 2 archive + Fase 3 create + Fase 4 update fvm
   * con marker updated_by='auto-fetch'. Salva tag in cache/last_applied_tag.txt
   * + aggiunge entry al log storico (ultimi 5).
   * Il frontend DEVE aver mostrato anteprima diff (previewImportListone)
   * prima di chiamare questo comando — l'archiviazione è irreversibile.
   */
  applyAutoFetch: (listoneData: ListoneData) =>
    invoke<ImportSummary>("apply_auto_fetch", { listoneData }),

  /**
   * FALLBACK se GitHub è irraggiungibile. Scraper Rust embedded che scarica
   * fantacalcio.it e applica gli stessi selettori del parser Python in
   * dossier-fanta-data/scraper/scrape_fantacalcio.py. ~10-15 secondi.
   * Ritorna ListoneData con from_fallback=true.
   */
  scrapeListoneInline: () =>
    invoke<ListoneData>("scrape_listone_inline"),

  /**
   * Ritorna lo stato corrente dell'auto-fetch: tag applicato (se in cache),
   * lista degli ultimi 5 aggiornamenti. NON fa chiamate di rete —
   * è una lettura cache locale. Da usare per popolare la schermata Aggiornamenti.
   */
  getAutofetchStatus: () =>
    invoke<AutoFetchStatus>("get_autofetch_status"),

  /**
   * M3a.5 — Archivia tutti i giocatori con `*` nel nome (fuori serie A).
   * Li sposta da `players` a `players_archive` con archived_reason='non_in_listone'.
   * NON distruttivo — i dati sono preservati in last_known_data.
   * Ritorna il count dei player archiviati.
   */
  archiveAsteriskPlayers: () =>
    invoke<number>("archive_asterisk_players"),

  // ====================================================================
  // M3a — Sync live CRDT P2P (Yjs + Iroh). Design doc Cap.5.
  // Tutti i comandi sync_* esposti da src-tauri/src/commands/sync.rs.
  // ====================================================================

  // --- B.3 yrs core ---

  /** Applica un update Yjs ricevuto da peer remoto (formato binary v1). */
  yjsApplyUpdate: (update: Uint8Array) =>
    invoke<boolean>("yjs_apply_update", {
      updateBytes: Array.from(update),
    }),

  /** Ritorna lo state vector del Doc yrs corrente (per sync iniziale). */
  yjsGetStateVector: () =>
    invoke<number[]>("yjs_get_state_vector").then((arr) => new Uint8Array(arr)),

  /** Calcola il diff tra lo state vector del chiamante e lo stato corrente. */
  yjsGetDiff: (stateVector: Uint8Array) =>
    invoke<number[]>("yjs_get_diff", {
      stateVector: Array.from(stateVector),
    }).then((arr) => new Uint8Array(arr)),

  // --- B.4 Iroh p2p transport ---

  /** Avvia il nodo Iroh e ritorna la peer key (NodeId base32). */
  irohStartNode: () =>
    invoke<string>("iroh_start_node"),

  /** Ritorna la peer key corrente. Errore se nodo non avviato. */
  irohGetPeerKey: () =>
    invoke<string>("iroh_get_peer_key"),

  /** Connette a un peer remoto via peer key. NAT traversal automatico. */
  irohConnectByPeerKey: (peerKey: string) =>
    invoke<boolean>("iroh_connect_by_peer_key", { peerKey }),

  /** Broadcast un update Yjs a tutti i peer connessi via gossip. */
  irohBroadcastUpdate: (update: Uint8Array) =>
    invoke<void>("iroh_broadcast_update", {
      updateBytes: Array.from(update),
    }),

  /** Sottoscrive updates ricevuti da peer remoti (avvia task di background). */
  irohSubscribeUpdates: () =>
    invoke<void>("iroh_subscribe_updates"),

  /** Lista dei peer attualmente connessi. */
  irohGetConnectedPeers: () =>
    invoke<string[]>("iroh_get_connected_peers"),

  /** Disconnette un peer (rimosso dalla lista connessi). */
  irohDisconnectPeer: (peerKey: string) =>
    invoke<void>("iroh_disconnect_peer", { peerKey }),

  // --- M3a.3 — Peer key persistente + trusted peers ---

  /** Ferma il nodo Iroh corrente (rilascia risorse QUIC). SecretKey resta salvata. */
  irohStopNode: () =>
    invoke<void>("iroh_stop_node"),

  /**
   * Versione 2 di irohConnectByPeerKey che accetta DbState e salva il peer
   * come trusted in `sync_peers` dopo una connessione QUIC riuscita. Usa questo
   * al posto di `irohConnectByPeerKey` per abilitare l'auto-connect al boot.
   */
  irohConnectByPeerKeyV2: (peerKey: string) =>
    invoke<boolean>("iroh_connect_by_peer_key_v2", { peerKey }),

  /** Ritorna l'identità sync persistita (peer_key + display_name), o null se non ancora creata. */
  getSyncIdentity: () =>
    invoke<SyncIdentity | null>("get_sync_identity"),

  /** Imposta il display_name dell'identità sync corrente. */
  setSyncDisplayName: (name: string) =>
    invoke<void>("set_sync_display_name", { name }),

  /** Lista peer fidati salvati (auto-connect al boot). */
  listTrustedPeers: () =>
    invoke<TrustedPeer[]>("list_trusted_peers"),

  /** Rimuove un peer dalla lista trusted (NON lo delete, imposta trusted=0). */
  removeTrustedPeer: (peerKey: string) =>
    invoke<void>("remove_trusted_peer", { peerKey: peerKey }),

  // --- B.8 save_*_from_sync (con updated_by='sync-live' lato Rust) ---

  /** Persiste un player ricevuto dal sync CRDT. */
  savePlayerFromSync: (input: PlayerSyncInput) =>
    invoke<void>("save_player_from_sync", { input }),

  /** Persiste una scouting note ricevuta dal sync CRDT. */
  saveScoutingNoteFromSync: (input: ScoutingNoteSyncInput) =>
    invoke<number>("save_scouting_note_from_sync", { input }),

  /** Persiste auction_data ricevuta dal sync CRDT (UPSERT). */
  saveAuctionDataFromSync: (input: AuctionDataSyncInput) =>
    invoke<void>("save_auction_data_from_sync", { input }),

  // ===== M3a B.9 — Fallback WebSocket LAN-only (solo feature flag `lan-only`) =====
  // M3a.1 fix aggiuntivo B: lan_broadcast_update è ora bidirezionale,
  // lan_discover_peers è nuovo (mDNS discovery automatico).

  /** Avvia un server WebSocket LAN. Ritorna l'addr effettivo. */
  lanStartServer: (addr: string) =>
    invoke<string>("lan_start_server", { addr }),

  /** Connette a un server WebSocket LAN. */
  lanConnect: (addr: string) =>
    invoke<boolean>("lan_connect", { addr }),

  /** Broadcast update Yjs a tutti i peer connessi via WebSocket LAN. */
  lanBroadcastUpdate: (updateBytes: Uint8Array) =>
    invoke<void>("lan_broadcast_update", { updateBytes: Array.from(updateBytes) }),

  /** Lista peer connessi (IP:port). */
  lanGetConnectedPeers: () =>
    invoke<string[]>("lan_get_connected_peers"),

  /** Disconnette un peer. */
  lanDisconnectPeer: (peerKey: string) =>
    invoke<void>("lan_disconnect_peer", { peerKey }),

  /** M3a.1 — Cerca peer DossierFanta sulla LAN via mDNS. */
  lanDiscoverPeers: (timeoutMs?: number) =>
    invoke<string[]>("lan_discover_peers", { timeoutMs: timeoutMs ?? null }),

  // ===== M3a.3 — Listener eventi Tauri (pattern listen congelato) =====
  //
  // Wrapper per `listen<T>("event-name", callback)`. Ritornano una `UnlistenFn`
  // che il caller deve chiamare su cleanup. Incapsulano qui così i nomi degli
  // eventi stanno in un solo file (evita typo in giro per il codebase).

  /**
   * Listener per `sync-update-received` (emesso dal subscribe loop Iroh o
   * dal peer handler LAN quando arriva un update Yjs binario da un peer).
   * Il caller deve chiamare l'unlisten ritornato su cleanup.
   */
  onSyncUpdateReceived: (
    cb: (event: SyncUpdateReceivedEvent) => void
  ): Promise<UnlistenFn> =>
    listen<SyncUpdateReceivedEvent>("sync-update-received", (e) => {
      try {
        cb(e.payload);
      } catch (err) {
        console.error("[api.onSyncUpdateReceived] handler fallito:", err);
      }
    }),

  /** Listener per `sync-peer-connected` (NeighborUp nel gossip swarm). */
  onSyncPeerConnected: (
    cb: (event: { peerKey: string }) => void
  ): Promise<UnlistenFn> =>
    listen<{ peerKey: string }>("sync-peer-connected", (e) => cb(e.payload)),

  /** Listener per `sync-peer-disconnected` (NeighborDown nel gossip swarm). */
  onSyncPeerDisconnected: (
    cb: (event: { peerKey: string }) => void
  ): Promise<UnlistenFn> =>
    listen<{ peerKey: string }>("sync-peer-disconnected", (e) => cb(e.payload)),

  // ===== M3a.4 + M3a.5 — Pairing cifrato (ECDH + AES-GCM) =====

  /**
   * Deriva la shared_secret (32 byte) dal mio SecretKey Iroh + their peer_key.
   * Usa X25519 ECDH. La shared_secret è MATEMATICAMENTE la stessa che l'altro
   * peer deriva dal suo SecretKey + la mia peer_key.
   */
  deriveSharedSecret: (theirPeerKey: string) =>
    invoke<number[]>("derive_shared_secret", { theirPeerKey }).then((arr) =>
      new Uint8Array(arr)
    ),

  /**
   * Cifra `update` (Yjs bytes binari) con AES-256-GCM usando `shared_secret`.
   * Output: `[nonce(12) || ciphertext || tag(16)]`.
   */
  encryptUpdate: (update: Uint8Array, sharedSecret: Uint8Array) =>
    invoke<number[]>("encrypt_update", {
      update: Array.from(update),
      sharedSecret: Array.from(sharedSecret),
    }).then((arr) => new Uint8Array(arr)),

  /**
   * Decifra `ciphertext` (formato `[nonce(12) || ciphertext || tag(16)]`)
   * con AES-256-GCM usando `shared_secret`. Ritorna plaintext.
   */
  decryptUpdate: (ciphertext: Uint8Array, sharedSecret: Uint8Array) =>
    invoke<number[]>("decrypt_update", {
      ciphertext: Array.from(ciphertext),
      sharedSecret: Array.from(sharedSecret),
    }).then((arr) => new Uint8Array(arr)),

  /** Lista tutti i pairings salvati (per boot auto-connect del SupabaseYjsProvider). */
  listPairings: () =>
    invoke<Pairing[]>("list_pairings"),

  /**
   * Salva un pairing (chiamato da pairing_complete/pairing_join, ma anche
   * esponibile per UI manuale). Idempotente via INSERT OR REPLACE.
   */
  savePairing: (
    peerKeyOther: string,
    sharedSecret: Uint8Array,
    roomName: string,
    displayName?: string | null
  ) =>
    invoke<void>("save_pairing", {
      peerKeyOther,
      sharedSecret: Array.from(sharedSecret),
      roomName,
      displayName: displayName ?? null,
    }),

  /** Rimuove un pairing. NON tocca sync_peers — per rimuovere completamente,
   *  chiama anche `removeTrustedPeer`. */
  deletePairing: (peerKeyOther: string) =>
    invoke<void>("delete_pairing", { peerKeyOther }),

  /**
   * M3a.5 — Initiator: genera un codice 8-cifre + lo salva localmente in
   * sync_pairings_pending per tracking/crash-resume. La pubblicazione su
   * Supabase `pairings` table è gestita dal frontend (chiama Supabase diretto).
   */
  pairingCreate: () =>
    invoke<PairingCode>("pairing_create"),

  /**
   * M3a.5 — Responder: entra il codice 8-cifre, deriva shared_secret + room_name
   * via ECDH, salva pairing localmente, ritorna PairingResult.
   * Il frontend poi broadcast su Realtime `pairing-<code>`: { peer_key_responder: my }.
   */
  pairingJoin: (code: string, peerKeyInitiator: string) =>
    invoke<PairingResult>("pairing_join", { code, peerKeyInitiator }),

  /**
   * M3a.5 — Initiator: quando riceve la risposta del responder via Realtime
   * (peer_key_responder), chiama questo comando per completare il pairing.
   * Deriva la stessa shared_secret del responder (ECDH), salva pairing,
   * cleanup sync_pairings_pending locale.
   */
  pairingComplete: (code: string, peerKeyResponder: string) =>
    invoke<PairingResult>("pairing_complete", { code, peerKeyResponder }),

  /** M3a.5 — Cancella un codice pairing in corso (initiator side). */
  pairingCancel: (code: string) =>
    invoke<void>("pairing_cancel", { code }),

  /** M3a.5 — Lista codici pairing pending (in corso, initiator side). */
  listPendingPairings: () =>
    invoke<PairingPending[]>("list_pending_pairings"),

  /** M3a.4 — Aggiorna last_seen di un pairing (chiamato su ogni sync-update-received). */
  touchPairingLastSeen: (peerKeyOther: string) =>
    invoke<void>("touch_pairing_last_seen", { peerKeyOther }),

  /** M3a.4 — Imposta il display_name di un pairing (es. "Giorgio"). */
  setPairingDisplayName: (peerKeyOther: string, name: string) =>
    invoke<void>("set_pairing_display_name", { peerKeyOther, name }),
};

/** True solo dentro il binario Tauri (WebView con internals iniettati). */
export const isDesktop =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * API attiva: comandi Rust dentro Tauri, mock in-memory nel browser
 * (anteprima web dev-only). Tutti i componenti consumano solo `api`.
 */
export const api = isDesktop ? tauriApi : mockApi;
