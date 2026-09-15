/**
 * ArchiveView — vista giocatori archiviati (M2).
 *
 * Mostra i giocatori in `players_archive` con filtri search + role.
 * Per ciascuno:
 * - Badge "ARCHIVIATO" rosso sbiadito (Stamp variant)
 * - Motivo archiviazione (archived_reason)
 * - Data archiviazione (archived_at)
 * - Bottone "Ripristina" → chiama api.restoreArchivedPlayer(id)
 *
 * Note:
 * - I giocatori archiviati sono read-only: nessun edit/delete qui.
 * - Il ripristino manuale è complementare a quello automatico di
 *   `import_listone` (quando un giocatore torna nel listone).
 */

import { useEffect, useState } from "react";
import { api } from "@/api/tauri";
import type { ArchivedPlayer } from "@/types/player";
import { Stamp } from "./Stamp";

interface Props {
  onClose: () => void;
  onRestored?: () => void;
}

export function ArchiveView({ onClose, onRestored }: Props) {
  const [archived, setArchived] = useState<ArchivedPlayer[]>([]);
  const [search, setSearch] = useState("");
  const [role, setRole] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void refresh(), 250);
    return () => clearTimeout(t);
  }, [search, role]);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await api.listArchivedPlayers(search.trim() || undefined, role ?? undefined);
      setArchived(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleRestore = async (id: string) => {
    setRestoringId(id);
    setError(null);
    try {
      await api.restoreArchivedPlayer(id);
      await refresh();
      onRestored?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRestoringId(null);
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
        aria-labelledby="arch-title"
      >
        <header className="tacc-modal-header" style={{ backgroundColor: "var(--red)" }}>
          <h2 id="arch-title" className="text-lg font-bold">
            ⚠ Archivio giocatori
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
            Giocatori non più in Serie A (archiviati automaticamente dall'import
            del listone, o manualmente). Sono preservati come snapshot JSON e
            possono essere ripristinati se tornano nel listone.
          </p>

          {/* Toolbar: search + role filter */}
          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="search"
              placeholder="Cerca per nome…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="tacc-input flex-1 min-w-[12rem]"
              style={{ maxWidth: "20rem" }}
            />
            <select
              value={role ?? ""}
              onChange={(e) => setRole(e.target.value || null)}
              className="tacc-input"
              style={{ width: "auto" }}
            >
              <option value="">Tutti i ruoli</option>
              <option value="P">P — Portiere</option>
              <option value="D">D — Difensore</option>
              <option value="C">C — Centrocampista</option>
              <option value="A">A — Attaccante</option>
            </select>
          </div>

          {error && (
            <div className="bg-red/10 border border-red/40 text-red px-3 py-2 text-sm" style={{ fontFamily: "var(--font-body)" }}>
              <strong>Errore:</strong> {error}
            </div>
          )}

          {loading && (
            <div className="text-center py-8 text-ink-soft text-sm" style={{ fontFamily: "var(--font-body)" }}>
              Caricamento…
            </div>
          )}

          {!loading && archived.length === 0 && (
            <div className="text-center py-12 text-ink-soft" style={{ fontFamily: "var(--font-body)" }}>
              <div className="text-4xl mb-2 opacity-40" aria-hidden>▤</div>
              <div className="text-sm">Nessun giocatore archiviato.</div>
            </div>
          )}

          {!loading && archived.length > 0 && (
            <div className="border border-ink/30 bg-paper">
              <div
                className="grid grid-cols-12 gap-2 px-3 py-2 bg-ink/10 text-[11px] uppercase tracking-wider text-ink-soft"
                style={{ fontFamily: "var(--font-display)" }}
              >
                <div className="col-span-3">Nome</div>
                <div className="col-span-2">Squadra</div>
                <div className="col-span-1">Ruolo</div>
                <div className="col-span-3">Motivo</div>
                <div className="col-span-2">Archiviato</div>
                <div className="col-span-1 text-right">Azioni</div>
              </div>
              {archived.map((p) => (
                <div
                  key={p.id}
                  className="grid grid-cols-12 gap-2 px-3 py-2 border-t border-ink/10 items-center text-xs"
                  style={{ fontFamily: "var(--font-body)" }}
                >
                  <div className="col-span-3 truncate flex items-center gap-2">
                    <Stamp variant="archiviato">Arch</Stamp>
                    <span className="text-ink font-bold">{p.name}</span>
                  </div>
                  <div className="col-span-2 truncate text-ink-soft">{p.team ?? "—"}</div>
                  <div className="col-span-1 text-ink-soft">{p.pos_fanta ?? "—"}</div>
                  <div className="col-span-3 text-ink-soft truncate" title={p.archived_reason}>
                    {formatReason(p.archived_reason)}
                  </div>
                  <div className="col-span-2 text-ink-soft">{formatDate(p.archived_at)}</div>
                  <div className="col-span-1 text-right">
                    <button
                      type="button"
                      onClick={() => void handleRestore(p.id)}
                      disabled={restoringId === p.id}
                      className="text-green hover:text-green/80 disabled:opacity-50"
                      title="Ripristina in players"
                    >
                      {restoringId === p.id ? "…" : "↩"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <footer className="tacc-modal-footer">
          <button type="button" onClick={onClose} className="tacc-btn">
            Chiudi
          </button>
        </footer>
      </div>
    </div>
  );
}

function formatReason(r: string): string {
  const map: Record<string, string> = {
    trasferito_estero: "Trasferito all'estero",
    ritirato: "Ritirato",
    serie_b: "Sceso in Serie B",
    non_in_listone: "Non più in listone",
    migrate_v1: "Migrazione v1",
  };
  return map[r] ?? r;
}

function formatDate(iso: string): string {
  try {
    const dt = new Date(iso.replace(" ", "T") + "Z");
    if (isNaN(dt.getTime())) return iso;
    return dt.toLocaleString("it-IT", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
