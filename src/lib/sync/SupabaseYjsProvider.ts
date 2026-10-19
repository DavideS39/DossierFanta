// src/lib/sync/SupabaseYjsProvider.ts — M3a.4 + M3a.5 — multi-room per-pairing encryption.
//
// REFACTOR vs M3a.3:
//  - NON ha più un solo `room_name` globale. Ha UN canale Realtime per ogni
//    pairing salvato in `sync_pairings` (room_name derivata da ECDH shared_secret).
//  - Tutti i bytes Yjs broadcast/persistiti sono cifrati AES-256-GCM con la
//    shared_secret del pairing corrispondente.
//  - syncFromOffline: per ogni pairing, SELECT WHERE room_name = ? e decifra
//    ogni riga con la shared_secret del pairing.
//
// SECURITY MODEL (M3a.4 + M3a.5):
//  - shared_secret (32 byte) è derivata via X25519 ECDH dal mio SecretKey +
//    la peer_key dell'altro. MAI trasmessa. Vive solo in `sync_pairings`
//    SQLite locale.
//  - room_name = "df-sync-<hex(sha256(shared_secret))[:16]>". Derivata
//    deterministicamente. Unguessable senza shared_secret.
//  - Senza shared_secret, i bytes in `yjs_updates` sono AES-GCM ciphertext
//    indecifrabile (rumore casuale).
//  - Anche se Luca (terzo utente con l'app installata) fa SELECT * FROM
//    yjs_updates, ottiene ciphertext cifrati con chiavi che non ha. Senza
//    pairing con A o B, non vede nulla.
//
// Vincolo HARD #18: Supabase NON è authoritativo. SQLite locale è source of truth.
// Vincolo HARD #19: SUPABASE_URL e SUPABASE_ANON_KEY hardcoded (publishable key).
// Vincolo HARD #20 (esteso): yjs_updates contiene SOLO bytes AES-GCM cifrati.

import * as Y from "yjs";
import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import type { SyncProvider } from "./SyncProvider";
import { SYNC_CONFIG } from "./syncConfig";
import { api } from "@/api/tauri";
import type { Pairing } from "@/types/sync";

/**
 * Stato per-pairing: shared_secret + lastSeenId (per syncFromOffline
 * incrementale) + handle al canale Realtime dedicato.
 */
interface PairingChannel {
  pairing: Pairing;
  /** Canale Realtime dedicato a questo pairing (nome = room_name). */
  channel: RealtimeChannel;
  /** shared_secret come Uint8Array (convertita da number[] del tipo Pairing). */
  sharedSecretBytes: Uint8Array;
  /** Ultimo id di yjs_updates ricevuto per questa room. Persistito in localStorage. */
  lastSeenId: number;
}

/**
 * Provider Supabase con multi-room per-pairing encryption.
 *
 * Per ogni pairing salvato in sync_pairings:
 *   - Apre un canale Realtime dedicato (nome = room_name)
 *   - Registra un handler broadcast per decifrare gli update in arrivo
 *   - Registra un handler ydoc.on('update') per cifrare + broadcast + persist
 *   - syncFromOffline: SELECT WHERE room_name = ? AND id > last_seen_id
 */
export class SupabaseYjsProvider implements SyncProvider {
  readonly name = "supabase";

  private client: SupabaseClient;
  private connected = false;
  private ydoc: Y.Doc;
  private channels: Map<string /* peer_key_other */, PairingChannel> = new Map();
  private statusCallbacks: Array<(connected: boolean) => void> = [];
  private ydocUpdateHandler:
    | ((update: Uint8Array, origin: unknown) => void)
    | null = null;

  constructor(ydoc: Y.Doc) {
    this.ydoc = ydoc;
    this.client = createClient(
      SYNC_CONFIG.supabase.url,
      SYNC_CONFIG.supabase.anonKey,
      {
        auth: { persistSession: false, autoRefreshToken: false },
        realtime: { params: { eventsPerSecond: 50 } },
      }
    );
  }

