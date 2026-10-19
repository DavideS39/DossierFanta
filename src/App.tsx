import { useEffect, useRef, useState } from "react";
import { RosaView } from "@/components/RosaView";
import { PlayerOSWindow } from "@/components/PlayerOSWindow";
import { useDbMetaStore } from "@/stores/useDbMetaStore";
import { useDbStore } from "@/stores/useDbStore";
import { usePlayersStore } from "@/stores/usePlayersStore";
import { useAutoFetchStore } from "@/stores/useAutoFetchStore";
import { api, isDesktop } from "@/api/tauri";
// M2.2 — FIX A2 (F12): hook per sync live tra finestre. Quando il backend
// emette `player-updated` (dopo save_scouting_note/save_auction_data/
// set_player_status/assign_player), la main window refresha usePlayersStore
// (lista Rosa) senza intervento manuale. La finestra OS ha il suo listener
// interno in PlayerOSWindow per refreshare il singolo player corrente.
import { usePlayerSync } from "@/lib/usePlayerSync";
// M3a.3 — Sync boot al root: initYjsBridge + SyncManager con provider
// Supabase + Iroh. Il listener `sync-update-received` è registrato qui (NON
// nel SyncView) così sopravvive alla chiusura del modal. Se l'utente non
// apre mai il modal, il sync live continua a funzionare in background.
import { initYjsBridge, ydoc } from "@/lib/sync/yjsDocuments";
import { startCursorsCleanup, stopCursorsCleanup } from "@/lib/sync/yjsCursors";
import { getSyncManager } from "@/lib/sync/SyncManager";
import { SupabaseYjsProvider } from "@/lib/sync/SupabaseYjsProvider";
import { IrohYjsProvider } from "@/lib/sync/IrohYjsProvider";

/**
 * App root. Avvia l'inizializzazione del DB al primo render.
 * Mostra uno splash screen mentre il DB non è pronto.
 *
 * M2.1 B5 — Multi-window OS nativa: quando il pathname inizia con `/player/`,
 * l'app è stata caricata dentro una finestra OS nativa (creata da
 * `api.openPlayerWindow(player_id)`). Estraiamo il player_id e renderizziamo
 * `PlayerOSWindow` invece di `RosaView`. Questo evita che la finestra OS
 * appaia bianca (perché manca il router frontend per la route `/player/:id`).
 *
 * M2: inizializza anche lo store multi-DB (useDbStore) oltre al meta store.
 *
 * M2.2 — FIX A2 (F12): la main window (path "/") sottoscrive l'evento
 * `player-updated`. Quando l'utente modifica una scheda nella finestra OS
 * (o nella WM in-app), la main window refresha la lista Rosa + i metadati DB
 * (conteggi). In finestra OS il listener è no-op (delega a PlayerOSWindow).
 *
 * M3a.3 — SYNC BOOT AL ROOT (gap 1 + gap 2 chiusi):
 *   1. `initYjsBridge()` registra i listener `yPlayers.observe` etc. che
 *      persistono gli update remoti su SQLite (con updated_by='sync-live').
 *   2. `startCursorsCleanup()` rimuove cursori collaborativi stale (>30s).
 *   3. `getSyncManager()` istanzia il manager singleton.
 *   4. Registra `SupabaseYjsProvider` (sempre attivo, relay + offline storage).
 *   5. Se `getSyncIdentity()` ritorna Some (peer_key salvata), registra
 *      anche `IrohYjsProvider` e auto-connette i peer fidati.
 *   6. `connectAll()` avvia entrambi i provider in parallelo.
 *
 * Perché qui e non in SyncView? Perché il modal SyncView può essere chiuso
 * dall'utente. Se il listener `sync-update-received` vive solo nel modal,
 * chiudendolo il sync live smette di funzionare. Al root sopravvive sempre.
 */
