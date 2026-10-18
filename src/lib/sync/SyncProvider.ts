// src/lib/sync/SyncProvider.ts — M3a.3 Deliverable 1.
//
// Astrazione comune per tutti i provider di sync live (M3a.3 — architettura
// multi-canale: Supabase realtime+storage come relay primario, Iroh p2p
// come secondary low-latency).
//
// Domani, per sostituire Supabase con un proprio server self-hosted,
// basta creare un nuovo file `<MioServer>YjsProvider.ts` che implementa
// questa interfaccia e registrarlo nel SyncManager. Tutto il resto
// (Y.Doc, listener, save_*_from_sync, SQLite, UI) resta IDENTICO.
//
// Vincolo HARD #18: Supabase NON è authoritativo. SQLite locale è sempre
// la source of truth. I provider sono solo transport + offline buffer.

/**
 * Interfaccia comune per tutti i provider di sync.
 *
 * Implementazioni concrete:
 *  - `SupabaseYjsProvider` (relay + offline storage)
 *  - `IrohYjsProvider` (p2p diretto low-latency)
 *
 * Entrambi operano sullo stesso `Y.Doc` singleton (vedi `yjsDocuments.ts`).
 * Yjs gestisce i duplicati automaticamente (idempotenza CRDT) — se entrambi
 * i provider recapitano lo stesso update, il merge è no-op.
 */
export interface SyncProvider {
  /**
   * Nome univoco del provider (es. "supabase", "iroh", "custom").
   * Usato come chiave nel SyncManager e per logging UI.
   */
  readonly name: string;

  /**
   * Avvia la connessione. Chiamato una volta al boot dall SyncManager.
   * Deve essere idempotente: se chiamato due volte, la seconda è no-op.
   */
  connect(): Promise<void>;

  /**
   * Disconnette e rilascia risorse (socket, listener, task async).
   * Chiamato su cleanup esplicito (chiusura app, "stop sync" manuale).
   */
  disconnect(): Promise<void>;

  /**
   * Stato corrente della connessione (true se il provider è attivo e
   * può spedire/ricevere update).
   */
  readonly isConnected: boolean;

  /**
   * Sync iniziale: scarica tutti gli update accumulati mentre il peer era
   * offline. Per Supabase significa SELECT da `yjs_updates WHERE id > last_seen`.
   * Per Iroh è no-op (live-only, nessun offline storage).
   *
   * @returns numero di update applicati al Y.Doc locale.
   */
  syncFromOffline(): Promise<number>;

  /**
   * Pulizia del backend: rimuovi record più vecchi di `olderThanDays` dal
   * backend del provider (es. DELETE FROM yjs_updates WHERE created_at < ...).
   *
   * Opzionale — alcuni provider (es. Iroh) non hanno storage lato server.
   */
  cleanup?(olderThanDays: number): Promise<void>;

  /**
   * Registra una callback richiamata quando lo stato connessione cambia.
   * Il SyncManager la usa per aggiornare la UI in tempo reale.
   */
  onStatusChange?(callback: (connected: boolean) => void): void;
}
