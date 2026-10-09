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
import { WindowManager } from "@/components/WindowManager";
import { usePlayersStore } from "@/stores/usePlayersStore";
import { useDbMetaStore } from "@/stores/useDbMetaStore";
import { useDbStore } from "@/stores/useDbStore";
import { useWindowsStore } from "@/stores/useWindowsStore";
import { api } from "@/api/tauri";
import type { CreatePlayerInput, Player, Status, UpdatePlayerInput } from "@/types/player";

type FormState =
  | { mode: "closed" }
  | { mode: "create" }
  | { mode: "edit"; player: Player };

type ModalState = "none" | "databases" | "import" | "archive";

/**
 * Vista principale M2.1: Rosa (multi-DB + archiviazione + design taccuino
 * realistico v2.3 + Window Manager ibrido).
 *
 * M2.1 v2.3:
 *  - Le schede giocatore si aprono come finestre nel Window Manager in-app
 *    (non più modali a tutto schermo). Doppio-click sulla chrome → finestra OS.
 *  - Toggle "taccuino pulito" persistito in localStorage.
 *  - Shortcut T per toggolare lo stato del giocatore selezionato.
 *  - Stats + footer legenda con tooltip glossario sui simboli.
 *
 * Modali residui (rimangono come modali perché non sono "schede"):
 *  - DeleteConfirmDialog (eliminazione esplicita)
 *  - DatabaseManager (gestione DB)
 *  - ImportListone (file picker + anteprima diff)
 *  - ArchiveView (vista archiviati con restore)
 */
