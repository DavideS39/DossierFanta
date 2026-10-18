// src/lib/sync/SupabaseYjsProvider.ts — M3a.3 Deliverable 2.
//
// Provider Supabase per sync live Yjs:
//   - Realtime broadcast via WebSocket (~100ms latency, sempre attivo)
//   - Offline storage via tabella PostgreSQL `yjs_updates` (recuperata
//     al boot con syncFromOffline)
//
// Architettura (M3a.3 — vedi brief sezione "DUE PROVIDER"):
//
//   PC A  ←── Supabase Realtime ──→  Supabase  ←── Supabase Realtime ──→  PC B
//         (broadcast ~100ms)        (gratis)         (broadcast ~100ms)
//   Y.Doc                              PostgreSQL
//   SQLite                             yjs_updates
//         ←── query (su reconnect) ──→           ←── query (su reconnect) ──→
//
// RESPONSABILITÀ:
//   1. connect(): apre il canale Realtime, registra il listener `ydoc.on('update')`
//      per broadcast + persist in tabella. Chiama syncFromOffline().
//   2. syncFromOffline(): SELECT da yjs_updates WHERE id > last_seen ORDER BY id.
//   3. disconnect(): chiude il canale, rilascia risorse.
//
// ANTI-LOOP: gestito dal parametro `origin` di Yjs.
//   - Update locale (utente edita) → origin=undefined (non this) → broadcast.
//   - Update remoto (ricevuto da Supabase) → Y.applyUpdate(doc, bytes, this)
//     → origin=this → listener NON re-broadcast (anti-loop nativo Yjs).
//
// Vincolo HARD #18: SQLite locale SEMPRE authoritativo. Supabase è solo
// transport + offline buffer.
// Vincolo HARD #20: tabella yjs_updates contiene SOLO bytes binari Yjs
// (CRDT diffs), nessun dato sensibile.

import * as Y from "yjs";
import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import type { SyncProvider } from "./SyncProvider";
import { SYNC_CONFIG } from "./syncConfig";

/**
 * Provider Supabase: realtime broadcast + offline storage.
 *
 * Sempre attivo (primario). Garantisce sync anche se Iroh non è disponibile
 * o non si connette (es. NAT simmetrico senza relay).
 */
export class SupabaseYjsProvider implements SyncProvider {
  readonly name = "supabase";

  private client: SupabaseClient;
  private channel: RealtimeChannel | null = null;
  private connected = false;
  private ydoc: Y.Doc;

  /**
   * Ultimo id di `yjs_updates` ricevuto. Persistito in localStorage per
   * sopravvivere ai riavvii (al boot, scarica solo gli update accumulati
   * da quando eri offline).
   *
   * Schema: chiave `yjs_supabase_last_seen_id` → stringa decimale.
   */
  private lastSeenId: number = 0;

  private statusCallbacks: Array<(connected: boolean) => void> = [];

  /**
   * Memorizza il listener `ydoc.on('update')` per poter fare unoff() su
   * disconnect() (evita leak).
   */
  private ydocUpdateHandler:
    | ((update: Uint8Array, origin: unknown) => void)
    | null = null;

