import { useEffect, useState } from "react";
import { PlayerList } from "@/components/PlayerList";
import { SearchBar } from "@/components/SearchBar";
import { RoleFilter } from "@/components/RoleFilter";
import { StatsBar } from "@/components/StatsBar";
import { PlayerForm } from "@/components/PlayerForm";
import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";
import { usePlayersStore } from "@/stores/usePlayersStore";
import { useDbMetaStore } from "@/stores/useDbMetaStore";
import type { CreatePlayerInput, Player, UpdatePlayerInput } from "@/types/player";

type FormState =
  | { mode: "closed" }
  | { mode: "create" }
  | { mode: "edit"; player: Player };

/**
 * Vista principale M1: Rosa.
 *
 * Layout:
 *   ┌───────────────────────────────────────────────────┐
 *   │ Header: titolo + btn "Nuovo giocatore"              │
 *   │ StatsBar: conteggi, DB info                          │
 *   │ Toolbar: SearchBar | RoleFilter                     │
 *   │ PlayerList: griglia di card                         │
 *   └───────────────────────────────────────────────────┘
 *
 * Modali:
 *   - PlayerForm (create/edit)
 *   - DeleteConfirmDialog (eliminazione esplicita con conferma)
 */
export function RosaView() {
  const refresh = usePlayersStore((s) => s.refresh);
  const createPlayer = usePlayersStore((s) => s.createPlayer);
  const updatePlayer = usePlayersStore((s) => s.updatePlayer);
  const deletePlayer = usePlayersStore((s) => s.deletePlayer);
  const players = usePlayersStore((s) => s.players);
  const refreshMeta = useDbMetaStore((s) => s.refresh);

  const [formState, setFormState] = useState<FormState>({ mode: "closed" });
  const [deleteTarget, setDeleteTarget] = useState<Player | null>(null);

  // Primo caricamento: refresh lista + metadati DB
  useEffect(() => {
    void refresh();
    void refreshMeta();
  }, [refresh, refreshMeta]);

  // Refresh meta dopo ogni mutazione di lista
  useEffect(() => {
    void refreshMeta();
  }, [players.length, refreshMeta]);

  const handleEdit = (id: string) => {
    const p = players.find((x) => x.id === id);
    if (p) setFormState({ mode: "edit", player: p });
  };

  const handleDelete = (id: string) => {
    const p = players.find((x) => x.id === id);
    if (p) setDeleteTarget(p);
  };

  const handleSubmit = async (input: CreatePlayerInput | UpdatePlayerInput) => {
    if (formState.mode === "edit") {
      await updatePlayer(input as UpdatePlayerInput);
    } else {
      await createPlayer(input as CreatePlayerInput);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    await deletePlayer(deleteTarget.id);
    setDeleteTarget(null);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="bg-ink text-paper px-5 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 flex items-center justify-center bg-paper rounded font-display text-ink font-bold text-sm border border-paper/30">
            DF
          </div>
          <div>
            <h1 className="font-display text-lg font-bold leading-tight">
              DossierFanta <span className="text-paper/60 text-sm font-body">v2.2 · M1</span>
            </h1>
            <p className="font-body text-[11px] text-paper/60 leading-tight">
              Taccuino di progettazione · offline-first
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setFormState({ mode: "create" })}
          className="px-3 py-2 font-display text-sm font-bold bg-paper text-ink rounded hover:bg-paper-dim transition-colors"
        >
          + Nuovo giocatore
        </button>
      </header>

      {/* Stats */}
      <StatsBar />

      {/* Toolbar: search + role filter */}
      <div className="bg-paper border-b border-ink/20 px-4 py-3 flex items-center gap-3 flex-wrap">
        <SearchBar />
        <RoleFilter />
      </div>

      {/* Lista giocatori (scrollable) */}
      <div className="flex-1 overflow-y-auto bg-paper">
        <PlayerList onEdit={handleEdit} onDelete={handleDelete} />
      </div>

      {/* Footer: simbologia */}
      <footer className="bg-paper-dim border-t border-ink/20 px-4 py-2 font-body text-[11px] text-ink-soft flex items-center gap-4 flex-wrap">
        <span>
          <strong className="text-ink">f₥</strong> Fantamilioni (valuta lega)
        </span>
        <span>
          <strong className="text-ink">M</strong> Med (media pura 0-10)
        </span>
        <span>
          <strong className="text-ink">MV</strong> MedV (FantaMedia 0-10)
        </span>
        <span>
          <strong className="text-ink">FVM</strong> FantaValoreMedio (valore listone)
        </span>
        <span className="ml-auto text-ink-soft/60">offline · SQLite locale · WAL mode</span>
      </footer>

      {/* Modali */}
      {formState.mode === "create" && (
        <PlayerForm
          player={null}
          onClose={() => setFormState({ mode: "closed" })}
          onSubmit={handleSubmit}
        />
      )}
      {formState.mode === "edit" && (
        <PlayerForm
          player={formState.player}
          onClose={() => setFormState({ mode: "closed" })}
          onSubmit={handleSubmit}
        />
      )}
      {deleteTarget && (
        <DeleteConfirmDialog
          player={deleteTarget}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