  get isConnected(): boolean {
    return this.connected;
  }

  onStatusChange(callback: (connected: boolean) => void): void {
    this.statusCallbacks.push(callback);
  }

  private notifyStatusChange(): void {
    for (const cb of this.statusCallbacks) {
      try { cb(this.connected); } catch (err) { console.warn("[SupabaseYjsProvider] statusCallback fallita:", err); }
    }
  }

  /**
   * Carica i pairings salvati in `sync_pairings` e per ognuno:
   *  - apre un canale Realtime dedicato
   *  - registra handler broadcast (decifra + Y.applyUpdate)
   *  - esegue syncFromOffline (SELECT WHERE room_name = ? AND id > last_seen)
   *
   * Se 0 pairings salvati (utente non ha ancora pairato con nessuno), il
   * provider è "connesso" ma non fa nulla finché non viene chiamato
   * `addPairing()` (chiamato dal SyncView dopo pairing_complete/pairing_join).
   */
  async connect(): Promise<void> {
    if (this.connected) return;

    // 1. Carica pairings dal Rust (sync_pairings SQLite locale).
    let pairings: Pairing[] = [];
    try {
      pairings = await api.listPairings();
    } catch (err) {
      console.warn("[SupabaseYjsProvider] listPairings fallito (DB pre-v2.5?):", err);
    }

    // 2. Per ogni pairing, apri un canale + syncFromOffline.
    for (const p of pairings) {
      await this.subscribeToPairing(p);
    }

    // 3. Listener globale ydoc.on('update') — cifra + broadcast + persist
    //    per OGNI pairing. Origin check: skip se origin === this (anti-loop).
    this.ydocUpdateHandler = (update: Uint8Array, origin: unknown) => {
      if (origin === this) return;
      void this.broadcastToLocalPairings(update);
    };
    this.ydoc.on("update", this.ydocUpdateHandler);

    this.connected = true;
    this.notifyStatusChange();
    console.info(
      `[SupabaseYjsProvider] connesso. ${pairings.length} pairing(s) attivi.`
    );
  }

