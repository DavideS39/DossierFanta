import { usePlayersStore } from "@/stores/usePlayersStore";
import { PlayerCard } from "./PlayerCard";

interface Props {
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}

/**
 * Lista giocatori come griglia di card responsive.
 * Stati gestiti: loading, error, empty, populated.
 */
export function PlayerList({ onEdit, onDelete }: Props) {
  const players = usePlayersStore((s) => s.players);
  const loading = usePlayersStore((s) => s.loading);
  const error = usePlayersStore((s) => s.error);
  const selectedId = usePlayersStore((s) => s.selectedId);
  const setSelectedId = usePlayersStore((s) => s.setSelectedId);

  if (loading && players.length === 0) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="font-body text-ink-soft text-sm">
          <span className="inline-block w-4 h-4 border-2 border-ink/30 border-t-ink rounded-full animate-spin mr-2 align-middle" />
          Caricamento giocatori…
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red/10 border border-red/40 text-red px-4 py-3 rounded m-4 font-body text-sm">
        <strong>Errore caricamento:</strong> {error}
      </div>
    );
  }

  if (players.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 px-6 text-center">
        <div className="text-5xl mb-3 opacity-40" aria-hidden>
          📓
        </div>
        <h3 className="font-display text-lg text-ink mb-1">Nessun giocatore</h3>
        <p className="font-body text-sm text-ink-soft max-w-md">
          La rosa è vuota. Crea il tuo primo giocatore con il pulsante "Nuovo giocatore"
          in alto a destra. L'app funziona completamente offline: il DB SQLite locale
          viene creato automaticamente al primo avvio.
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 p-4">
      {players.map((p) => (
        <PlayerCard
          key={p.id}
          player={p}
          selected={selectedId === p.id}
          onSelect={() => setSelectedId(p.id)}
          onEdit={() => onEdit(p.id)}
          onDelete={() => onDelete(p.id)}
        />
      ))}
    </div>
  );
}