export function App() {
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const refreshMeta = useDbMetaStore((s) => s.refresh);
  const refreshDbs = useDbStore((s) => s.refresh);
  const restoreFromLocalStorage = useDbStore((s) => s.restoreFromLocalStorage);
  // M2.2 — FIX A2: refresh lista Rosa su evento player-updated.
  const refreshPlayers = usePlayersStore((s) => s.refresh);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // M2.1 B5 — Rileva se siamo in una finestra OS nativa via pathname.
  // Tauri 2 carica la stessa app (dist/index.html) per tutte le finestre,
  // ma il pathname distingue: "/" = main, "/player/:id" = finestra OS.
  const path = typeof window !== "undefined" ? window.location.pathname : "/";
  const playerMatch = path.match(/^\/player\/([^/]+)/);
  const osPlayerId = playerMatch ? playerMatch[1] : null;

  // M2.2 — FIX A2: sottoscrivi player-updated (sempre attivo, per le rules
  // of hooks). In finestra OS il callback è no-op (delega a PlayerOSWindow).
  // Debounce 150ms: se l'utente fa 3 modifiche ravvicinate (es. 3 note
  // scouting in 100ms), refreshiamo una sola volta invece di 3.
  usePlayerSync(null, () => {
    // Skip in finestra OS — PlayerOSWindow ha il suo listener interno.
    // osPlayerId è fisso per finestra (Tauri non naviga via pathname).
    if (osPlayerId) return;
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      void refreshPlayers();
      void refreshMeta();
    }, 150);
  });

  useEffect(() => {
    let cancelled = false;
    // M3a.3 — Cleanup handle per sync boot (initYjsBridge + cursors + providers).
    let syncCleanup: (() => void) | null = null;
    (async () => {
      try {
        // Inizializza DB (idempotente: crea file + applica schema se primo avvio)
        await api.initDb();
        // M2.1 — FIX A4 (A8): ripristina il DB attivo da localStorage PRIMA
        // di refreshMeta + refreshDbs. Il backend imposta il DB attivo e
        // refreshDbs leggerà quello giusto. Sopravvive al riavvio dell'app.
        // Skip se siamo in finestra OS nativa (non serve il refresh completo).
        if (!osPlayerId) {
          await restoreFromLocalStorage();
          await Promise.all([refreshMeta(), refreshDbs()]);

          // M3 — Auto-fetch listone all'avvio (Cap.7 design doc v2.5).
          // Vincolo hard #12: NON auto-applicare. Mostra solo un toast se
          // c'è un nuovo release disponibile. L'utente clicka per aprire la
          // schermata Aggiornamenti e confermare (archiviazione irreversibile).
          //
          // Silent skip su errore di rete: se GitHub è irraggiungibile,
          // nessun toast di errore — l'utente può forzare via schermata.
          // Skip anche in finestra OS nativa (non ha senso notificare lì).
          void checkListoneOnBoot();

          // M3a.3 — SYNC BOOT AL ROOT. Skip in anteprima web (isDesktop=false)
          // e in finestra OS nativa (sync live vive solo nella main window).
          if (isDesktop) {
            try {
              syncCleanup = await bootSync();
            } catch (err) {
              // Non bloccare il boot se il sync init fallisce — l'app
              // continua a funzionare offline. Log + mostra warning in UI.
              console.warn("[M3a.3] bootSync fallito (non blocking):", err);
            }
          }
        }
        if (!cancelled) setBooting(false);
      } catch (e) {
        if (!cancelled) {
          setBootError(e instanceof Error ? e.message : String(e));
          setBooting(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      if (syncCleanup) syncCleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshMeta, refreshDbs, restoreFromLocalStorage, osPlayerId]);

  /**
   * M3a.3 + M3a.4 — Sync boot al root.
   *
   * Passi:
   *   1. initYjsBridge() — registra listener yPlayers/yNotes/yAuction che
   *      persistono gli update remoti su SQLite (updated_by='sync-live').
   *   2. startCursorsCleanup() — timer 5s che rimuove cursori >30s stale.
   *   3. getSyncManager() — singleton manager.
   *   4. addProvider(SupabaseYjsProvider) — sempre attivo. Multi-room
   *      per-pairing encryption: carica i pairings da sync_pairings e
   *      subscribe a ogni room_name derivato da ECDH shared_secret.
   *   5. getSyncIdentity() — se Some (peer_key salvata in sync_identity),
   *      addProvider(IrohYjsProvider) + auto-connect trusted peers.
   *   6. connectAll() — avvia entrambi i provider in parallelo.
   *
   * Ritorna cleanup function da chiamare su unmount.
   */
  async function bootSync(): Promise<() => void> {
    const cleanupYjs = initYjsBridge();
    startCursorsCleanup();

    const syncManager = getSyncManager();
    // M3a.4 — SupabaseYjsProvider carica i pairings da sync_pairings
    // internamente al connect(). 0 pairings → provider "connesso" ma
    // no-op finché l'utente non completa il primo pairing via SyncView.
    syncManager.addProvider(new SupabaseYjsProvider(ydoc));

    // Auto-avvia Iroh SOLO se esiste già una peer_key salvata in sync_identity.
    // Se è il primo boot (nessun sync_identity), l'utente deve avviare Iroh
    // manualmente dal SyncView (così vede la sua peer_key e la condivide).
    let irohProvider: IrohYjsProvider | null = null;
    try {
      const identity = await api.getSyncIdentity();
      if (identity) {
        irohProvider = new IrohYjsProvider(ydoc);
        syncManager.addProvider(irohProvider);
      }
    } catch (err) {
      // getSyncIdentity può fallire se sync_identity table non esiste ancora
      // (DB pre-v2.4). Non bloccare — Supabase basta per il sync.
      console.warn("[M3a.3] getSyncIdentity skip:", err);
    }

    // connectAll avvia i provider in parallelo (Promise.allSettled). Non
    // blocca il boot se uno fallisce. SyncFromOffline è chiamato dentro
    // connect() di ogni provider.
    await syncManager.connectAll();

    // Auto-connect trusted peers salvati (se Iroh è attivo).
    // M3a.3 — auto-connect dei peer fidati (sync_peers trusted=1) per Iroh.
    // M3a.4 — il sync cifrato Supabase non ha bisogno di Iroh, ma se Iroh è
    // attivo, ci si connette per la latenza più bassa (~50ms vs ~100ms relay).
    if (irohProvider) {
      try {
        const trusted = await api.listTrustedPeers();
        if (trusted.length > 0) {
          // Fire-and-forget — non blocca. Le connect hanno timeout 10s l'una.
          void irohProvider.connectToSavedPeers(trusted.map((p) => p.peerId));
        }
      } catch (err) {
        console.warn("[M3a.3] listTrustedPeers / connectToSavedPeers skip:", err);
      }
    }

    return () => {
      cleanupYjs();
      stopCursorsCleanup();
      // Disconnect dei provider in background (non attendere — l'app sta
      // chiudendo, il cleanup best-effort è sufficiente).
      void syncManager.disconnectAll();
    };
  }

  /**
   * M3 — Auto-fetch check all'avvio.
   *
   * Passi:
   *   1. check_latest_listone_version() → ritorna {tag, ...}
   *   2. get_autofetch_status() → ritorna {last_applied_tag, ...}
   *   3. Se tag !== last_applied_tag → setNotice("Aggiornamento listone disponibile…")
   *   4. Se uguali → silent skip
   *   5. Se rete/parse fallito → silent skip (nessun toast di errore)
   */
  async function checkListoneOnBoot() {
    try {
      const [latest, status] = await Promise.all([
        api.checkLatestListoneVersion(),
        api.getAutofetchStatus(),
      ]);
      if (!latest || !latest.tag) return;
      if (status.last_applied_tag === latest.tag) {
        // Già aggiornato — silent skip
        return;
      }
      useAutoFetchStore.getState().setNotice(
        `Aggiornamento listone disponibile: ${latest.tag}. Clicca per aprire la schermata Aggiornamenti.`,
        latest.tag,
      );
    } catch (e) {
      // Silent skip: l'app continua a funzionare offline.
      // L'utente può usare la schermata Aggiornamenti per il fallback.
      console.warn("[M3] checkListoneOnBoot skipped:", e);
    }
  }

  // M2.1 B5 — Se siamo in finestra OS nativa, renderizza PlayerOSWindow
  // dopo che il DB è inizializzato.
  if (osPlayerId && !booting && !bootError) {
    return <PlayerOSWindow playerId={osPlayerId} />;
  }

  if (bootError) {
    return (
      <div className="min-h-screen tacc-bg flex items-center justify-center p-6">
        <div
          className="max-w-md border-2 p-6"
          style={{ borderColor: "var(--red)", backgroundColor: "var(--paper-dim)" }}
        >
          <h1 className="text-lg font-bold mb-2" style={{ fontFamily: "var(--font-display)", color: "var(--red)" }}>
            Errore di avvio
          </h1>
          <p className="text-sm" style={{ fontFamily: "var(--font-body)", color: "var(--ink)" }}>
            Impossibile inizializzare il database SQLite locale:
          </p>
          <pre
            className="mt-2 text-xs p-2 overflow-x-auto"
            style={{
              fontFamily: "var(--font-body)",
              backgroundColor: "var(--paper)",
              color: "var(--ink-soft)",
              border: "1px solid rgba(43, 27, 18, 0.2)",
            }}
          >
            {bootError}
          </pre>
          <p className="mt-3 text-xs" style={{ fontFamily: "var(--font-body)", color: "var(--ink-soft)" }}>
            Verifica i permessi sulla directory dati dell'app e riprova.
          </p>
        </div>
      </div>
    );
  }

  if (booting) {
    return (
      <div className="min-h-screen tacc-bg flex flex-col items-center justify-center p-6">
        <div
          className="w-14 h-14 border-4 rounded-full animate-spin"
          style={{
            borderColor: "rgba(43, 27, 18, 0.2)",
            borderTopColor: "var(--ink)",
          }}
        />
        <div className="mt-4 text-lg" style={{ fontFamily: "var(--font-display)", color: "var(--ink)" }}>
          DossierFanta v2.5 · M3a.3
        </div>
        <div className="text-xs mt-1" style={{ fontFamily: "var(--font-body)", color: "var(--ink-soft)" }}>
          Inizializzazione DB locale + workspace multi-DB + auto-fetch listone + sync live…
        </div>
      </div>
    );
  }

  return <RosaView />;
}
