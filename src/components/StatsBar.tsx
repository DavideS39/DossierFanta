import { usePlayersStore } from "@/stores/usePlayersStore";
import { useDbMetaStore } from "@/stores/useDbMetaStore";

/**
 * Barra superiore con statistiche: numero giocatori totali, filtrati,
 * archiviati, path DB, versione schema. Aggiornata automaticamente dallo store.
 */
export function StatsBar() {
  const players = usePlayersStore((s) => s.players);
  const totalCount = usePlayersStore((s) => s.totalCount);
  const lastUpdated = usePlayersStore((s) => s.lastUpdated);
  const meta = useDbMetaStore((s) => s.info);

  return (
    <div className="bg-paper-dim border-b border-ink/20 px-4 py-2 flex items-center gap-4 flex-wrap font-body text-xs text-ink-soft">
      <Stat label="Visualizzati" value={players.length} />
      <Stat label="Totale (con filtri)" value={totalCount} />
      {meta && (
        <>
          <Stat label="Archiviati" value={meta.archived_count} />
          <div className="hidden sm:flex items-center gap-1">
            <span className="uppercase tracking-wider">DB:</span>
            <code className="bg-paper px-1.5 py-0.5 rounded border border-ink/20 text-ink truncate max-w-xs" title={meta.db_path}>
              {meta.default_db_name}
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
