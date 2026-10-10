
/**
 * StatusToggle — menu a 3 voci (Scoutato / Da fare / Totale) per il toggle
 * manuale dello stato di un giocatore (M2.1, Cap.8 + Cap.16 Componente 2).
 *
 * Appare al click sul timbro di stato nella card giocatore. Posizione:
 * assoluto rispetto al timbro (sotto di esso).
 *
 * Comportamento:
 *  - Click su una voce → api.setPlayerStatus(playerId, newStatus)
 *  - Aggiorna il player store (refresh lista o update ottimistico)
 *  - Chiude il menu
 *
 * Shortcut globale T (cap.8): toggle stato del giocatore selezionato.
 * La scorciatoia è gestita in RosaView (non qui).
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "@/api/tauri";
import type { Player, Status } from "@/types/player";
import { usePlayersStore } from "@/stores/usePlayersStore";

interface Props {
  player: Player;
  onClose: () => void;
  /** Posizione assoluta (x, y) rispetto alla viewport dove aprire il menu. */
  x: number;
  y: number;
}

export function StatusToggle({ player, onClose, x, y }: Props) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const refresh = usePlayersStore((s) => s.refresh);

  // Click fuori → chiude
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const apply = async (newStatus: Status) => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await api.setPlayerStatus(player.id, newStatus);
      await refresh();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Clamp x/y per non uscire dalla viewport
  const clampedX = Math.min(x, window.innerWidth - 130);
  const clampedY = Math.min(y, window.innerHeight - 100);

  // v2.3.2 — portal su body: le card hanno transform/filter, che rendono
  // position:fixed relativo alla card invece che al viewport.
  return createPortal(
    <div
      ref={menuRef}
      className="tacc-status-toggle-menu"
      role="menu"
      aria-label={`Cambia stato di ${player.name}`}
      style={{
        position: "fixed",
        left: clampedX,
        top: clampedY,
        zIndex: 75,
      }}
    >
      <button
        type="button"
        className="tacc-status-toggle-item tacc-status-toggle-item--scoutato"
        disabled={busy}
        onClick={() => apply("scoutato")}
        role="menuitem"
      >
        Scoutato
      </button>
      <button
        type="button"
        className="tacc-status-toggle-item tacc-status-toggle-item--da-fare"
        disabled={busy}
        onClick={() => apply("da_fare")}
        role="menuitem"
      >
        Da fare
      </button>
      <button
        type="button"
        className="tacc-status-toggle-item tacc-status-toggle-item--totali"
        disabled={busy}
        onClick={() => apply("totali")}
        role="menuitem"
      >
        Totale
      </button>
      {err && (
        <div
          style={{
            padding: "0.3rem 0.5rem",
            fontSize: "10px",
            color: "var(--red)",
            fontFamily: "var(--font-body)",
            borderTop: "1px solid rgba(43,27,18,0.2)",
          }}
        >
          {err}
        </div>
      )}
    </div>,
    document.body,
  );
}
