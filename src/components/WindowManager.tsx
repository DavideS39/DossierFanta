/**
 * WindowManager — container per le finestre WM in-app + taskbar (M2.1, Cap.17).
 *
 * Renderizza:
 *  - Uno strato assoluto che contiene tutte le finestre aperte (Window.tsx)
 *  - Una taskbar in fondo con le finestre minimizzate (click per ripristinare)
 *  - Shortcut Alt+W per ciclare z-order
 *
 * Il WM vive dentro la finestra principale dell'app: le finestre non
 * possono uscire dai bounds. Per "staccare" una scheda su monitor
 * multipli, l'utente doppio-click sulla chrome → finestra OS nativa
 * (comando Tauri open_player_window). Quel flusso è gestito qui:
 *  - api.openPlayerWindow(playerId) → detachToOs(playerId) rimuove la
 *    versione in-app e traccia il player_id in detachedToOs
 *  - api.closePlayerWindow(playerId) → attachFromOs(playerId) e riapre
 *    la finestra in-app
 *
 * Una scheda è O in-app O OS nativa, non entrambe (switch, non duplica).
 *
 * Stato via useWindowsStore (Zustand). Bounds = viewport della finestra
 * principale (misurato con ResizeObserver).
 */

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useWindowsStore } from "@/stores/useWindowsStore";
import { Window } from "./Window";

interface Props {
  /** Render-prop: dato un playerId, renderizza il contenuto della finestra. */
  renderWindow: (playerId: string, title: string) => ReactNode;
}

export function WindowManager({ renderWindow }: Props) {
  const windows = useWindowsStore((s) => s.windows);
  const restoreFromTaskbar = useWindowsStore((s) => s.restoreFromTaskbar);
  const cycleZOrder = useWindowsStore((s) => s.cycleZOrder);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [bounds, setBounds] = useState({ w: 1280, h: 800 });

  // Misura il container con ResizeObserver
  useLayoutEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const update = () => {
      const r = el.getBoundingClientRect();
      setBounds({ w: r.width, h: r.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Shortcut Alt+W per ciclare z-order
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && (e.key === "w" || e.key === "W")) {
        e.preventDefault();
        cycleZOrder();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cycleZOrder]);

  // Filtra le finestre staccate su OS nativa (non renderizzare la versione in-app)
  const detached = useWindowsStore((s) => s.detachedToOs);
  const visibleWindows = windows.filter((w) => !detached.has(w.id));
  const minimizedWindows = windows.filter((w) => w.minimized && !detached.has(w.id));

  return (
    <div
      ref={containerRef}
      className="tacc-window-manager"
      data-wm-root
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none", // il WM è solo un layer; i figli riacquiscono pointer events
        zIndex: 40, // Z4
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
        }}
      >
        {visibleWindows.map((w) => (
          <div
            key={w.id}
            style={{ pointerEvents: "auto" }}
          >
            <Window win={w} bounds={bounds}>
              {renderWindow(w.id, w.title)}
            </Window>
          </div>
        ))}
      </div>

      {/* Taskbar (in fondo) — striscia di carta strappata con cartellini */}
      {minimizedWindows.length > 0 && (
        <div
          className="wf-taskbar"
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            pointerEvents: "auto",
            zIndex: 41,
          }}
        >
          <span className="wf-taskbar-label">» task:</span>
          {minimizedWindows.map((w, i) => (
            <button
              key={w.id}
              type="button"
              className="wf-taskbar-item"
              style={{ "--tilt": `${i % 2 === 0 ? -1.2 : 1.4}deg` } as CSSProperties}
              onClick={() => restoreFromTaskbar(w.id)}
              title={`Ripristina ${w.title}`}
            >
              <span aria-hidden className="wf-taskbar-glyph">▤</span>
              {w.title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
