import { useEffect, useState } from "react";
import { PlayerList } from "@/components/PlayerList";
import { SearchBar } from "@/components/SearchBar";
import { RoleFilter } from "@/components/RoleFilter";
import { StatsBar } from "@/components/StatsBar";
import { PlayerForm } from "@/components/PlayerForm";
import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";
import { DatabaseManager } from "@/components/DatabaseManager";
import { ImportListone } from "@/components/ImportListone";
import { ArchiveView } from "@/components/ArchiveView";
import { usePlayersStore } from "@/stores/usePlayersStore";
import { useDbMetaStore } from "@/stores/useDbMetaStore";
import { useDbStore } from "@/stores/useDbStore";
import type { CreatePlayerInput, Player, UpdatePlayerInput } from "@/types/player";

type FormState =
  | { mode: "closed" }
  | { mode: "create" }
  | { mode: "edit"; player: Player };

type ModalState = "none" | "databases" | "import" | "archive";

/**
 * Vista principale M2: Rosa (multi-DB + archiviazione + design taccuino).
 *
 * Layout:
 *   ┌───────────────────────────────────────────────────┐
 *   │ Header: titolo + DB switcher + btn azioni          │
 *   │ StatsBar: conteggi, DB info                          │
 *   │ Toolbar: SearchBar | RoleFilter | Filtro DB          │
 *   │ Sidebar filtri (destra): toggle Archivio + simboli   │
 *   │ PlayerList: griglia di card taccuino                │
 *   │ Footer: legenda simboli                              │
 *   └───────────────────────────────────────────────────┘
 *
 * Modali:
 *   - PlayerForm (create/edit)
 *   - DeleteConfirmDialog (eliminazione esplicita con conferma)
 *   - DatabaseManager (gestione DB)
 *   - ImportListone (file picker + anteprima)
 *   - ArchiveView (vista archiviati con restore)
 */
export function RosaView() {
  const refresh = usePlayersStore((s) => s.refresh);
  const createPlayer = usePlayersStore((s) => s.createPlayer);
  const updatePlayer = usePlayersStore((s) => s.updatePlayer);
  const deletePlayer = usePlayersStore((s) => s.deletePlayer);
  const players = usePlayersStore((s) => s.players);
  const refreshMeta = useDbMetaStore((s) => s.refresh);

  const dbFilter = usePlayersStore((s) => s.dbFilter);
  const setDbFilter = usePlayersStore((s) => s.setDbFilter);
  const includeArchive = usePlayersStore((s) => s.includeArchive);
  const setIncludeArchive = usePlayersStore((s) => s.setIncludeArchive);

  const activeDb = useDbStore((s) => s.getActiveDatabase?.());
  const refreshDbs = useDbStore((s) => s.refresh);

  const [formState, setFormState] = useState<FormState>({ mode: "closed" });
  const [deleteTarget, setDeleteTarget] = useState<Player | null>(null);
  const [modal, setModal] = useState<ModalState>("none");

  // Primo caricamento
  useEffect(() => {
    void refresh();
    void refreshMeta();
    void refreshDbs();
  }, [refresh, refreshMeta, refreshDbs]);

  // Refresh meta dopo ogni mutazione di lista
  useEffect(() => {
    void refreshMeta();
  }, [players.length, refreshMeta]);

  // Quando il DB attivo cambia, refresh lista
  useEffect(() => {
    void refresh();
  }, [activeDb?.id, refresh]);

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
    <div className="flex flex-col h-full tacc-bg">
      {/* Header */}
      <header
        className="text-paper px-5 py-3 flex items-center justify-between flex-wrap gap-2"
        style={{ backgroundColor: "var(--ink)" }}
      >
        <div className="flex items-center gap-3">
          <div
            className="w-9 h-9 flex items-center justify-center rounded font-display text-ink font-bold text-sm border border-paper/30"
            style={{ backgroundColor: "var(--paper)", fontFamily: "var(--font-display)" }}
          >
            DF
          </div>
          <div>
            <h1 className="text-lg font-bold leading-tight" style={{ fontFamily: "var(--font-display)" }}>
              DossierFanta{" "}
              <span className="text-paper/60 text-sm" style={{ fontFamily: "var(--font-body)" }}>
                v2.2 · M2
              </span>
            </h1>
            <p className="text-[11px] text-paper/60 leading-tight" style={{ fontFamily: "var(--font-body)" }}>
              Taccuino di progettazione · offline-first · multi-DB workspace
            </p>
          </div>
        </div>

        {/* Switcher DB + azioni */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* DB attivo (clic → apre manager) */}
          <button
            type="button"
            onClick={() => setModal("databases")}
            className="px-3 py-1.5 text-paper border border-paper/40 hover:bg-paper hover:text-ink transition-colors flex items-center gap-2"
            style={{ fontFamily: "var(--font-display)" }}
            title="Apri gestione database"
          >
            <span className="text-[10px] uppercase opacity-70" style={{ fontFamily: "var(--font-body)" }}>
              DB:
            </span>
            <span className="text-sm">{activeDb?.name ?? "—"}</span>
            <span aria-hidden className="text-[10px] opacity-60">»</span>
          </button>

          <button
            type="button"
            onClick={() => setModal("import")}
            className="px-3 py-1.5 text-xs uppercase tracking-wider text-ink"
            style={{
              fontFamily: "var(--font-display)",
              backgroundColor: "var(--amber)",
              color: "#FFF",
            }}
            title="Import listone Serie A (archiviazione automatica)"
          >
            ⚑ Import listone
          </button>

          <button
            type="button"
            onClick={() => setModal("archive")}
            className="px-3 py-1.5 text-xs uppercase tracking-wider border border-paper/40 text-paper hover:bg-paper hover:text-ink"
            style={{ fontFamily: "var(--font-display)" }}
            title="Vista giocatori archiviati"
          >
            ▤ Archivio
          </button>

          <button
            type="button"
            onClick={() => setFormState({ mode: "create" })}
            className="px-3 py-1.5 text-paper font-bold uppercase tracking-wider text-sm"
            style={{
              fontFamily: "var(--font-display)",
              backgroundColor: "var(--paper)",
              color: "var(--ink)",
            }}
          >
            + Nuovo giocatore
          </button>
        </div>
      </header>

      {/* Stats */}
      <StatsBar />

      {/* Toolbar: search + role filter + filtro DB */}
      <div
        className="border-b px-4 py-3 flex items-center gap-3 flex-wrap"
        style={{ backgroundColor: "var(--paper)", borderColor: "rgba(43, 27, 18, 0.2)" }}
      >
        <SearchBar />
        <RoleFilter />
        <DbFilterSelect
          value={dbFilter}
          onChange={setDbFilter}
        />
        <label
          className="flex items-center gap-1.5 text-xs cursor-pointer select-none ml-auto"
          style={{ fontFamily: "var(--font-body)" }}
          title="Mostra anche i giocatori archiviati (read-only)"
        >
          <input
            type="checkbox"
            checked={includeArchive}
            onChange={(e) => setIncludeArchive(e.target.checked)}
            className="w-3.5 h-3.5 accent-red"
          />
          <span className="uppercase tracking-wider text-ink-soft">Includi archivio</span>
        </label>
      </div>

      {/* Lista giocatori (scrollable) */}
      <div className="flex-1 overflow-y-auto">
        <PlayerList onEdit={handleEdit} onDelete={handleDelete} />
      </div>

      {/* Footer: legenda simboli */}
      <footer className="tacc-legend">
        <span>
          <strong>f₥</strong> Fantamilioni (valuta lega)
        </span>
        <span>
          <strong>M</strong> Med (media pura 0-10)
        </span>
        <span>
          <strong>MV</strong> MedV (FantaMedia 0-10)
        </span>
        <span>
          <strong>FVM</strong> FantaValoreMedio (valore listone)
        </span>
        <span>
          <strong>★</strong> priorità (0-5)
        </span>
        <span>
          <strong>□</strong> pinzatrice (priorità 5/5)
        </span>
        <span className="ml-auto text-ink-soft/60">
          offline · SQLite locale · WAL mode
        </span>
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
      {modal === "databases" && (
        <DatabaseManager onClose={() => setModal("none")} />
      )}
      {modal === "import" && (
        <ImportListone
          onClose={() => setModal("none")}
          onImported={() => {
            void refresh();
            void refreshMeta();
          }}
        />
      )}
      {modal === "archive" && (
        <ArchiveView
          onClose={() => setModal("none")}
          onRestored={() => {
            void refresh();
            void refreshMeta();
          }}
        />
      )}
    </div>
  );
}

