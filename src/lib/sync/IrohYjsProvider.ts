// src/lib/sync/IrohYjsProvider.ts — M3a.3 Deliverable 4.
//
// Provider Iroh: sync diretto p2p via QUIC + gossip protocol.
// Latency ~30-80ms (vs ~100ms di Supabase Realtime relay).
//
// RESPONSABILITÀ:
//   1. connect(): invoke iroh_start_node (con peer_key persistente da
//      sync_identity), registra listener `sync-update-received` per
//      applicare update remoti, registra listener `ydoc.on('update')`
//      per broadcast update locali via iroh_broadcast_update.
//   2. syncFromOffline(): no-op (Iroh è live-only, l'offline storage
//      è gestito da SupabaseYjsProvider).
//   3. disconnect(): rimuove i listener, invoke iroh_stop_node.
//   4. connectToSavedPeers(): per ognuno dei peer fidati salvati in
//      sync_peers, invoca iroh_connect_by_peer_key_v2. Auto-connect
//      al boot.
//
// ANTI-LOOP (architetturale, vedi Deliverable 5):
//   - Update locale (utente edita, `updateYDocPlayer` chiamato da
//     usePlayersStore — sostituto del rimosso `bridgePlayerUpdate`)
//     → ydoc.transact → ydoc.on('update') scatta con origin=undefined
//     (origin del transact) → provider invia via iroh_broadcast_update.
//   - Update remoto (ricevuto via gossip) → listener `sync-update-received`
//     → Y.applyUpdate(ydoc, bytes, this) → origin=this → listener
//     ydoc.on('update') scatta con origin=this → provider NON re-invia
//     (anti-loop nativo Yjs via `transaction.local`).
//
// Vincolo HARD #21: Iroh è opzionale. Se fallisce a connettersi (NAT
// simmetrico, relay irraggiungibile), SupabaseYjsProvider basta per il
// sync. Questo provider ritorna errore ma non blocca il SyncManager.

import * as Y from "yjs";
import type { SyncProvider } from "./SyncProvider";
import { api } from "@/api/tauri";
import { isDesktop } from "@/api/tauri";
import type { SyncUpdateReceivedEvent } from "@/types/sync";

/**
 * Provider Iroh: p2p diretto via gossip protocol.
 *
 * Secondary provider — attivo SOLO quando entrambi i peer sono online.
 * Primary è SupabaseYjsProvider (sempre attivo, anche offline).
 */
export class IrohYjsProvider implements SyncProvider {
  readonly name = "iroh";

  private connected = false;
  private ydoc: Y.Doc;
  private unlistenSyncUpdate: (() => void) | null = null;
  private unlistenPeerConnected: (() => void) | null = null;
  private unlistenPeerDisconnected: (() => void) | null = null;

  /**
   * Memorizza il listener `ydoc.on('update')` per poter fare unoff() su
   * disconnect() (evita leak — un listener attach a ogni connect senza
   * off corrispondente causerebbe un numero crescente di handler).
   */
  private ydocUpdateHandler:
    | ((update: Uint8Array, origin: unknown) => void)
    | null = null;

  private statusCallbacks: Array<(connected: boolean) => void> = [];

