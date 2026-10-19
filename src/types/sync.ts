// src/types/sync.ts — Tipi TS mirror dei comandi Rust sync.rs (M3a).
//
// Tipi per il sync live CRDT P2P (Yjs + Iroh). Mirror esatto delle struct
// Rust in src-tauri/src/commands/sync.rs. Modifiche qui vanno replicate
// anche lato Rust e viceversa.
//
// Vincolo HARD #9: Tipi TS mirror Rust, unico punto IPC.

// ----------------------------------------------------------------------
// B.3 — yrs core (comandi yjs_*)
// ----------------------------------------------------------------------

/** Update Yjs in formato binary v1 (Uint8Array). */
export type YjsUpdate = Uint8Array;

/** State vector Yjs in formato binary v1 (per sync iniziale). */
export type YjsStateVector = Uint8Array;

/** Diff Yjs in formato binary v1 (per sync incrementale). */
export type YjsDiff = Uint8Array;

// ----------------------------------------------------------------------
// B.4 — Iroh p2p transport (comandi iroh_*)
// ----------------------------------------------------------------------

/** Peer key Iroh (NodeId in formato base32). */
export type PeerKey = string;

/** Stato del sync live (UI SyncView). */
export interface SyncStatus {
  /** True se il nodo Iroh è stato avviato (iroh_start_node chiamato). */
  started: boolean;
  /** Peer key corrente, null se nodo non avviato. */
  peerKey: PeerKey | null;
  /** Lista peer attualmente connessi. */
  connectedPeers: PeerKey[];
  /** Stato della connettività: 'live' | 'offline' | 'connecting'. */
  status: 'live' | 'offline' | 'connecting';
  /** Timestamp ISO 8601 dell'ultimo update ricevuto da un peer. */
  lastUpdateAt: string | null;
  /** Numero di updates ricevuti dall'ultimo boot. */
  updatesReceived: number;
  /** Numero di updates inviati dall'ultimo boot. */
  updatesSent: number;
}

// ----------------------------------------------------------------------
// B.6 — Cursori collaborativi
// ----------------------------------------------------------------------

/** Cursore collaborativo di un peer remoto. */
export interface LiveCursor {
  /** Identificatore del peer (PeerKey o display name). */
  userId: string;
  /** Nome umano del peer (es. "marco"). */
  name: string;
  /** Campo a cui il cursore è applicato, formato "table.id.field"
   * (es. "players.abc-123.notes", "scouting.abc-123.quick_note"). */
  field: string;
  /** Posizione del caret (offset nel campo testo). */
  position: number;
  /** Selezione [start, end] opzionale. Se null, è un caret singolo. */
  selection: [number, number] | null;
  /** Colore del cursore (hex). Default '#2C4A6B'. */
  color: string;
  /** Timestamp ISO 8601 ultimo update (per timeout automatico). */
  updatedAt: string;
}

// ----------------------------------------------------------------------
// B.8 — Comandi save_*_from_sync (input types)
// ----------------------------------------------------------------------

/** Input per save_player_from_sync. Mirror di Rust `PlayerSyncInput`. */
export interface PlayerSyncInput {
  id: string;
  dbId: string;
  name: string;
  team?: string | null;
  posFanta?: string | null;
  posReal?: string | null;
  status?: string | null;
  fascia?: string | null;
  priority?: number | null;
  fmilSpesi?: number | null;
  med?: number | null;
  medv?: number | null;
  fvm?: number | null;
  customData?: string | null;
  /** Peer Iroh che ha originato l'update (NodeId base32). */
  syncNodeId?: string | null;
}

/** Input per save_scouting_note_from_sync. Mirror di Rust `ScoutingNoteSyncInput`. */
export interface ScoutingNoteSyncInput {
  playerId: string;
  kind: 'data' | 'link' | 'note';
  label?: string | null;
  content?: string | null;
  source?: string | null;
  syncNodeId?: string | null;
}

/** Input per save_auction_data_from_sync. Mirror di Rust `AuctionDataSyncInput`. */
export interface AuctionDataSyncInput {
  playerId: string;
  titolarita?: number | null;
  infortuni?: 'nessuno' | 'lieve' | 'grave' | null;
  quickNote?: string | null;
  fmilMax?: number | null;
  assignedTo?: string | null;
  fmilPaid?: number | null;
  assignedAt?: string | null;
  syncNodeId?: string | null;
}

// ----------------------------------------------------------------------
// Eventi Tauri (payload degli event listener)
// ----------------------------------------------------------------------

/**
 * Payload dell'evento `sync-update-received` (emesso da sync.rs e sync_lan.rs).
 *
 * M3a.2 (PB4-B fix) — Il payload ora include `update_bytes` (array di numeri
 * 0-255, ricostruito in `Uint8Array` lato frontend). In M3a.1 il payload
 * conteneva solo `bytes_len` + `from_peer` (senza bytes) → NESSUN frontend
 * poteva applicare l'update al Y.Doc → peer ricevente non persisteva su SQLite.
 */
export interface SyncUpdateReceivedEvent {
  /** Bytes dell'update Yjs ricevuto (array di u8 0-255, serializzato da Vec<u8> Rust). */
  update_bytes: number[];
  /** Lunghezza dei bytes (ridondante ma utile per logging UI). */
  bytes_len: number;
  /** Peer key (NodeId base32 Iroh o IP:port LAN) che ha originato l'update. */
  from_peer: string;
}

/** Payload dell'evento `sync-cursor-update` (emesso da sync.rs). */
export interface SyncCursorUpdateEvent {
  cursor: LiveCursor;
}

