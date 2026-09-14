import { useEffect, useState } from "react";
import { RosaView } from "@/components/RosaView";
import { useDbMetaStore } from "@/stores/useDbMetaStore";
import { api } from "@/api/tauri";

/**
 * App root. Avvia l'inizializzazione del DB al primo render.
 * Mostra uno splash screen mentre il DB non è pronto.
 */
export function App() {
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const refreshMeta = useDbMetaStore((s) => s.refresh);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Inizializza DB (idempotente: crea file + applica schema se primo avvio)
        await api.initDb();
        // Recupera metadati (popola DbMetaStore)
        await refreshMeta();
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
  }, [refreshMeta]);

  if (bootError) {
    return (
      <div className="min-h-screen bg-paper flex items-center justify-center p-6">
        <div className="max-w-md bg-paper-dim border-2 border-red rounded-lg p-6">
          <h1 className="font-display text-lg text-red font-bold mb-2">
            Errore di avvio
          </h1>
          <p className="font-body text-ink text-sm">
            Impossibile inizializzare il database SQLite locale:
          </p>
          <pre className="mt-2 text-xs text-ink-soft font-mono bg-paper p-2 rounded border border-ink/20 overflow-x-auto">
            {bootError}
          </pre>
          <p className="mt-3 text-xs text-ink-soft">
            Verifica i permessi sulla directory dati dell'app e riprova.
          </p>
        </div>
      </div>
    );
  }

  if (booting) {
    return (
      <div className="min-h-screen bg-paper flex flex-col items-center justify-center p-6">
        <div className="w-14 h-14 border-4 border-ink/20 border-t-ink rounded-full animate-spin" />
        <div className="mt-4 font-display text-ink text-lg">
          DossierFanta v2.2
        </div>
        <div className="font-body text-ink-soft text-xs mt-1">
          Inizializzazione DB locale…
        </div>
      </div>
    );
  }

  return <RosaView />;
}
