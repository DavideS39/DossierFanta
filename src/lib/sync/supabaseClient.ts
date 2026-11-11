// src/lib/sync/supabaseClient.ts — M3a.5 — Singleton Supabase client
// per la tabella `pairings` (rendezvous 8-cifre).
//
// Separato da SupabaseYjsProvider (che ha il suo client interno) perché:
//  - Il provider gestisce i canali Realtime per-room (yjs:<room_name>)
//    e le INSERT/SELECT su yjs_updates (cifrato AES-GCM).
//  - Il pairing flow (SyncView) gestisce la tabella `pairings` (rendezvous)
//    e i canali Realtime `pairing-<code>` (per la risposta del responder).
//
// Stessa istanza client può essere condivisa (supabase-js supporta N canali
// simultanei su una sola WebSocket). Ma per chiarezza architetturale:
//  - supabaseClient (questo file) = pairing flow (SyncView)
//  - SupabaseYjsProvider.client = sync live (per-room)

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SYNC_CONFIG } from "./syncConfig";

let _client: SupabaseClient | null = null;

/**
 * Singleton Supabase client per il pairing flow (tabella `pairings`).
 * Inizializzato lazy alla prima chiamata.
 */
export function getSupabaseClient(): SupabaseClient {
  if (!_client) {
    _client = createClient(
      SYNC_CONFIG.supabase.url,
      SYNC_CONFIG.supabase.anonKey,
      {
        auth: { persistSession: false, autoRefreshToken: false },
        realtime: { params: { eventsPerSecond: 50 } },
      }
    );
  }
  return _client;
}

/**
 * Pulisce i codici pairing scaduti (più vecchi di 5 min).
 * Chiamato periodicamente dal SyncView (es. ogni 60s).
 *
 * Su Supabase, è anche possibile usare una Edge Function schedulata,
 * ma per il caso d'uso amatoriale (2-3 amici) il cleanup client-side
 * è sufficiente.
 */
export async function cleanupExpiredPairings(olderThanMinutes = 5): Promise<void> {
  try {
    const client = getSupabaseClient();
    const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000).toISOString();
    await client
      .from("pairings")
      .delete()
      .lt("created_at", cutoff);
  } catch (err) {
    console.warn("[supabaseClient] cleanupExpiredPairings fallito:", err);
  }
}