  /**
   * Apre un canale Realtime dedicato al pairing + registra handler broadcast +
   * syncFromOffline iniziale.
   *
   * Chiamato da `connect()` per ogni pairing salvato, e da `addPairing()`
   * quando l'utente completa un nuovo pairing (a runtime, senza riavviare).
   */
  async subscribeToPairing(pairing: Pairing): Promise<void> {
    if (this.channels.has(pairing.peerKeyOther)) {
      console.warn(`[SupabaseYjsProvider] pairing ${pairing.peerKeyOther.slice(0, 16)}... già subscribed, skip.`);
      return;
    }

    const sharedSecretBytes = new Uint8Array(pairing.sharedSecret);
    const channelName = `yjs:${pairing.roomName}`;
    const channel = this.client.channel(channelName, {
      config: { broadcast: { self: false } },
    });

    // Listener per broadcast in arrivo (decifra + apply).
    channel.on("broadcast", { event: "update" }, async ({ payload }) => {
      try {
        const arr = (payload as { update?: number[] }).update;
        if (!arr || !Array.isArray(arr) || arr.length === 0) return;
        const encrypted = new Uint8Array(arr as number[]);
        // Decifra con la shared_secret del pairing.
        const decrypted = await api.decryptUpdate(encrypted, sharedSecretBytes);
        // Origin = this → ANTI-LOOP: il ydoc.on('update') handler NON re-broadcast.
        Y.applyUpdate(this.ydoc, decrypted, this);
        // Touch last_seen del pairing.
        api.touchPairingLastSeen(pairing.peerKeyOther).catch(() => {});
      } catch (err) {
        console.error(
          `[SupabaseYjsProvider] decrypt+apply da broadcast fallito (room=${pairing.roomName}):`,
          err
        );
      }
    });

    // Subscribe con timeout 15s (come in connect() M3a.3).
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`Supabase pairing ${pairing.roomName} subscribe timeout (15s)`));
        }
      }, 15000);
      channel.subscribe((status: string) => {
        if (settled) return;
        if (status === "SUBSCRIBED") {
          settled = true;
          clearTimeout(timeout);
          resolve();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          settled = true;
          clearTimeout(timeout);
          reject(new Error(`Supabase pairing ${pairing.roomName} ${status}`));
        }
      });
    });

    // Persist channel state.
    const lastSeenId = this.loadLastSeenId(pairing.roomName);
    this.channels.set(pairing.peerKeyOther, {
      pairing,
      channel,
      sharedSecretBytes,
      lastSeenId,
    });

    // syncFromOffline iniziale per questo pairing.
    try {
      const n = await this.syncPairingFromOffline(pairing.peerKeyOther);
      if (n > 0) {
        console.info(
          `[SupabaseYjsProvider] pairing ${pairing.peerKeyOther.slice(0, 16)}... syncFromOffline: ${n} update recuperati.`
        );
      }
    } catch (err) {
      console.warn(
        `[SupabaseYjsProvider] syncFromOffline fallito per pairing ${pairing.peerKeyOther.slice(0, 16)}... (non blocking):`,
        err
      );
    }
  }

  /**
   * Aggiunge un nuovo pairing a runtime (chiamato dal SyncView dopo
   * pairing_complete/pairing_join). Non disconnette gli altri canali.
   */
  async addPairing(pairing: Pairing): Promise<void> {
    await this.subscribeToPairing(pairing);
  }

  /**
   * Rimuove un pairing (disconnette il canale + cleanup stato in memoria).
   * NON chiama deletePairing sul Rust — quello è gestito dal chiamante.
   */
  async removePairing(peerKeyOther: string): Promise<void> {
    const entry = this.channels.get(peerKeyOther);
    if (entry) {
      this.client.removeChannel(entry.channel);
      this.channels.delete(peerKeyOther);
    }
  }

  /**
   * Handler per update locali del Y.Doc:
   *  - Per ogni pairing salvato, cifra l'update con la shared_secret
   *  - Broadcast sul canale Realtime dedicato
   *  - Persisti (cifrato) in yjs_updates con il room_name del pairing
   */
  private async broadcastToLocalPairings(update: Uint8Array): Promise<void> {
    for (const [_, entry] of this.channels) {
      try {
        // Cifra con la shared_secret del pairing.
        const encrypted = await api.encryptUpdate(update, entry.sharedSecretBytes);
        // Broadcast live sul canale Realtime.
        try {
          entry.channel.send({
            type: "broadcast",
            event: "update",
            payload: { update: Array.from(encrypted) },
          });
        } catch (err) {
          console.warn(`[SupabaseYjsProvider] broadcast send fallito (room=${entry.pairing.roomName}):`, err);
        }
        // Persisti cifrato in yjs_updates (offline storage).
        this.client
          .from(SYNC_CONFIG.supabase.updatesTable)
          .insert({
            room_name: entry.pairing.roomName,
            update_bytes: encrypted, // Uint8Array → base64 wire
          })
          .then(({ error }) => {
            if (error) {
              console.warn(
                `[SupabaseYjsProvider] insert yjs_updates fallito (room=${entry.pairing.roomName}):`,
                error.message
              );
            }
          });
      } catch (err) {
        console.error(
          `[SupabaseYjsProvider] encrypt+broadcast fallito per pairing ${entry.pairing.peerKeyOther.slice(0, 16)}...:`,
          err
        );
      }
    }
  }

  async disconnect(): Promise<void> {
    if (this.ydocUpdateHandler) {
      this.ydoc.off("update", this.ydocUpdateHandler);
      this.ydocUpdateHandler = null;
    }
    for (const [_, entry] of this.channels) {
      this.client.removeChannel(entry.channel);
    }
    this.channels.clear();
    if (this.connected) {
      this.connected = false;
      this.notifyStatusChange();
    }
  }

  /**
   * Sync offline per tutti i pairing. Chiamato dal SyncManager.connectAll().
   */
  async syncFromOffline(): Promise<number> {
    let total = 0;
    for (const [peerKey, _] of this.channels) {
      try {
        total += await this.syncPairingFromOffline(peerKey);
      } catch (err) {
        console.warn(
          `[SupabaseYjsProvider] syncFromOffline pairing ${peerKey.slice(0, 16)}... fallito:`,
          err
        );
      }
    }
    return total;
  }

  /**
   * Sync offline per un singolo pairing. SELECT WHERE room_name = ? AND id > last_seen.
   * Decifra ogni riga con la shared_secret del pairing.
   */
  private async syncPairingFromOffline(peerKeyOther: string): Promise<number> {
    const entry = this.channels.get(peerKeyOther);
    if (!entry) return 0;
    const { pairing, sharedSecretBytes } = entry;

    const { data, error } = await this.client
      .from(SYNC_CONFIG.supabase.updatesTable)
      .select("id, update_bytes")
      .eq("room_name", pairing.roomName)
      .gt("id", entry.lastSeenId)
      .order("id", { ascending: true })
      .limit(1000);

    if (error) {
      console.warn(
        `[SupabaseYjsProvider] SELECT yjs_updates fallito (room=${pairing.roomName}):`,
        error.message
      );
      return 0;
    }
    if (!data || data.length === 0) return 0;

    let applied = 0;
    let maxId = entry.lastSeenId;
    for (const row of data) {
      try {
        let encrypted: Uint8Array;
        const raw = row.update_bytes as unknown;
        if (raw instanceof Uint8Array) {
          encrypted = raw;
        } else if (typeof raw === "string") {
          const bin = atob(raw);
          encrypted = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) encrypted[i] = bin.charCodeAt(i);
        } else if (Array.isArray(raw)) {
          encrypted = new Uint8Array(raw as number[]);
        } else {
          continue;
        }
        // Decifra con la shared_secret del pairing.
        const decrypted = await api.decryptUpdate(encrypted, sharedSecretBytes);
        // Origin = this → ANTI-LOOP: il handler ydoc.on('update') NON re-broadcast.
        Y.applyUpdate(this.ydoc, decrypted, this);
        if (row.id > maxId) maxId = row.id;
        applied++;
      } catch (err) {
        console.error(
          `[SupabaseYjsProvider] decrypt+apply fallito per riga id=${row.id} (room=${pairing.roomName}):`,
          err
        );
      }
    }

    if (maxId > entry.lastSeenId) {
      entry.lastSeenId = maxId;
      this.saveLastSeenId(pairing.roomName, maxId);
    }

    return applied;
  }

  // --- localStorage helpers per lastSeenId per-pairing ---

  private loadLastSeenId(roomName: string): number {
    try {
      const saved = localStorage.getItem(`yjs_supabase_last_seen_id:${roomName}`);
      return saved ? parseInt(saved, 10) || 0 : 0;
    } catch {
      return 0;
    }
  }

  private saveLastSeenId(roomName: string, id: number): void {
    try {
      localStorage.setItem(`yjs_supabase_last_seen_id:${roomName}`, String(id));
    } catch {
      // localStorage non disponibile — best effort
    }
  }

  async cleanup(olderThanDays: number = SYNC_CONFIG.supabase.cleanupDays): Promise<void> {
    const cutoff = new Date(Date.now() - olderThanDays * 86400000).toISOString();
    const { error } = await this.client
      .from(SYNC_CONFIG.supabase.updatesTable)
      .delete()
      .lt("created_at", cutoff);
    if (error) {
      console.warn("[SupabaseYjsProvider] cleanup DELETE fallito:", error.message);
    }
  }
}