  constructor(ydoc: Y.Doc) {
    this.ydoc = ydoc;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  onStatusChange(callback: (connected: boolean) => void): void {
    this.statusCallbacks.push(callback);
  }

  private notifyStatusChange(): void {
    for (const cb of this.statusCallbacks) {
      try {
        cb(this.connected);
      } catch (err) {
        console.warn("[IrohYjsProvider] statusCallback fallita:", err);
      }
    }
  }

  async connect(): Promise<void> {
    if (this.connected) return; // idempotente
    if (!isDesktop) {
      console.info("[IrohYjsProvider] anteprima web — skip Iroh start");
      return;
    }

    // 1. Avvia il nodo Iroh (con peer_key persistente — sync_identity).
    //    `iroh_start_node` carica la SecretKey salvata da sync_identity se
    //    esiste, altrimenti la genera + salva. Peer_key stabile cross-boot.
    let peerKey: string;
    try {
      peerKey = await api.irohStartNode();
    } catch (err) {
      console.error("[IrohYjsProvider] irohStartNode fallito:", err);
      // Non throware — il SyncManager deve poter proseguire con Supabase.
      return;
    }

    // 2. Registra listener per `sync-update-received` (emesso dal subscribe
    //    loop Rust quando un peer remoto invia un update via gossip).
    //    Payload: { update_bytes: number[], bytes_len: number, from_peer: string }.
    //    Ricostruisce Uint8Array dai bytes e lo applica al Y.Doc con origin=this
    //    → ANTI-LOOP nativo Yjs (il listener ydoc.on('update') NON re-broadcast).
    this.unlistenSyncUpdate = await api.onSyncUpdateReceived(
      (event: SyncUpdateReceivedEvent) => {
        try {
          if (!event.update_bytes || event.update_bytes.length === 0) {
            console.warn("[IrohYjsProvider] sync-update-received con bytes vuoti, skip.");
            return;
          }
          const bytes = new Uint8Array(event.update_bytes);
          // Origin = this → ANTI-LOOP (vedi commento file).
          Y.applyUpdate(this.ydoc, bytes, this); // origin=this → ANTI-LOOP
          // (sarebbe equivalente chiamare `applyRemoteUpdate(bytes, this)` da
          // yjsDocuments.ts — la logica è identica. Teniamo Y.applyUpdate qui
          // per chiarezza: il provider sta applicando l'update che ha ricevuto.)
          if (import.meta.env?.DEV) {
            console.debug(
              `[IrohYjsProvider] sync-update-received: ${event.bytes_len} bytes da ${event.from_peer.slice(0, 16)}...`
            );
          }
        } catch (err) {
          console.error(
            "[IrohYjsProvider] applyUpdate da sync-update-received fallito:",
            err
          );
        }
      }
    );

    // 3. Listener `ydoc.on('update')` per broadcast update locali.
    //    Per ogni update del Y.Doc, se origin !== this (era locale, non
    //    applicato da un peer remoto), invia via Iroh gossip.
    this.ydocUpdateHandler = (update: Uint8Array, origin: unknown) => {
      if (origin === this) return; // anti-loop nativo Yjs
      // Invia via Iroh gossip. iroh_broadcast_update prende Uint8Array e
      // lo converte in Vec<u8> lato Rust via Array.from (vedi api wrapper).
      api.irohBroadcastUpdate(update).catch((err) => {
        // Non è un errore fatale: il broadcast può fallire se non ci sono
        // peer connessi, o se Iroh è temporaneamente down. Supabase provider
        // recapita comunque l'update (se online).
        console.debug(
          "[IrohYjsProvider] irohBroadcastUpdate skip (no peer/Iroh down?):",
          err
        );
      });
    };
    this.ydoc.on("update", this.ydocUpdateHandler);

    // 4. Listener per eventi peer-connected/disconnected (così la UI
    //    aggiorna in tempo reale senza polling).
    this.unlistenPeerConnected = await api.onSyncPeerConnected((event) => {
      console.info(
        `[IrohYjsProvider] peer connesso: ${event.peerKey.slice(0, 16)}...`
      );
      // Sync iniziale con il peer appena connesso — invia il nostro state vector
      // così il peer remoto può calcolare il diff e mandarci i suoi update.
      // NOTA: per ora inviamo l'intero state (encodeStateAsUpdate), come fa
      // il vecchio `initialSync()`. In futuro si può fare uno state vector
      // + diff bidirezionale (yjs_get_diff lato Rust) per ridurre bandwidth.
      try {
        const ourState = Y.encodeStateAsUpdate(this.ydoc);
        api.irohBroadcastUpdate(new Uint8Array(ourState)).catch(() => {
          // best effort
        });
      } catch (err) {
        console.debug("[IrohYjsProvider] initial sync send skip:", err);
      }
    });
    this.unlistenPeerDisconnected = await api.onSyncPeerDisconnected((event) => {
      console.info(
        `[IrohYjsProvider] peer disconnesso: ${event.peerKey.slice(0, 16)}...`
      );
    });

    this.connected = true;
    this.notifyStatusChange();
    console.info(
      `[IrohYjsProvider] connesso. peer_key=${peerKey.slice(0, 16)}...`
    );
  }

  async disconnect(): Promise<void> {
    if (this.unlistenSyncUpdate) {
      this.unlistenSyncUpdate();
      this.unlistenSyncUpdate = null;
    }
    if (this.unlistenPeerConnected) {
      this.unlistenPeerConnected();
      this.unlistenPeerConnected = null;
    }
    if (this.unlistenPeerDisconnected) {
      this.unlistenPeerDisconnected();
      this.unlistenPeerDisconnected = null;
    }
    if (this.ydocUpdateHandler) {
      this.ydoc.off("update", this.ydocUpdateHandler);
      this.ydocUpdateHandler = null;
    }
    if (isDesktop) {
      try {
        await api.irohStopNode();
      } catch (err) {
        console.warn("[IrohYjsProvider] irohStopNode fallito:", err);
      }
    }
    if (this.connected) {
      this.connected = false;
      this.notifyStatusChange();
    }
  }

  async syncFromOffline(): Promise<number> {
    // Iroh non ha offline storage — è solo live.
    // L'offline storage è gestito da SupabaseYjsProvider (tabella yjs_updates).
    return 0;
  }

  /**
   * Auto-connect peer fidati salvati in `sync_peers` (trusted=1).
   * Chiamato dal SyncView/SyncManager al boot DOPO connect().
   *
   * Per ogni peer: invoca iroh_connect_by_peer_key_v2 (che salva anche
   * come trusted — idempotente via INSERT OR IGNORE). Se fallisce (NAT
   * traversal timeout), logga warning e continua con il prossimo.
   */
  async connectToSavedPeers(peerKeys: string[]): Promise<void> {
    if (!isDesktop) return;
    for (const key of peerKeys) {
      try {
        const connected = await api.irohConnectByPeerKeyV2(key);
        if (connected) {
          console.info(
            `[IrohYjsProvider] auto-connect peer ${key.slice(0, 16)}... OK`
          );
        } else {
          console.warn(
            `[IrohYjsProvider] auto-connect peer ${key.slice(0, 16)}... FALLITO (NAT/timeout)`
          );
        }
      } catch (err) {
        console.warn(
          `[IrohYjsProvider] auto-connect peer ${key.slice(0, 16)}... errore:`,
          err
        );
      }
    }
  }
}
