/**
 * Window — singola finestra del Window Manager in-app (M2.1, Cap.17).
 *
 * Props:
 *  - `win`: stato della finestra (posizione, dimensioni, z, flags)
 *  - `children`: contenuto (tipicamente PlayerForm renderizzato dentro)
 *
 * Caratteristiche:
 *  - position: absolute, traslata in base a win.x/y
 *  - Chrome 32px in alto: titolo Special Elite 12px + 3 pulsanti glyph
 *    (─ minimizza, □ massimizza, ✕ chiudi)
 *  - Drag dalla chrome (pointer events con capture)
 *  - Resize dall'angolo ↘ (handle visibile in basso a destra)
 *  - Snap ai bordi: sinistra → metà sx, destra → metà dx, sopra → max
 *  - Doppio-click sulla chrome → massimizza/restore
 *  - Click su corpo → focusWindow (porta in primo piano)
 *
 * Styling: usa .tacc-window-shell + .tacc-window-chrome da taccuino-realistic.css
 */

import { useEffect, useRef, type ReactNode } from "react";
import type { WindowState } from "@/stores/useWindowsStore";
import { useWindowsStore } from "@/stores/useWindowsStore";

interface Props {
  win: WindowState;
  children: ReactNode;
  /** Layout bounds (viewport del container WM). Per clamp drag/resize. */
  bounds: { w: number; h: number };
}

export function Window({ win, children, bounds }: Props) {
  const focusWindow = useWindowsStore((s) => s.focusWindow);
  const closeWindow = useWindowsStore((s) => s.closeWindow);
  const moveWindow = useWindowsStore((s) => s.moveWindow);
  const resizeWindow = useWindowsStore((s) => s.resizeWindow);
  const minimizeWindow = useWindowsStore((s) => s.minimizeWindow);
  const toggleMaximize = useWindowsStore((s) => s.toggleMaximize);

  // Refs per il drag/resize via pointer events
  const dragState = useRef<{
    mode: "drag" | "resize" | null;
    startX: number;
    startY: number;
    startWX: number;
    startWY: number;
    startWW: number;
    startWH: number;
  }>({
    mode: null,
    startX: 0,
    startY: 0,
    startWX: 0,
    startWY: 0,
    startWW: 0,
    startWH: 0,
  });

  // Pointer event handlers (drag + resize)
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const ds = dragState.current;
      if (!ds.mode) return;
      const dx = e.clientX - ds.startX;
      const dy = e.clientY - ds.startY;
      if (ds.mode === "drag") {
        // Sposta la finestra. Clamp per non uscire dai bounds.
        const newX = Math.max(
          0,
          Math.min(bounds.w - 80, ds.startWX + dx),
        );
        const newY = Math.max(
          0,
          Math.min(bounds.h - 40, ds.startWY + dy),
        );
        moveWindow(win.id, newX, newY);
      } else if (ds.mode === "resize") {
        // Ridimensiona. Min 320x400.
        const newW = Math.max(320, ds.startWW + dx);
        const newH = Math.max(400, ds.startWH + dy);
        // Clamp: non più grande del bounds - posizione
        const maxW = bounds.w - win.x - 4;
        const maxH = bounds.h - win.y - 4;
        resizeWindow(win.id, Math.min(newW, maxW), Math.min(newH, maxH));
      }
    };
    const onUp = () => {
      dragState.current.mode = null;
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [win.id, win.x, win.y, bounds.w, bounds.h, moveWindow, resizeWindow]);

  if (win.minimized) return null;

  // Se è "detached" su OS nativa, non renderizzare la versione in-app
  // (gestito dal parent WindowManager che filtra già)

  return (
    <div
      className={`tacc-window-shell ${win.z === useWindowsStore.getState().nextZ - 1 ? "is-active" : ""}`}
      style={{
        position: "absolute",
        left: win.x,
        top: win.y,
        width: win.w,
        height: win.h,
        zIndex: win.z,
        backgroundColor: "var(--paper)",
        border: "2px solid var(--ink)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
      onPointerDown={() => focusWindow(win.id)}
      role="dialog"
      aria-label={`Finestra: ${win.title}`}
    >
      {/* Chrome (drag handle + buttons) */}
      <div
        className="tacc-window-chrome"
        onPointerDown={(e) => {
          // Solo drag se primario e non sui pulsanti
          if (e.button !== 0) return;
          if ((e.target as HTMLElement).closest("button")) return;
          dragState.current = {
            mode: "drag",
            startX: e.clientX,
            startY: e.clientY,
            startWX: win.x,
            startWY: win.y,
            startWW: win.w,
            startWH: win.h,
          };
          document.body.style.userSelect = "none";
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onDoubleClick={() => toggleMaximize(win.id)}
        title="Drag per spostare · doppio-click per massimizzare/restore"
      >
        <span className="tacc-window-chrome-title">{win.title}</span>
        <span className="tacc-window-chrome-buttons">
          <button
            type="button"
            className="tacc-window-chrome-btn"
            onClick={(e) => {
              e.stopPropagation();
              minimizeWindow(win.id);
            }}
            title="Minimizza (taskbar)"
            aria-label="Minimizza"
          >
            ─
          </button>
          <button
            type="button"
            className="tacc-window-chrome-btn"
            onClick={(e) => {
              e.stopPropagation();
              toggleMaximize(win.id);
            }}
            title="Massimizza / Ripristina"
            aria-label="Massimizza o ripristina"
          >
            □
          </button>
          <button
            type="button"
            className="tacc-window-chrome-btn tacc-window-chrome-btn--close"
            onClick={(e) => {
              e.stopPropagation();
              closeWindow(win.id);
            }}
            title="Chiudi"
            aria-label="Chiudi"
          >
            ✕
          </button>
        </span>
      </div>

      {/* Contenuto (scrollable) */}
      <div
        style={{
          flex: 1,
          overflow: "auto",
          backgroundColor: "var(--paper)",
          padding: 0,
        }}
      >
        {children}
      </div>

      {/* Resize handle (angolo ↘) */}
      {!win.maximized && (
        <div
          className="tacc-window-resize-handle"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            dragState.current = {
              mode: "resize",
              startX: e.clientX,
              startY: e.clientY,
              startWX: win.x,
              startWY: win.y,
              startWW: win.w,
              startWH: win.h,
            };
            document.body.style.userSelect = "none";
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
          }}
        />
      )}
    </div>
  );
}
