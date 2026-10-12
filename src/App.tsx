import { useEffect, useRef, useState } from "react";
import { RosaView } from "@/components/RosaView";
import { PlayerOSWindow } from "@/components/PlayerOSWindow";
import { useDbMetaStore } from "@/stores/useDbMetaStore";
import { useDbStore } from "@/stores/useDbStore";
import { usePlayersStore } from "@/stores/usePlayersStore";
import { api } from "@/api/tauri";
// M2.2 — FIX A2 (F12): hook per sync live tra finestre. Quando il backend
// emette `player-updated` (dopo save_scouting_note/save_auction_data/
// set_player_status/assign_player), la main window refresha usePlayersStore
// (lista Rosa) senza intervento manuale. La finestra OS ha il suo listener
// interno in PlayerOSWindow per refreshare il singolo player corrente.
import { usePlayerSync } from "@/lib/usePlayerSync";

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
    };
  }, [refreshMeta, refreshDbs, restoreFromLocalStorage, osPlayerId]);

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
          DossierFanta v2.4 · M2.2
        </div>
        <div className="text-xs mt-1" style={{ fontFamily: "var(--font-body)", color: "var(--ink-soft)" }}>
          Inizializzazione DB locale + workspace multi-DB…
        </div>
      </div>
    );
  }

  return <RosaView />;
}
