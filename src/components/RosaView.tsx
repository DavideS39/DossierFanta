
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
import { api, isDesktop } from "@/api/tauri";
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
  // v2.3.2 — toast cartaceo per messaggi non bloccanti (es. detach OS in web)
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4200);
    return () => clearTimeout(t);
  }, [toast]);

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

  // M2.1 B5 — Doppio-click card → stacca in finestra OS nativa via Tauri.
  // Chiude la versione in-app (se aperta) e traccia il detach nel store.
  const handleDetachOs = async (id: string) => {
    // v2.3.2 — in anteprima web (mock) le finestre OS non esistono: toast
    // informativo invece di un errore Tauri.
    if (!isDesktop) {
      setToast("Le finestre OS native sono disponibili solo nell'app desktop. In anteprima web usa il Window Manager in-app (click sulla card).");
      return;
    }
    const p = players.find((x) => x.id === id);
    if (!p) return;
    try {
      // Chiudi la finestra WM in-app (se aperta)
      useWindowsStore.getState().closeWindow(id);
      // Crea la finestra OS nativa
      await api.openPlayerWindow(id);
      // Traccia il detach: il WM non renderizzerà la versione in-app
      useWindowsStore.getState().detachToOs(id);
      // Aggiorna il set dal backend per coerenza
      const ids = await api.listOsPlayerWindows();
      setDetachedToOs(ids);
    } catch (e) {
      // Mostriamo l'errore come toast — per ora solo in console
      console.error("openPlayerWindow failed:", e);
      alert(`Impossibile aprire la finestra OS nativa: ${e instanceof Error ? e.message : String(e)}`);
    }
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
  // il contenuto della finestra (PlayerForm embedded, senza backdrop modale).
  //
  // BUG FIX M2.1: l'onSubmit chiama SEMPRE updatePlayer (non handleSubmit).
  // handleSubmit controlla formState.mode (lo stato modale del pulsante
  // "Nuovo giocatore" in RosaView), che è "closed" quando si salva da dentro
  // una Window. Caderebbe nel branch else → createPlayer → DUPLICATO.
  // Siamo in modalità edit (player è sempre passato non-null alle Window),
  // quindi chiamiamo direttamente updatePlayer.
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
        embedded
        onClose={() => useWindowsStore.getState().closeWindow(playerId)}
        onSubmit={async (input) => {
          // Sempre update: la Window contiene sempre un player esistente.
          await updatePlayer(input as UpdatePlayerInput);
        }}
      />
    );
  };

  return (
    <div className="flex flex-col h-full tacc-bg tacc-bg--paper-desk relative">
      {/* Masthead-copertina v2.3.2: ink con grana, cartellino DF con nastro */}
      <header className="df-masthead">
        <div className="df-brand">
          <span className="df-logo-tag" aria-hidden>
            DF
          </span>
          <div>
            <h1 className="df-title">
              DossierFanta <span className="df-ver">v2.3 · M2.1</span>
            </h1>
            <p className="df-tagline">taccuino scouting · offline-first · multi-DB · WM ibrido</p>
          </div>
          {!isDesktop && (
            <span className="df-mockbadge" title="Stai vedendo l'app nel browser con dati dimostrativi in-memory. Nell'app desktop i dati vivono in SQLite locale.">
              anteprima web · mock
            </span>
          )}
        </div>

        {/* Switcher DB + azioni */}
        <div className="df-actions">
          <button
            type="button"
            onClick={() => setModal("databases")}
            className="df-btn"
            title="Apri gestione database"
          >
            <span style={{ opacity: 0.65, fontSize: 9 }}>DB:</span>
            <span>{activeDb?.name ?? "—"}</span>
            <span aria-hidden style={{ opacity: 0.6 }}>»</span>
          </button>

          <button
            type="button"
            onClick={() => setModal("import")}
            className="df-btn df-btn--warn"
            title="Import listone Serie A (anteprima diff + archiviazione automatica)"
          >
            ⚑ Import listone
          </button>

          <button
            type="button"
            onClick={() => setModal("archive")}
            className="df-btn"
            title="Vista giocatori archiviati"
          >
            ▤ Archivio
          </button>

          <button
            type="button"
            onClick={() => setFormState({ mode: "create" })}
            className="df-btn df-btn--primary"
          >
            + Nuovo giocatore
          </button>

          {/* M2.1 B1 — Toggle taccuino pulito */}
          <label
            className="df-clean-toggle"
            title="Disattiva pieghe, invecchiamento angoli e macchie d'inchiostro. Mantenuta solo la griglia quaderno."
          >
            <input
              type="checkbox"
              checked={cleanMode}
              onChange={(e) => setCleanMode(e.target.checked)}
            />
            taccuino pulito
          </label>
        </div>
      </header>

      {/* Stats */}
      <StatsBar />

      {/* Toolbar: search + role filter + filtro DB (striscia paper v2.3.2) */}
      <div className="df-toolbar">
        <SearchBar />
        <RoleFilter />
        <DbFilterSelect
          value={dbFilter}
          onChange={setDbFilter}
        />
        <label
          className="df-arch-toggle"
          title="Mostra anche i giocatori archiviati (read-only)"
        >
          <input
            type="checkbox"
            checked={includeArchive}
            onChange={(e) => setIncludeArchive(e.target.checked)}
          />
          includi archivio
        </label>
      </div>

      {/* Lista giocatori (scrollable) — scrivania con vignettatura */}
      <div className="flex-1 overflow-y-auto relative df-desk">
        <PlayerList onEdit={handleEdit} onDelete={handleDelete} onDetachOs={handleDetachOs} />
      </div>

      {/* M2.1 B5 — Window Manager in-app layer (Z4). Renderizzato al root level
          di RosaView (non dentro lo scroll container) così le finestre con
          position: absolute non vengono tagliate dal overflow-y-auto del parent. */}
      <WindowManager renderWindow={renderWindow} />

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

      {/* Toast cartaceo (v2.3.2) */}
      {toast && (
        <div className="df-toast" role="status">
          {toast}{" "}
          <button
            type="button"
            onClick={() => setToast(null)}
            style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--ink-soft)", fontFamily: "var(--font-display)" }}
            aria-label="Chiudi messaggio"
          >
            ✕
          </button>
        </div>
      )}

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
      className="flex items-center gap-1.5 flex-wrap"
      role="group"
      aria-label="Filtra per database"
    >
      <span
        className="text-[10px] uppercase tracking-wider mr-0.5"
        style={{ fontFamily: "var(--font-display)", color: "var(--ink-soft)" }}
      >
        DB:
      </span>
      <button
        type="button"
        onClick={() => onChange(null)}
        className="df-chip df-chip--ink"
        style={{ color: "var(--ink)" }}
        aria-pressed={value === null}
      >
        Attivo
      </button>
      <button
        type="button"
        onClick={() => onChange("all")}
        className="df-chip df-chip--ink"
        style={{ color: "var(--ink)" }}
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
              className="df-chip df-chip--ink"
              style={{ color: "var(--ink-soft)" }}
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
