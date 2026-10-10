import { usePlayersStore } from "@/stores/usePlayersStore";
import { useDbMetaStore } from "@/stores/useDbMetaStore";
import { useDbStore } from "@/stores/useDbStore";
import { GlossaryTooltip } from "./GlossaryTooltip";

/**
 * Striscia statistiche v2.3.2: conteggi per stato con glyph del design
 * system (✓ scoutati · ? da fare · ○ totali · ▤ archiviati) + barra
 * progress scouting (riempimento verde a tratteggio) + info workspace
 * (DB attivo, schema, orario ultimo aggiornamento).
 *
 * Sostituisce la vecchia barra "Visualizzati/Totale" ridondante: i
 * conteggi per stato sono gli stessi che l'utente vede come timbri
 * sulle cartoline, con tooltip glossario sul significato degli stati.
 */
export function StatsBar() {
  const players = usePlayersStore((s) => s.players);
  const meta = useDbMetaStore((s) => s.info);
  const databases = useDbStore((s) => s.databases);
  const lastUpdated = usePlayersStore((s) => s.lastUpdated);

  const scoutati = players.filter((p) => p.status === "scoutato").length;
  const daFare = players.filter((p) => p.status === "da_fare").length;
  const totali = players.length;
  const pct = totali > 0 ? Math.round((scoutati / totali) * 100) : 0;

  return (
    <div className="df-statsbar" role="status">
      <GlossaryTooltip term="status">
        <span className="df-stat df-stat--scoutato">
          <span className="g" aria-hidden>✓</span>
          <span className="v">{scoutati}</span>
          <span>scoutati</span>
        </span>
      </GlossaryTooltip>

      <GlossaryTooltip term="status">
        <span className="df-stat df-stat--dafare">
          <span className="g" aria-hidden>?</span>
          <span className="v">{daFare}</span>
          <span>da fare</span>
        </span>
      </GlossaryTooltip>

      <span className="df-stat df-stat--totali">
        <span className="g" aria-hidden>○</span>
        <span className="v">{totali}</span>
        <span>in rosa</span>
      </span>

      {meta && (
        <span className="df-stat df-stat--archivio">
          <span className="g" aria-hidden>▤</span>
          <span className="v">{meta.archived_count}</span>
          <span>archiviati</span>
        </span>
      )}

      <span className="df-progress" title="Quota della rosa con almeno una nota scouting">
        <span className="df-progress-track" aria-hidden>
          <span className="df-progress-fill" style={{ width: `${pct}%` }} />
        </span>
        <span className="df-progress-label">scouting {pct}%</span>
      </span>

      <span className="df-right">
        {meta && (
          <>
            <span className="df-dbcode" title={meta.db_path}>
              {meta.active_db_name}
            </span>
            <span>· schema v{meta.schema_version}</span>
            <span>· {databases.length} DB</span>
          </>
        )}
        {lastUpdated && (
          <span>· agg. {new Date(lastUpdated).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}</span>
        )}
      </span>
    </div>
  );
}
