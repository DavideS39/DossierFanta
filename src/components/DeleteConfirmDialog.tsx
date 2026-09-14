import { useEffect, useRef, useState } from "react";
import type { Player } from "@/types/player";

interface Props {
  player: Player;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}

/**
 * Dialog di conferma cancellazione.
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
 */
export function DeleteConfirmDialog({ player, onConfirm, onCancel }: Props) {
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus management: chiudi con ESC, focus sul checkbox all'apertura
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
      className="fixed inset-0 z-50 bg-ink/50 flex items-center justify-center p-4"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-labelledby="del-title"
    >
      <div
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
        className="bg-paper border-2 border-red rounded-lg shadow-xl w-full max-w-md"
      >
        <header className="bg-red text-paper px-5 py-3 rounded-t">
          <h2 id="del-title" className="font-display text-lg font-bold">
            ⚠ Conferma eliminazione
          </h2>
        </header>

        <div className="p-5 space-y-3">
          <p className="font-body text-ink">
            Stai per eliminare definitivamente il giocatore:
          </p>
          <div className="bg-paper-dim border-l-4 border-red pl-3 py-2">
            <div className="font-display text-lg font-bold text-ink">{player.name}</div>
            <div className="font-body text-xs text-ink-soft">
              {player.team ?? "—"} · {player.pos_fanta ?? "?"}
              {player.fascia ? ` · ${player.fascia}` : ""}
            </div>
          </div>
          <p className="font-body text-xs text-ink-soft">
            Verranno rimossi anche eventuali note di scouting e dati asta collegati
            (cascade dal FK). L'operazione è irreversibile.
          </p>

          <label className="flex items-start gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={confirmChecked}
              onChange={(e) => setConfirmChecked(e.target.checked)}
              className="mt-0.5 w-4 h-4 accent-red"
              autoFocus
            />
            <span className="font-body text-sm text-ink">
              Sì, ho capito che <strong>{player.name}</strong> verrà eliminato definitivamente.
            </span>
          </label>

          {error && (
            <div className="bg-red/10 border border-red/40 text-red px-3 py-2 font-body text-sm rounded">
              <strong>Errore:</strong> {error}
            </div>
          )}
        </div>

        <footer className="bg-paper-dim border-t-2 border-ink/30 px-5 py-3 flex items-center justify-end gap-2 rounded-b">
          <button
            type="button"
            onClick={onCancel}
            disabled={deleting}
            className="px-4 py-2 font-body text-sm text-ink border border-ink/30 rounded hover:bg-paper disabled:opacity-50"
          >
            Annulla
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!confirmChecked || deleting}
            className="px-4 py-2 font-display text-sm font-bold text-paper bg-red rounded hover:bg-red/90 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {deleting ? "Eliminazione…" : "Elimina definitivamente"}
          </button>
        </footer>
      </div>
    </div>
  );
}