  constructor(ydoc: Y.Doc) {
    this.ydoc = ydoc;
    this.client = createClient(
      SYNC_CONFIG.supabase.url,
      SYNC_CONFIG.supabase.anonKey,
      {
        // Disabilita persistenza sessione (no auth, solo anon).
        auth: { persistSession: false, autoRefreshToken: false },
        // Realtime params: se la connessione WebSocket si rompe, riprova
        // automaticamente con backoff esponenziale (gestito da supabase-js).
        realtime: {
          params: { eventsPerSecond: 50 }, // hard cap per evitare flood
        },
      }
    );

    // Carica lastSeenId da localStorage (continuità cross-boot).
    try {
      const saved = localStorage.getItem("yjs_supabase_last_seen_id");
      if (saved) this.lastSeenId = parseInt(saved, 10) || 0;
    } catch {
      // localStorage non disponibile (es. SSR) — fallback a 0.
    }
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
        console.warn("[SupabaseYjsProvider] statusCallback fallita:", err);
      }
    }
  }

  async connect(): Promise<void> {
    if (this.connected) return; // idempotente

    // 1. Crea il canale Realtime per broadcast live.
    const channelName = `yjs:${SYNC_CONFIG.supabase.roomName}`;
    this.channel = this.client.channel(channelName, {
      config: { broadcast: { self: false } }, // non ricevere i propri broadcast
    });

    // 2. Listener per update ricevuti via broadcast (live sync).
    //    Payload: { update: number[] } (JSON-safe, ricostruito in Uint8Array).
    this.channel.on("broadcast", { event: "update" }, ({ payload }) => {
      try {
        const arr = (payload as { update?: number[] }).update;
        if (!arr || !Array.isArray(arr) || arr.length === 0) {
          console.warn("[SupabaseYjsProvider] broadcast payload vuoto/malformato, skip.");
          return;
        }
        const bytes = new Uint8Array(arr as number[]);
        // Origin = this → ANTI-LOOP NATIVO Yjs:
        // il listener ydoc.on('update') più sotto NON re-invia.
        Y.applyUpdate(this.ydoc, bytes, this);
      } catch (err) {
        console.error("[SupabaseYjsProvider] applyUpdate da broadcast fallito:", err);
      }
    });

    // 3. Listener per update locali → broadcast + persist in tabella.
    //    Origin check: skip se origin === this (era un update remoto appena
    //    applicato — altrimenti A→A loop via broadcast-self).
    this.ydocUpdateHandler = (update: Uint8Array, origin: unknown) => {
      if (origin === this) return; // anti-loop nativo Yjs

      // Broadcast live (supabase-js serializza in JSON → Array.from è obbligatorio
      // perché Uint8Array non è direttamente JSON-serializzabile).
      //
      // NOTA: `channel.send` è SYNC in supabase-js v2 (ritorna `this` per chaining).
      // Errori di invio vengono riportati come stato `CHANNEL_ERROR` nella callback
      // di `subscribe`, non come eccezione qui. Quindi niente .catch().
      try {
        this.channel?.send({
          type: "broadcast",
          event: "update",
          payload: { update: Array.from(update) },
        });
      } catch (err) {
        console.warn("[SupabaseYjsProvider] broadcast send fallito:", err);
      }

      // Persisti in tabella (offline storage per peer offline).
      // supabase-js accetta Uint8Array direttamente per BYTEA (converte in
      // base64 sul wire). NON usare Array.from() qui — sarebbe rifiutato
      // dal type system Postgres (JSON array ≠ bytea).
      this.client
        .from(SYNC_CONFIG.supabase.updatesTable)
        .insert({
          room_name: SYNC_CONFIG.supabase.roomName,
          update_bytes: update, // Uint8Array → base64 wire
        })
        .then(({ error }) => {
          if (error) {
            console.warn(
              "[SupabaseYjsProvider] insert yjs_updates fallito:",
              error.message
            );
          }
        });
    };
    this.ydoc.on("update", this.ydocUpdateHandler);

    // 4. Subscribe al canale (apre WebSocket).
    //
    // `channel.subscribe(callback)` ritorna il channel stesso (chainable, NON
    // una Promise). Per ottenere una Promise che risolve quando il channel è
    // attivo, lo wrappiamo manualmente. Aggiungiamo un timeout 15s per evitare
    // di rimanere in pending per sempre se Supabase è irraggiungibile.
    await new Promise<void>((resolve, reject) => {
      if (!this.channel) {
        reject(new Error("channel non inizializzato"));
        return;
      }
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(
            new Error("Supabase channel subscribe timeout (15s) — URL/key errati o rete down?")
          );
        }
      }, 15000);
      this.channel!.subscribe((status: string) => {
        if (settled) return;
        if (status === "SUBSCRIBED") {
          settled = true;
          clearTimeout(timeout);
          resolve();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          settled = true;
          clearTimeout(timeout);
          reject(new Error(`Supabase channel ${status}`));
        }
        // 'CLOSED' non reject (può succedere su disconnect intenzionale)
      });
    });

    this.connected = true;
    this.notifyStatusChange();

    // 5. Sync iniziale: scarica update accumulati offline.
    try {
      const n = await this.syncFromOffline();
      if (n > 0) {
        console.info(
          `[SupabaseYjsProvider] syncFromOffline: ${n} update recuperati (last_seen_id=${this.lastSeenId}).`
        );
      }
    } catch (err) {
      // syncFromOffline failure is NOT fatal — il canale live è già attivo.
      console.warn("[SupabaseYjsProvider] syncFromOffline fallito (non blocking):", err);
    }
  }

  async disconnect(): Promise<void> {
    if (this.ydocUpdateHandler) {
      this.ydoc.off("update", this.ydocUpdateHandler);
      this.ydocUpdateHandler = null;
    }
    if (this.channel) {
      this.client.removeChannel(this.channel);
      this.channel = null;
    }
    if (this.connected) {
      this.connected = false;
      this.notifyStatusChange();
    }
  }

  async syncFromOffline(): Promise<number> {
    // Scarica tutti gli update con id > lastSeenId, in ordine crescente.
    // Safety limit 1000: se il peer è offline da molto, evita di scaricare
    // decine di migliaia di update in un colpo solo. Al successivo boot
    // riprende da dove ha lasciato.
    const { data, error } = await this.client
      .from(SYNC_CONFIG.supabase.updatesTable)
      .select("id, update_bytes")
      .eq("room_name", SYNC_CONFIG.supabase.roomName)
      .gt("id", this.lastSeenId)
      .order("id", { ascending: true })
      .limit(1000);

    if (error) {
      console.warn(
        "[SupabaseYjsProvider] SELECT yjs_updates fallito:",
        error.message
      );
      return 0;
    }
    if (!data || data.length === 0) return 0;

    let applied = 0;
    let maxId = this.lastSeenId;
    for (const row of data) {
      try {
        // row.update_bytes torna come Uint8Array (default supabase-js per bytea)
        // — fallback a base64 string per retrocompatibilità con vecchie versioni.
        let bytes: Uint8Array;
        const raw = row.update_bytes as unknown;
        if (raw instanceof Uint8Array) {
          bytes = raw;
        } else if (typeof raw === "string") {
          // Vecchia rappresentazione base64 — decodifica.
          const bin = atob(raw);
          bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        } else if (Array.isArray(raw)) {
          // Vecchia rappresentazione JSON array (fallback).
          bytes = new Uint8Array(raw as number[]);
        } else {
          console.warn(
            "[SupabaseYjsProvider] update_bytes tipo non riconosciuto, skip riga:",
            typeof raw
          );
          continue;
        }
        // Origin = this → ANTI-LOOP: il listener ydoc.on('update') NON
        // re-broadcast (altrimenti ogni sync offline genererebbe un echo
        // a tutti i peer online).
        Y.applyUpdate(this.ydoc, bytes, this);
        if (row.id > maxId) maxId = row.id;
        applied++;
      } catch (err) {
        console.error(
          `[SupabaseYjsProvider] applyUpdate fallito per riga id=${row.id}:`,
          err
        );
      }
    }

    if (maxId > this.lastSeenId) {
      this.lastSeenId = maxId;
      try {
        localStorage.setItem("yjs_supabase_last_seen_id", String(this.lastSeenId));
      } catch {
        // localStorage non disponibile — lastSeenId non persistito, al prossimo
        // boot ripartirà da 0 e riapplicherà (idempotenza CRDT garantisce merge).
      }
    }

    return applied;
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