/**
 * Filtro DB: chip "Attivo" + "Tutti" + una chip per ogni DB caricato.
 * Selezionare "Tutti" mostra i giocatori di tutti i DB con chip di provenienza.
 */
function DbFilterSelect({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const databases = useDbStore((s) => s.databases);
  const activeId = useDbStore((s) => s.activeId);

  return (
    <div
      className="flex items-center gap-1 flex-wrap"
      role="group"
      aria-label="Filtra per database"
    >
      <span
        className="text-[11px] uppercase tracking-wider text-ink-soft mr-1"
        style={{ fontFamily: "var(--font-display)" }}
      >
        DB:
      </span>
      <button
        type="button"
        onClick={() => onChange(null)}
        className={`px-2.5 py-1 text-xs rounded border transition-colors ${value === null ? "bg-ink text-paper border-ink" : "bg-paper text-ink border-ink/30 hover:border-ink"}`}
        style={{ fontFamily: "var(--font-body)" }}
        aria-pressed={value === null}
      >
        Attivo
      </button>
      <button
        type="button"
        onClick={() => onChange("all")}
        className={`px-2.5 py-1 text-xs rounded border transition-colors ${value === "all" ? "bg-ink text-paper border-ink" : "bg-paper text-ink border-ink/30 hover:border-ink"}`}
        style={{ fontFamily: "var(--font-body)" }}
        aria-pressed={value === "all"}
      >
        Tutti
      </button>
      {databases
        .filter((d) => d.id !== activeId)
        .map((d) => {
          const active = value === d.id;
          return (
            <button
              key={d.id}
              type="button"
              onClick={() => onChange(active ? null : d.id)}
              className={`px-2.5 py-1 text-xs rounded border transition-colors ${active ? "bg-ink text-paper border-ink" : "bg-paper text-ink border-ink/30 hover:border-ink"}`}
              style={{ fontFamily: "var(--font-body)" }}
              aria-pressed={active}
              title={`Filtra per ${d.name}`}
            >
              {d.name}
            </button>
          );
        })}
    </div>
  );
}
