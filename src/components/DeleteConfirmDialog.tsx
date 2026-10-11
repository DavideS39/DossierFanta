import { useEffect, useRef, useState } from "react";
import type { Player } from "@/types/player";

interface Props {
  player: Player;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}

/**
 * Dialog di conferma cancellazione (M2 — design taccuino).
 *
 * Vincolo HARD (specifica v2.2):
 *   "Niente cancellazioni automatiche di giocatori — solo esplicita con conferma"
 *
 * Implementazione:
 *   - Toggle "Sì, elimina" + bottone "Elimina definitivamente" disabilitato finché
 *     l'utente non ha esplicitamente checkato.
 *   - Il nome del giocatore è mostrato in evidenza per evitare errori.
 *   - Gli eventuali record collegati (scouting_notes, auction_data) saranno
 *     cancellati a cascata dal FK ON DELETE CASCADE dello schema.
 *
 * M2 design: usa classi `.tacc-modal`, `.tacc-btn`, font taccuino.
 */
export function DeleteConfirmDialog({ player, onConfirm, onCancel }: Props) {
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const handleConfirm = async () => {
    setDeleting(true);
    setError(null);
    try {
      await onConfirm();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDeleting(false);
    }
  };

  return (
    <div
      className="tacc-modal-backdrop"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-labelledby="del-title"
    >
      <div
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
        className="tacc-modal w-full max-w-md"
        style={{ borderColor: "var(--red)" }}
      >
        <header
          className="tacc-modal-header"
          style={{ backgroundColor: "var(--red)" }}
        >
          <h2 id="del-title" className="text-lg font-bold">
            ⚠ Conferma eliminazione
          </h2>
        </header>

        <div className="p-5 space-y-3 tacc-bg">
          <p className="text-ink" style={{ fontFamily: "var(--font-body)" }}>
            Stai per eliminare definitivamente il giocatore:
          </p>
          <div
            className="border-l-4 pl-3 py-2"
            style={{ borderColor: "var(--red)", backgroundColor: "var(--paper-dim)" }}
          >
            <div className="text-lg font-bold text-ink" style={{ fontFamily: "var(--font-display)" }}>
              {player.name}
            </div>
            <div className="text-xs text-ink-soft" style={{ fontFamily: "var(--font-body)" }}>
              {player.team ?? "—"} · {player.pos_fanta ?? "?"}
              {player.fascia ? ` · ${player.fascia}` : ""}
            </div>
          </div>
          <p className="text-xs text-ink-soft" style={{ fontFamily: "var(--font-body)" }}>
            Verranno rimossi anche eventuali note di scouting e dati asta collegati
            (cascade dal FK). L'operazione è irreversibile. Per nascondere il
            giocatore senza perderlo, usa «Archivia» invece di eliminare.
          </p>

          <label className="flex items-start gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={confirmChecked}
              onChange={(e) => setConfirmChecked(e.target.checked)}
              className="mt-0.5 w-4 h-4 accent-red"
              autoFocus
            />
            <span className="text-sm text-ink" style={{ fontFamily: "var(--font-body)" }}>
              Sì, ho capito che <strong>{player.name}</strong> verrà eliminato definitivamente.
            </span>
          </label>

          {error && (
            <div className="bg-red/10 border border-red/40 text-red px-3 py-2 text-sm" style={{ fontFamily: "var(--font-body)" }}>
              <strong>Errore:</strong> {error}
            </div>
          )}
        </div>

        <footer className="tacc-modal-footer">
          <button
            type="button"
            onClick={onCancel}
            disabled={deleting}
            className="tacc-btn"
          >
            Annulla
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!confirmChecked || deleting}
            className="tacc-btn tacc-btn--danger"
          >
            {deleting ? "Eliminazione…" : "Elimina definitivamente"}
          </button>
        </footer>
      </div>
    </div>
  );
}
