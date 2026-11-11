// src/lib/sync/SyncManager.ts — M3a.3 Deliverable 1.
//
// Gestore multi-provider: registra e coordina N SyncProvider simultaneamente
// sullo stesso Y.Doc singleton. Per M3a.3 due provider attivi:
//   1. SupabaseYjsProvider (primary, sempre attivo, relay + offline storage)
//   2. IrohYjsProvider (secondary, p2p diretto, low latency)
//
// Yjs gestisce i duplicati automaticamente (CRDT idempotente): se entrambi
// i provider recapitano lo stesso update, `Y.applyUpdate` è no-op sul
// secondo (state vector match).
//
// RESPONSABILITÀ:
//  - Boot: connectAll() → syncAllFromOffline() (in parallelo)
//  - Cleanup: disconnectAll() su chiusura app
//  - Status reporting: getConnectedProviders() per UI SyncView
//
// NON responsabilità:
//  - Applicare gli update al Y.Doc (lo fa ogni provider nel suo listener)
//  - Persistere su SQLite (lo fanno i listener yPlayers.observe in yjsDocuments)
//  - Anti-loop: gestito dal parametro `origin` di Yjs (vedi yjsDocuments)

import type { SyncProvider } from "./SyncProvider";
import { ydoc } from "./yjsDocuments";

/**
 * Manager multi-provider. Singleton (un'istanza per app, vedi esportazione
 * `syncManager` in fondo al file).
 */
export class SyncManager {
  private providers: Map<string, SyncProvider> = new Map();

  /**
   * @param ydoc Riferimento al Y.Doc singleton. Accettato per API simmetria
   * (pass-through al costruttore — non usato direttamente perché ogni provider
   * ha il proprio riferimento nel suo costruttore). Rimane disponibile come
   * hook futuro (es. getter `getYDoc()` per il debug).
   */
  constructor(_ydoc: Y.Doc) {
    // Conservato per simmetria API; in TS il prefisso `_` segnala "intentionally unused".
    // Verificato con `tsc --noEmit`: con noUnusedParameters + noUnusedLocals
    // di default TS non segnala i parametri prefissati con `_`.
  }

  /**
   * Registra un provider. Se ne esiste già uno con lo stesso `name`, viene
   * ignorato (idempotente — supporta re-init sicuro su app reload).
   */
  addProvider(provider: SyncProvider): void {
    if (this.providers.has(provider.name)) {
      console.warn(
        `[SyncManager] provider '${provider.name}' già registrato, skip.`
      );
      return;
    }
    this.providers.set(provider.name, provider);
  }

  /**
   * Avvia la connessione di tutti i provider registrati, in parallelo.
   * Usa `Promise.allSettled` così se un provider fallisce (es. Iroh offline),
   * gli altri continuano (Supabase basta per il sync).
   *
   * Vincolo HARD #21: Iroh è opzionale — se non disponibile, Supabase basta.
   */
  async connectAll(): Promise<void> {
    const results = await Promise.allSettled(
      Array.from(this.providers.values()).map((p) =>
        p.connect().catch((err) => {
          console.warn(
            `[SyncManager] provider '${p.name}' connect fallito:`,
            err
          );
          // Non rilanciare: un provider fallito non deve bloccare gli altri.
        })
      )
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const fail = results.length - ok;
    console.info(
      `[SyncManager] connectAll: ${ok} ok, ${fail} falliti su ${results.length} totali.`
    );
  }

  /**
   * Disconnette tutti i provider (su cleanup / chiusura app).
   */
  async disconnectAll(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.providers.values()).map((p) =>
        p.disconnect().catch((err) => {
          console.warn(
            `[SyncManager] provider '${p.name}' disconnect fallito:`,
            err
          );
        })
      )
    );
  }

  /**
   * Esegue il sync offline iniziale di tutti i provider. Per Supabase
   * significa scaricare gli update accumulati mentre eri offline.
   * Per Iroh è no-op (live-only).
   */
  async syncAllFromOffline(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.providers.values()).map(async (p) => {
        try {
          const n = await p.syncFromOffline();
          if (n > 0) {
            console.info(
              `[SyncManager] provider '${p.name}' ha applicato ${n} update offline.`
            );
          }
        } catch (err) {
          console.warn(
            `[SyncManager] provider '${p.name}' syncFromOffline fallito:`,
            err
          );
        }
      })
    );
  }

  /**
   * Esegue il cleanup di tutti i provider che lo supportano (opzionale).
   */
  async cleanupAll(olderThanDays: number): Promise<void> {
    await Promise.allSettled(
      Array.from(this.providers.values()).map(async (p) => {
        if (!p.cleanup) return;
        try {
          await p.cleanup(olderThanDays);
        } catch (err) {
          console.warn(
            `[SyncManager] provider '${p.name}' cleanup fallito:`,
            err
          );
        }
      })
    );
  }

  /**
   * Recupera un provider per nome (es. per azioni specifiche tipo
   * `connectToSavedPeers` di Iroh).
   */
  getProvider<T extends SyncProvider = SyncProvider>(
    name: string
  ): T | undefined {
    return this.providers.get(name) as T | undefined;
  }

  /**
   * Lista dei nomi dei provider attualmente connessi. Usato dalla UI
   * SyncView per mostrare "● Supabase: connesso · ● Iroh: 1 peer".
   */
  getConnectedProviders(): string[] {
    return Array.from(this.providers.entries())
      .filter(([, p]) => p.isConnected)
      .map(([name]) => name);
  }

  /**
   * Stato aggregato: true se ALMENO un provider è connesso. Se nessuno è
   * connesso, il sync è offline totale — modifiche bufferizzate localmente
   * (Supabase le recupererà al prossimo boot).
   */
  hasAnyConnected(): boolean {
    for (const p of this.providers.values()) {
      if (p.isConnected) return true;
    }
    return false;
  }
}

// ------------------------------------------------------------
// Singleton (un'istanza per app, condivisa tra App.tsx e SyncView)
// ------------------------------------------------------------

import type * as Y from "yjs";

/**
 * Singleton SyncManager. Inizializzato da App.tsx al boot:
 *   1. Crea l'istanza con il Y.Doc singleton.
 *   2. Registra SupabaseYjsProvider (sempre).
 *   3. Registra IrohYjsProvider (se peer_key salvata).
 *   4. connectAll() → syncAllFromOffline().
 */
let _instance: SyncManager | null = null;

export function getSyncManager(): SyncManager {
  if (!_instance) {
    _instance = new SyncManager(ydoc);
  }
  return _instance;
}

/**
 * Reset per test (NON usare in produzione).
 */
export function _resetSyncManagerForTests(): void {
  _instance = null;
}
