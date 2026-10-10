import { useEffect, useState } from "react";
import { RosaView } from "@/components/RosaView";
import { PlayerOSWindow } from "@/components/PlayerOSWindow";
import { useDbMetaStore } from "@/stores/useDbMetaStore";
import { useDbStore } from "@/stores/useDbStore";
import { api } from "@/api/tauri";

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
 */
export function App() {
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const refreshMeta = useDbMetaStore((s) => s.refresh);
  const refreshDbs = useDbStore((s) => s.refresh);
  const restoreFromLocalStorage = useDbStore((s) => s.restoreFromLocalStorage);

  // M2.1 B5 — Rileva se siamo in una finestra OS nativa via pathname.
  // Tauri 2 carica la stessa app (dist/index.html) per tutte le finestre,
  // ma il pathname distingue: "/" = main, "/player/:id" = finestra OS.
  const path = typeof window !== "undefined" ? window.location.pathname : "/";
  const playerMatch = path.match(/^\/player\/([^/]+)/);
  const osPlayerId = playerMatch ? playerMatch[1] : null;

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
          DossierFanta v2.3 · M2.1
        </div>
        <div className="text-xs mt-1" style={{ fontFamily: "var(--font-body)", color: "var(--ink-soft)" }}>
          Inizializzazione DB locale + workspace multi-DB…
        </div>
      </div>
    );
  }

  return <RosaView />;
}