/** Payload dell'evento `sync-peer-connected`. */
export interface SyncPeerConnectedEvent {
  peerKey: PeerKey;
  displayName?: string | null;
}

/** Payload dell'evento `sync-peer-disconnected`. */
export interface SyncPeerDisconnectedEvent {
  peerKey: PeerKey;
}

// ----------------------------------------------------------------------
// M3a.3 — Identità sync persistita (peer key Iroh stabile cross-boot)
// ----------------------------------------------------------------------

/**
 * Identità sync persistita. Mirror di Rust `SyncIdentity` (sync.rs).
 *
 * Singleton row della tabella `sync_identity` (v2.4). Caricata da `iroh_start_node`
 * per ricostruire la SecretKey Iroh salvata, così la peer_key (NodeId derivato)
 * è stabile cross-boot. L'utente non deve ri-scambiare la peer_key con i peer
 * fidati ad ogni riavvio.
 */
export interface SyncIdentity {
  /** NodeId Iroh (formato base32). Scambiata out-of-band con i peer. */
  peerKey: PeerKey;
  /** Nome umano opzionale (es. "marco"). NULL se non ancora impostato. */
  displayName: string | null;
  /** ISO 8601 della prima generazione della SecretKey. */
  createdAt: string;
}

/**
 * Peer fidato salvato in `sync_peers` (trusted=1).
 * Mirror di Rust `TrustedPeer` (sync.rs).
 *
 * Usato per l'auto-connect al boot: il SyncView chiama `listTrustedPeers`
 * dopo `iroh_start_node` e riconnette automaticamente i peer salvati.
 */
export interface TrustedPeer {
  /** NodeId Iroh base32 del peer. */
  peerId: PeerKey;
  /** Nome umano opzionale (es. "utente2"). */
  displayName: string | null;
  /** ISO 8601 primo pairing (quando l'utente ha aggiunto il peer). */
  pairedAt: string;
  /** ISO 8601 ultimo heartbeat / connect / sync. NULL se mai visto. */
  lastSeen: string | null;
  /** True se il peer è fidato (auto-connect al boot). False se rimosso. */
  trusted: boolean;
}

// ----------------------------------------------------------------------
// M3a.4 + M3a.5 — Pairing cifrato (ECDH + AES-GCM)
// ----------------------------------------------------------------------

/**
 * Pairing salvato in `sync_pairings` (M3a.4).
 * Mirror di Rust `Pairing` (pairing.rs).
 *
 * Un pairing = un "canale cifrato" stabilito con un peer. Contiene:
 *  - peer_key_other: NodeId Iroh del peer pairato (per Iroh connect)
 *  - shared_secret: 32-byte chiave ECDH (per AES-GCM cipher/decipher)
 *  - room_name: derivato dalla shared_secret (per SELECT yjs_updates
 *    WHERE room_name = ? + per nome canale Realtime)
 */
export interface Pairing {
  /** NodeId Iroh (base32) del peer pairato. */
  peerKeyOther: PeerKey;
  /** 32-byte chiave ECDH X25519 (serializzata come array di u8 0-255). */
  sharedSecret: number[];
  /** room_name derivato ("df-sync-<hex16>"). */
  roomName: string;
  /** Nome umano opzionale (es. "Giorgio"). */
  displayName: string | null;
  /** ISO 8601 primo pairing. */
  pairedAt: string;
  /** ISO 8601 ultimo sync/heartbeat. NULL se mai visto. */
  lastSeen: string | null;
}

/**
 * Output di `pairing_create` (initiator side, M3a.5).
 * Mirror di Rust `PairingCode` (pairing.rs).
 */
export interface PairingCode {
  /** 8-cifre "12345678". */
  code: string;
  /** ISO 8601 scadenza (5 min dopo creazione). */
  expiresAt: string;
}

/**
 * Output di `pairing_join` (responder) e `pairing_complete` (initiator).
 * Mirror di Rust `PairingResult` (pairing.rs).
 *
 * Ritornato al frontend dopo il pairing completo. Il frontend usa:
 *  - peer_key_other: per `iroh_connect_by_peer_key_v2` (stabilire QUIC)
 *  - room_name: per `SupabaseYjsProvider.subscribeToRoom(room_name, shared_secret)`
 *  - shared_secret: per cifrare/decifrare i bytes Yjs scambiati via Supabase
 */
export interface PairingResult {
  /** peer_key del peer appena pairato. */
  peerKeyOther: PeerKey;
  /** room_name derivato dalla shared_secret. */
  roomName: string;
  /** shared_secret (32 byte) per AES-GCM. */
  sharedSecret: number[];
}

/**
 * Codice pairing pending (initiator side, in corso).
 * Mirror di Rust `PairingPending` (pairing.rs).
 */
export interface PairingPending {
  code: string;
  peerKeyInitiator: string;
  createdAt: string;
}

/**
 * Payload del messaggio broadcast sul canale Realtime `pairing-<code>`.
 *
 * Tipi di messaggio:
 *  - `response`: il responder ha completato il pairing, comunica la sua
 *    peer_key all'initiator.
 *
 * In futuro (M5+): `group_invite` per invitare a un group pairing.
 */
export interface PairingRealtimeMessage {
  kind: "response" | "group_invite";
  /** peer_key del responder (per `kind: 'response'`). */
  peerKeyResponder?: string;
  /** Altri campi opzionali per `kind: 'group_invite'` (futuro). */
  [key: string]: unknown;
}