export function RosaView() {
  const refresh = usePlayersStore((s) => s.refresh);
  const createPlayer = usePlayersStore((s) => s.createPlayer);
  const updatePlayer = usePlayersStore((s) => s.updatePlayer);
  const deletePlayer = usePlayersStore((s) => s.deletePlayer);
  const players = usePlayersStore((s) => s.players);
  const selectedId = usePlayersStore((s) => s.selectedId);
  const refreshMeta = useDbMetaStore((s) => s.refresh);

  const dbFilter = usePlayersStore((s) => s.dbFilter);
  const setDbFilter = usePlayersStore((s) => s.setDbFilter);
  const includeArchive = usePlayersStore((s) => s.includeArchive);
  const setIncludeArchive = usePlayersStore((s) => s.setIncludeArchive);

  const activeDb = useDbStore((s) => s.getActiveDatabase?.());
  const refreshDbs = useDbStore((s) => s.refresh);

  // M2.1 B5 — Window Manager store
  const openPlayerWindow = useWindowsStore((s) => s.openPlayerWindow);
  const detachedToOs = useWindowsStore((s) => s.detachedToOs);
  const setDetachedToOs = useWindowsStore((s) => s.setDetachedToOs);

  const [formState, setFormState] = useState<FormState>({ mode: "closed" });
  const [deleteTarget, setDeleteTarget] = useState<Player | null>(null);
  const [modal, setModal] = useState<ModalState>("none");

  // M2.1 B1 — toggle "taccuino pulito"
  const [cleanMode, setCleanMode] = useState<boolean>(() => {
    try {
      return localStorage.getItem("dossierfanta.cleanMode") === "1";
    } catch {
      return false;
    }
  });

  // Applica la classe `tacc-clean-mode` al body quando il toggle è ON
  useEffect(() => {
    if (cleanMode) {
      document.body.classList.add("tacc-clean-mode");
    } else {
      document.body.classList.remove("tacc-clean-mode");
    }
    try {
      localStorage.setItem("dossierfanta.cleanMode", cleanMode ? "1" : "0");
    } catch {
      // ignore
    }
  }, [cleanMode]);

  // Primo caricamento
  useEffect(() => {
    void refresh();
    void refreshMeta();
    void refreshDbs();
    // M2.1 B5: sync detachedToOs dal backend al boot
    void api.listOsPlayerWindows().then(setDetachedToOs).catch(() => {
      // ignore — il backend potrebbe non essere pronto
    });
  }, [refresh, refreshMeta, refreshDbs, setDetachedToOs]);

  // Refresh meta dopo ogni mutazione di lista
  useEffect(() => {
    void refreshMeta();
  }, [players.length, refreshMeta]);

  // Quando il DB attivo cambia, refresh lista
  useEffect(() => {
    void refresh();
  }, [activeDb?.id, refresh]);

  // M2.1 B3 — Shortcut T: toggle stato del giocatore selezionato.
  // Rispetta il flusso: legge lo status corrente e cicla
  // totali → scoutato → da_fare → totali.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Skip se si sta scrivendo in un input/textarea
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (e.key !== "t" && e.key !== "T") return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (!selectedId) return;
      e.preventDefault();
      const p = players.find((x) => x.id === selectedId);
      if (!p) return;
      const cycle: Record<Status, Status> = {
        totali: "scoutato",
        scoutato: "da_fare",
        da_fare: "totali",
      };
      const next = cycle[p.status];
      void api.setPlayerStatus(p.id, next).then(() => refresh());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, players, refresh]);

  const handleEdit = (id: string) => {
    const p = players.find((x) => x.id === id);
    if (!p) return;
    // M2.1 B5 — Apri come finestra WM in-app, non modale a tutto schermo.
    // Se la scheda è già staccata su OS nativa, focus quella.
    if (detachedToOs.has(p.id)) {
      void api.openPlayerWindow(p.id); // focus finestra OS esistente
      return;
    }
    openPlayerWindow(p.id, p.name);
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

  // M2.1 B5 — Render-prop per WindowManager: dato un playerId, renderizza
  // il contenuto della finestra (PlayerForm in modalità edit).
  const renderWindow = (playerId: string) => {
    const p = players.find((x) => x.id === playerId);
    if (!p) {
      return (
        <div style={{ padding: "1rem", fontFamily: "var(--font-body)", fontSize: "12px", color: "var(--ink-soft)" }}>
          » Giocatore non più in lista (probabilmente eliminato o archiviato). Chiudi la finestra.
        </div>
      );
    }
    return (
      <PlayerForm
        player={p}
        onClose={() => useWindowsStore.getState().closeWindow(playerId)}
        onSubmit={async (input) => {
          await handleSubmit(input);
        }}
      />
    );
  };

  return (
    <div className="flex flex-col h-full tacc-bg tacc-bg--realistic relative">
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
                v2.3 · M2.1
              </span>
            </h1>
            <p className="text-[11px] text-paper/60 leading-tight" style={{ fontFamily: "var(--font-body)" }}>
              Taccuino di progettazione · offline-first · multi-DB · WM ibrido
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
            title="Import listone Serie A (anteprima diff + archiviazione automatica)"
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

          {/* M2.1 B1 — Toggle taccuino pulito */}
          <label
            className="flex items-center gap-1 cursor-pointer select-none px-2 py-1 border border-paper/30"
            title="Disattiva pieghe, invecchiamento angoli e macchie d'inchiostro. Mantenuta solo la griglia quaderno."
          >
            <input
              type="checkbox"
              checked={cleanMode}
              onChange={(e) => setCleanMode(e.target.checked)}
              className="w-3 h-3 accent-amber"
            />
            <span
              className="text-[10px] uppercase tracking-wider text-paper/80"
              style={{ fontFamily: "var(--font-body)" }}
            >
              taccuino pulito
            </span>
          </label>
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
      <div className="flex-1 overflow-y-auto relative">
        <PlayerList onEdit={handleEdit} onDelete={handleDelete} />

        {/* M2.1 B5 — Window Manager in-app layer (Z4) */}
        <WindowManager renderWindow={renderWindow} />
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
        <span>
          <strong>⇄</strong> toggle stato · <strong>T</strong> shortcut
        </span>
        <span className="ml-auto text-ink-soft/60">
          offline · SQLite locale · WAL mode · M2.1
        </span>
      </footer>

      {/* Modali residui */}
      {formState.mode === "create" && (
        <PlayerForm
          player={null}
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
