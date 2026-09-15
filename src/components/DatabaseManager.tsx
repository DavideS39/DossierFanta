/**
 * DatabaseManager — schermata gestione database multi-DB (M2).
 *
 * Permette di:
 * - Vedere tutti i DB logici del workspace (righe della tabella `databases`)
 * - Creare un nuovo DB (PERSONALE o CONDIVISO)
 * - Eliminare un DB (con conferma esplicita, come per i giocatori)
 * - Switchare il DB attivo (cliccando su una riga)
 *
 * Vincoli:
 * - `default-personal` non può essere eliminato (vincolo backend M2).
 * - L'eliminazione richiede dialog di conferma (vincolo HARD specifica).
 * - I DB di tipo `listone` sono read-only e NON possono essere eliminati
 *   da questa schermata (vanno eliminati tramite il comando backend diretto).
 */

import { useEffect, useState } from "react";
import { useDbStore } from "@/stores/useDbStore";
import { useDbMetaStore } from "@/stores/useDbMetaStore";
import type { DatabaseMeta, DatabaseType } from "@/types/player";
import { DATABASE_TYPE_LABELS } from "@/types/player";

interface Props {
  onClose: () => void;
}

export function DatabaseManager({ onClose }: Props) {
  const databases = useDbStore((s) => s.databases);
  const activeId = useDbStore((s) => s.activeId);
  const refresh = useDbStore((s) => s.refresh);
  const createDatabase = useDbStore((s) => s.createDatabase);
  const deleteDatabase = useDbStore((s) => s.deleteDatabase);
  const setActiveDatabase = useDbStore((s) => s.setActiveDatabase);
  const refreshMeta = useDbMetaStore((s) => s.refresh);

  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<DatabaseType>("personal");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<DatabaseMeta | null>(null);
  const [deleteChecked, setDeleteChecked] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) {
      setError("Il nome è obbligatorio");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      await createDatabase(newName.trim(), newType);
      setNewName("");
      setNewType("personal");
      setShowCreate(false);
      await refreshMeta();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const handleSetActive = async (id: string) => {
    if (id === activeId) return;
    try {
      await setActiveDatabase(id);
      await refreshMeta();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteDatabase(deleteTarget.id);
      setDeleteTarget(null);
      setDeleteChecked(false);
      await refreshMeta();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="tacc-modal-backdrop" onClick={onClose}>
      <div
        className="tacc-modal"
        style={{ maxWidth: "44rem" }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="db-mgr-title"
      >
        <header className="tacc-modal-header">
          <h2 id="db-mgr-title" className="text-lg font-bold">
            » Workspace database
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-paper/70 hover:text-paper text-xl leading-none"
            aria-label="Chiudi"
          >
            ×
          </button>
        </header>

        <div className="p-5 space-y-4 tacc-bg">
          <p className="text-sm text-ink-soft" style={{ fontFamily: "var(--font-body)" }}>
            Database caricati nel workspace. Clicca su una riga per attivarla
            nella vista Rosa. L'eliminazione di un DB cancella a cascata tutti
            i suoi giocatori (operazione irreversibile).
          </p>

          {error && (
            <div className="bg-red/10 border border-red/40 text-red px-3 py-2 text-sm" style={{ fontFamily: "var(--font-body)" }}>
              <strong>Errore:</strong> {error}
            </div>
          )}

          {/* Lista databases */}
          <div className="border border-ink/30 bg-paper">
            <div
              className="grid grid-cols-12 gap-2 px-3 py-2 bg-ink/10 text-[11px] uppercase tracking-wider text-ink-soft"
              style={{ fontFamily: "var(--font-display)" }}
            >
              <div className="col-span-1">Attivo</div>
              <div className="col-span-4">Nome</div>
              <div className="col-span-2">Tipo</div>
              <div className="col-span-2">Owner</div>
              <div className="col-span-2">Creato</div>
              <div className="col-span-1 text-right">Azioni</div>
            </div>
            {databases.length === 0 ? (
              <div className="px-3 py-6 text-center text-ink-soft text-sm" style={{ fontFamily: "var(--font-body)" }}>
                Nessun database caricato.
              </div>
            ) : (
              databases.map((db) => {
                const isActive = db.id === activeId;
                const isDefault = db.id === "default-personal";
                return (
                  <div
                    key={db.id}
                    className={`grid grid-cols-12 gap-2 px-3 py-2 border-t border-ink/10 cursor-pointer hover:bg-paper-dim ${isActive ? "bg-paper-dim" : ""}`}
                    onClick={() => void handleSetActive(db.id)}
                    role="button"
                    tabIndex={0}
                  >
                    <div className="col-span-1 text-base">
                      {isActive ? <span className="text-green">✓</span> : <span className="text-ink/20">○</span>}
                    </div>
                    <div className="col-span-4 truncate" style={{ fontFamily: "var(--font-display)" }}>
                      {db.name}
                      {isDefault && (
                        <span className="ml-2 text-[10px] uppercase text-ink-soft" style={{ fontFamily: "var(--font-body)" }}>
                          (default)
                        </span>
                      )}
                    </div>
                    <div className="col-span-2 text-xs">
                      <span className="tacc-db-chip">{DATABASE_TYPE_LABELS[db.type as DatabaseType] ?? db.type}</span>
                    </div>
                    <div className="col-span-2 text-xs text-ink-soft" style={{ fontFamily: "var(--font-body)" }}>
                      {db.owner ?? "—"}
                    </div>
                    <div className="col-span-2 text-xs text-ink-soft" style={{ fontFamily: "var(--font-body)" }}>
                      {db.created_at ? formatDate(db.created_at) : "—"}
                    </div>
                    <div className="col-span-1 text-right">
                      {!isDefault && db.type !== "listone" && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteTarget(db);
                            setDeleteChecked(false);
                          }}
                          className="text-red hover:text-red/80 text-sm"
                          aria-label={`Elimina ${db.name}`}
                          title="Elimina"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Crea nuovo DB */}
          {!showCreate ? (
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              className="tacc-btn tacc-btn--primary"
            >
              + Crea nuovo database
            </button>
          ) : (
            <form onSubmit={handleCreate} className="border border-ink/30 bg-paper-dim p-3 space-y-3">
              <div className="text-[11px] uppercase tracking-wider text-ink-soft" style={{ fontFamily: "var(--font-display)" }}>
                Nuovo database
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2">
                  <input
                    type="text"
                    placeholder="Nome (es. marco.db, listone-2026.db)"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    className="tacc-input"
                    autoFocus
                  />
                </div>
                <select
                  value={newType}
                  onChange={(e) => setNewType(e.target.value as DatabaseType)}
                  className="tacc-input"
                >
                  <option value="personal">Personale</option>
                  <option value="shared">Condiviso</option>
                  {/* "listone" non creabile da UI — solo via import_listone */}
                </select>
              </div>
              <div className="flex items-center gap-2">
                <button type="submit" disabled={creating} className="tacc-btn tacc-btn--primary">
                  {creating ? "Creazione…" : "Crea"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowCreate(false);
                    setError(null);
                  }}
                  className="tacc-btn"
                >
                  Annulla
                </button>
              </div>
            </form>
          )}
        </div>

        <footer className="tacc-modal-footer">
          <button type="button" onClick={onClose} className="tacc-btn">
            Chiudi
          </button>
        </footer>
      </div>

      {/* Dialog conferma eliminazione DB */}
      {deleteTarget && (
        <div
          className="tacc-modal-backdrop"
          style={{ zIndex: 60 }}
          onClick={() => setDeleteTarget(null)}
        >
          <div
            className="tacc-modal"
            style={{ maxWidth: "26rem", borderColor: "var(--red)" }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <header
              className="tacc-modal-header"
              style={{ backgroundColor: "var(--red)" }}
            >
              <h2 className="text-lg font-bold">⚠ Conferma eliminazione DB</h2>
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="text-paper/70 hover:text-paper text-xl leading-none"
                aria-label="Chiudi"
              >
                ×
              </button>
            </header>
            <div className="p-5 space-y-3 tacc-bg">
              <p className="text-sm text-ink" style={{ fontFamily: "var(--font-body)" }}>
                Stai per eliminare il database:
              </p>
              <div
                className="border-l-4 border-red pl-3 py-2 bg-paper-dim"
                style={{ fontFamily: "var(--font-display)" }}
              >
                <div className="text-lg font-bold text-ink">{deleteTarget.name}</div>
                <div className="text-xs text-ink-soft" style={{ fontFamily: "var(--font-body)" }}>
                  tipo: {deleteTarget.type} · owner: {deleteTarget.owner ?? "—"}
                </div>
              </div>
              <p className="text-xs text-ink-soft" style={{ fontFamily: "var(--font-body)" }}>
                Tutti i giocatori di questo database verranno cancellati a cascata
                (FK ON DELETE CASCADE). L'operazione è irreversibile.
              </p>
              <label className="flex items-start gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={deleteChecked}
                  onChange={(e) => setDeleteChecked(e.target.checked)}
                  className="mt-0.5 w-4 h-4 accent-red"
                  autoFocus
                />
                <span className="text-sm text-ink" style={{ fontFamily: "var(--font-body)" }}>
                  Sì, ho capito che <strong>{deleteTarget.name}</strong> e tutti i suoi
                  giocatori verranno eliminati definitivamente.
                </span>
              </label>
            </div>
            <footer className="tacc-modal-footer">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                className="tacc-btn"
              >
                Annulla
              </button>
              <button
                type="button"
                onClick={handleDeleteConfirm}
                disabled={!deleteChecked || deleting}
                className="tacc-btn tacc-btn--danger"
              >
                {deleting ? "Eliminazione…" : "Elimina definitivamente"}
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}

function formatDate(iso: string): string {
  try {
    const dt = new Date(iso.replace(" ", "T") + "Z");
    if (isNaN(dt.getTime())) return iso;
    return dt.toLocaleString("it-IT", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}
