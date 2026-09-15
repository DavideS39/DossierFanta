import { usePlayersStore } from "@/stores/usePlayersStore";
import { useDbMetaStore } from "@/stores/useDbMetaStore";
import { useDbStore } from "@/stores/useDbStore";

/**
 * Barra superiore con statistiche: numero giocatori totali, filtrati,
 * archiviati, path DB, versione schema, DB attivo. Aggiornata
 * automaticamente dallo store.
 *
 * M2: mostra anche il numero di DB logici caricati nel workspace.
 */
export function StatsBar() {
  const players = usePlayersStore((s) => s.players);
  const totalCount = usePlayersStore((s) => s.totalCount);
  const lastUpdated = usePlayersStore((s) => s.lastUpdated);
  const meta = useDbMetaStore((s) => s.info);
  const databases = useDbStore((s) => s.databases);

  return (
    <div
      className="px-4 py-2 flex items-center gap-4 flex-wrap text-xs text-ink-soft"
      style={{
        fontFamily: "var(--font-body)",
        backgroundColor: "var(--paper-dim)",
        borderBottom: "1px solid rgba(43, 27, 18, 0.2)",
      }}
    >
      <Stat label="Visualizzati" value={players.length} />
      <Stat label="Totale (con filtri)" value={totalCount} />
      {meta && (
        <>
          <Stat label="Archiviati" value={meta.archived_count} />
          <Stat label="DB logici" value={databases.length} />
          <div className="hidden sm:flex items-center gap-1">
            <span className="uppercase tracking-wider">Attivo:</span>
            <code
              className="px-1.5 py-0.5 truncate max-w-xs"
              style={{
                backgroundColor: "var(--paper)",
                color: "var(--ink)",
                border: "1px solid rgba(43, 27, 18, 0.2)",
                fontFamily: "var(--font-display)",
              }}
              title={meta.db_path}
            >
              {meta.active_db_name}
            </code>
            <span className="text-ink-soft/60">·</span>
            <span>schema v{meta.schema_version}</span>
          </div>
        </>
      )}
      {lastUpdated && (
        <div className="ml-auto text-ink-soft/60">
          Aggiornato: {new Date(lastUpdated).toLocaleTimeString("it-IT")}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="uppercase tracking-wider">{label}:</span>
      <span className="font-bold text-ink">{value}</span>
    </div>
  );
}
