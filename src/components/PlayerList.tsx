import { useEffect, useState } from "react";
import { usePlayersStore } from "@/stores/usePlayersStore";
import { useDbStore } from "@/stores/useDbStore";
import { PlayerCardTaccuino } from "./PlayerCardTaccuino";
import { api } from "@/api/tauri";
import type { ArchivedPlayer, Player } from "@/types/player";

interface Props {
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}

/**
 * Lista giocatori come griglia di card Taccuino (M2 redesign).
 * Stati gestiti: loading, error, empty, populated.
 *
 * Sostituito l'emoji 📓 M1 con glyph ▤ (righe quaderno).
 *
 * M2: quando `includeArchive === true` nel playersStore, fetcha anche
 * gli archived e li mostra in fondo con badge ARCHIVIATO rosso sbiadito
 * e read-only (nessun onEdit/onDelete).
 *
 * Mostra chip DB provenienza quando il filtro DB è "all" e il giocatore
 * appartiene a un DB diverso dal attivo.
 */
export function PlayerList({ onEdit, onDelete }: Props) {
  const players = usePlayersStore((s) => s.players);
  const loading = usePlayersStore((s) => s.loading);
  const error = usePlayersStore((s) => s.error);
  const selectedId = usePlayersStore((s) => s.selectedId);
  const setSelectedId = usePlayersStore((s) => s.setSelectedId);
  const includeArchive = usePlayersStore((s) => s.includeArchive);
  const dbFilter = usePlayersStore((s) => s.dbFilter);
  const search = usePlayersStore((s) => s.search);
  const roleFilter = usePlayersStore((s) => s.roleFilter);

  const activeDbId = useDbStore((s) => s.activeId);
  const databases = useDbStore((s) => s.databases);

  // Stato locale per archived (fetch parallelo quando toggle ON)
  const [archived, setArchived] = useState<ArchivedPlayer[]>([]);

  useEffect(() => {
    if (!includeArchive) {
      setArchived([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const list = await api.listArchivedPlayers(
          search.trim() || undefined,
          roleFilter ?? undefined,
        );
        if (!cancelled) setArchived(list);
      } catch {
        if (!cancelled) setArchived([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [includeArchive, search, roleFilter]);

  const dbLabelFor = (playerDbId: string): string | null => {
    if (dbFilter !== "all") return null;
    if (!activeDbId) return null;
    if (playerDbId === activeDbId) return null;
    const meta = databases.find((d) => d.id === playerDbId);
    return meta?.name ?? playerDbId.slice(0, 8);
  };

  // Convert ArchivedPlayer → Player-like for the card (mappa i campi minimi)
  const archivedAsPlayers: Player[] = archived.map((a) => {
    const last = (a.last_known_data ?? {}) as Partial<Player>;
    return {
      id: a.id,
      db_id: a.db_id,
      name: a.name,
      team: a.team,
      pos_fanta: a.pos_fanta as Player["pos_fanta"],
      pos_real: a.pos_real,
      status: "totali" as Player["status"], // archived non ha status, usiamo totali come fallback
      fascia: last.fascia ?? null,
      priority: last.priority ?? 0,
      fmil_spesi: last.fmil_spesi ?? null,
      med: last.med ?? null,
      medv: last.medv ?? null,
      fvm: last.fvm ?? null,
      updated_at: a.archived_at,
      updated_by: null,
    };
  });

  const total = players.length + archivedAsPlayers.length;

  if (loading && total === 0) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-ink-soft text-sm" style={{ fontFamily: "var(--font-body)" }}>
          <span className="inline-block w-4 h-4 border-2 border-ink/30 border-t-ink rounded-full animate-spin mr-2 align-middle" />
          Caricamento giocatori…
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red/10 border border-red/40 text-red px-4 py-3 m-4 text-sm" style={{ fontFamily: "var(--font-body)" }}>
        <strong>Errore caricamento:</strong> {error}
      </div>
    );
  }

  if (total === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 px-6 text-center">
        <div
          className="text-5xl mb-3 opacity-40 text-ink-soft"
          aria-hidden
          style={{ fontFamily: "var(--font-display)" }}
        >
          ▤
        </div>
        <h3 className="text-lg text-ink mb-1" style={{ fontFamily: "var(--font-display)" }}>
          Nessun giocatore
        </h3>
        <p className="text-sm text-ink-soft max-w-md" style={{ fontFamily: "var(--font-body)" }}>
          La rosa è vuota. Crea il tuo primo giocatore con il pulsante «Nuovo giocatore»
          in alto a destra, oppure importa un listone Serie A per popolare
          automaticamente la rosa. L'app funziona completamente offline.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 p-4">
        {players.map((p) => (
          <PlayerCardTaccuino
            key={p.id}
            player={p}
            selected={selectedId === p.id}
            onSelect={() => setSelectedId(p.id)}
            onEdit={() => onEdit(p.id)}
            onDelete={() => onDelete(p.id)}
            dbLabel={dbLabelFor(p.db_id)}
          />
        ))}
        {includeArchive && archivedAsPlayers.length > 0 && (
          archivedAsPlayers.map((p) => (
            <PlayerCardTaccuino
              key={`arch-${p.id}`}
              player={p}
              selected={false}
              onSelect={() => {
                /* no-op: archived is read-only */
              }}
              onEdit={() => {
                /* no-op: archived is read-only */
              }}
              onDelete={() => {
                /* no-op: archived is read-only */
              }}
              archived
              dbLabel={dbLabelFor(p.db_id)}
            />
          ))
        )}
      </div>
      {includeArchive && archivedAsPlayers.length > 0 && (
        <div className="px-4 pb-4 text-xs text-ink-soft" style={{ fontFamily: "var(--font-body)" }}>
          » {archivedAsPlayers.length} giocatori archiviati mostrati come read-only
          (badge ARCHIVIATO rosso sbiadito). Vedi vista Archivio per ripristinare.
        </div>
      )}
    </div>
  );
}
