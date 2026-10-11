/**
 * Window — singola finestra del Window Manager in-app (M2.1, Cap.17).
 *
 * v2.3.6 — "un foglio per finestra, titolo incluso nel foglio":
 * la finestra è un FOGLIO rettangolare posato sulla scrivania. Lo sfondo
 * è UNO dei 2 PNG forniti dal product owner (desk-tile.png = legal pad
 * rigato, desk-vintage.png = pergamena), scelto stabilmente per player_id
 * via hashString (look "casuale" ma senza flicker tra i render):
 *
 *  - il foglio copre TUTTO il guscio finestra (header + corpo): il titolo
 *    non è più su una zona trasparente, è scritto SUL foglio come su un
 *    quaderno vero. niente più due PNG sovrapposti (legal pad + pergamena
 *    in multiply): uno solo, scelto a caso;
 *  - ombra 3-layer (contact + mid + ambient) come box-shadow sul guscio,
 *    intensificata quando attiva o in drag (effetto foglio sollevato);
 *  - nastro adesivo CSS in alto (tranne sul foglio che ce l'ha impresso);
 *  - chrome "protocollata" scritta sul foglio: riga protocollo in alto
 *    (» scheda · wm in-app), nome giocatore in Special Elite con
 *    sottolineatura a pennarello rosso (SVG inline), pulsanti glyph
 *    ─ □ ✕ in riquadri timbrati. Drag da tutta l'intestazione;
 *  - corpo dentro la safe-area misurata del foglio (fori, strappi,
 *    perforazione): il contenuto non copre mai i bordi vivi;
 *  - resize dall'angolo piegato in basso a dx (piega cartacea, non handle);
 *  - snap ai bordi con GHOST tratteggiato a matita mentre trascini
 *    (sx → metà sx, dx → metà dx, alto → massimizza);
 *  - animazioni: il foglio "cala" sulla scrivania all'apertura (drop con
 *    assestamento), vola via ruotando in chiusura, si ripiega in taskbar
 *    minimizzando; mentre trascini si solleva (scala + tilt + ombra max);
 *  - rotazione ±0.6° stabile per player_id: nessuna finestra è parallela
 *    a un'altra, come fogli posati a mano.
 *
 * Props:
 *  - `win`: stato della finestra (posizione, dimensioni, z, flags)
 *  - `children`: contenuto (PlayerForm embedded)
 *  - `bounds`: layout bounds (viewport del container WM) per clamp/snap
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { WindowState } from "@/stores/useWindowsStore";
import { useWindowsStore } from "@/stores/useWindowsStore";
import { sheetFor, hashString } from "@/assets/paper";
// I 2 PNG forniti dal product owner per lo sfondo delle finestre WM.
// Prima di v2.3.6 venivano sovrapposti (legal pad come base + pergamena
// in multiply) creando l'effetto "due fogli uno sopra l'altro". Ora la
// finestra ne usa UNO solo, scelto a caso per player_id (hashString).
import deskTileUrl from "@/assets/backgrounds/desk-tile.png";
import deskVintageUrl from "@/assets/backgrounds/desk-vintage.png";

/**
 * I 2 fogli "dati" dal product owner per lo sfondo finestra. Ognuno ha le
 * sue regole di sizing/repeat: desk-tile è un tile ripetibile (legal pad
 * "infinito"), desk-vintage è un'immagine unica (pergamena da stendere).
 *
 * L'indice viene scelto stabilmente per player_id via hashString, in modo
 * che finestre diverse mostrino fogli diversi ma la stessa finestra, se
 * chiusa e riaperta, mantenga lo stesso foglio (no flicker).
 */
interface SheetBgConfig {
  img: string;
  size: string;
  repeat: "repeat" | "no-repeat";
  pos: string;
}

const WM_SHEET_BG: SheetBgConfig[] = [
  {
    img: deskTileUrl,
    size: "440px 584px",
    repeat: "repeat",
    pos: "top left",
  },
  {
    img: deskVintageUrl,
    size: "100% 100%",
    repeat: "no-repeat",
    pos: "center top",
  },
];

interface Props {
  win: WindowState;
  children: ReactNode;
  /** Layout bounds (viewport del container WM). Per clamp drag/resize/snap. */
  bounds: { w: number; h: number };
}

type SnapTarget =
  | { kind: "left" | "right"; x: number; y: number; w: number; h: number }
  | { kind: "max" }
  | null;

const SNAP_EDGE = 26; // px dal bordo del container per agganciare lo snap

export function Window({ win, children, bounds }: Props) {
  const focusWindow = useWindowsStore((s) => s.focusWindow);
  const closeWindow = useWindowsStore((s) => s.closeWindow);
  const moveWindow = useWindowsStore((s) => s.moveWindow);
  const resizeWindow = useWindowsStore((s) => s.resizeWindow);
  const minimizeWindow = useWindowsStore((s) => s.minimizeWindow);
  const toggleMaximize = useWindowsStore((s) => s.toggleMaximize);
  const activeId = useWindowsStore((s) => s.activeId);

  // Foglio strappato assegnato stabilmente al giocatore + seed estetico.
  // sheetFor() continua a fornire safe-area + posizione del nastro (quei
  // metadati restano validi per qualunque sfondo), ma la texture non è più
  // sheet-*.webp bensì uno dei 2 PNG desk-tile/desk-vintage, scelto a caso.
  const sheet = useMemo(() => sheetFor(win.id), [win.id]);
  const seed = useMemo(() => hashString(win.id), [win.id]);
  const rotation = ((seed % 13) - 6) / 10; // -0.6° .. +0.6°
  const tapeCorner = sheet.tape === "top" && seed % 3 === 0; // nastro d'angolo extra

  // Sfondo foglio: 1 dei 2 PNG "dati" dal product owner. Stabile per
  // player_id (hashString) → la stessa finestra mostra sempre lo stesso
  // foglio, finestre diverse ne possono mostrare uno diverso.
  const sheetBg = useMemo(
    () => WM_SHEET_BG[hashString(win.id + ":wm-sheet") % WM_SHEET_BG.length],
    [win.id],
  );

  const [dragging, setDragging] = useState(false);
  const [leaving, setLeaving] = useState<"close" | "min" | null>(null);
  const [snap, setSnap] = useState<SnapTarget>(null);

  // Refs per il drag/resize via pointer events
  const dragState = useRef<{
    mode: "drag" | "resize" | null;
    startX: number;
    startY: number;
    startWX: number;
    startWY: number;
    startWW: number;
    startWH: number;
    /** origine client del container WM, per calcolare lo snap ai bordi */
    originX: number;
    originY: number;
  }>({
    mode: null,
    startX: 0,
    startY: 0,
    startWX: 0,
    startWY: 0,
    startWW: 0,
    startWH: 0,
    originX: 0,
    originY: 0,
  });

  // Pointer event handlers (drag + resize + snap ghost)
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const ds = dragState.current;
      if (!ds.mode) return;
      const dx = e.clientX - ds.startX;
      const dy = e.clientY - ds.startY;
      if (ds.mode === "drag") {
        // Sposta la finestra. Clamp per non uscire dai bounds.
        const newX = Math.max(0, Math.min(bounds.w - 80, ds.startWX + dx));
        const newY = Math.max(0, Math.min(bounds.h - 40, ds.startWY + dy));
        moveWindow(win.id, newX, newY);
        // Snap ghost: puntatore vicino a un bordo del container WM?
        const px = e.clientX - ds.originX;
        const py = e.clientY - ds.originY;
        if (py < SNAP_EDGE) {
          setSnap({ kind: "max" });
        } else if (px < SNAP_EDGE) {
          setSnap({ kind: "left", x: 0, y: 0, w: Math.round(bounds.w / 2), h: bounds.h });
        } else if (px > bounds.w - SNAP_EDGE) {
          setSnap({
            kind: "right",
            x: Math.round(bounds.w / 2),
            y: 0,
            w: Math.round(bounds.w / 2),
            h: bounds.h,
          });
        } else {
          setSnap(null);
        }
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
      const ds = dragState.current;
      if (ds.mode === "drag") {
        // Rilascio sul bordo: applica lo snap evidenziato dal ghost
        setSnap((current) => {
          if (current?.kind === "left" || current?.kind === "right") {
            moveWindow(win.id, current.x, current.y);
            resizeWindow(win.id, current.w, current.h);
          } else if (current?.kind === "max") {
            if (!win.maximized) toggleMaximize(win.id);
          }
          return null;
        });
        setDragging(false);
      }
      ds.mode = null;
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [win.id, win.x, win.y, win.maximized, bounds.w, bounds.h, moveWindow, resizeWindow, toggleMaximize]);

  // Chiusura/minimizza animata: il foglio vola via / si ripiega, poi store
  const handleClose = () => {
    if (leaving) return;
    setLeaving("close");
    window.setTimeout(() => closeWindow(win.id), 250);
  };
  const handleMinimize = () => {
    if (leaving) return;
    setLeaving("min");
    window.setTimeout(() => minimizeWindow(win.id), 190);
  };

  if (win.minimized) return null;

  // Se è "detached" su OS nativa, non renderizzare la versione in-app
  // (gestito dal parent WindowManager che filtra già)

  const isActive = activeId === win.id;

  return (
    <div
      className={[
        "wf-shell",
        isActive ? "is-active" : "",
        dragging ? "is-dragging" : "",
        win.maximized ? "is-maximized" : "",
        leaving === "close" ? "wf-leave-close" : "",
        leaving === "min" ? "wf-leave-min" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={
        {
          position: "absolute",
          left: win.x,
          top: win.y,
          width: win.w,
          height: win.h,
          zIndex: win.z,
          "--rot": `${rotation}deg`,
          // Lo sfondo foglio copre TUTTO il guscio (header + corpo).
          // Il titolo non è più trasparente: è posato SUL foglio.
          "--sheet-img": `url("${sheetBg.img}")`,
          "--sheet-size": sheetBg.size,
          "--sheet-repeat": sheetBg.repeat,
          "--sheet-pos": sheetBg.pos,
          // Safe-area misurata sul foglio originale (fori, strappi,
          // perforazione): usata da .wf-head e .wf-body per il padding.
          "--safe-t": `${sheet.safe.t}%`,
          "--safe-r": `${sheet.safe.r}%`,
          "--safe-b": `${sheet.safe.b}%`,
          "--safe-l": `${sheet.safe.l}%`,
        } as CSSProperties
      }
      onPointerDown={() => focusWindow(win.id)}
      role="dialog"
      aria-label={`Finestra: ${win.title}`}
    >
      {/* v2.3.6: il guscio .wf-shell ha DIRETTAMENTE il foglio come
          background-image (via CSS vars), quindi header e corpo sono
          entrambi "sopra il foglio". Non serve un layer .wf-paper
          separato, e non serve wm-body-bg sul corpo: il corpo eredita
          la trasparenza e lascia vedere il foglio del guscio. */}

      {/* Nastro adesivo: quello impresso nella foto non va duplicato */}
      {sheet.tape === "top" && <span className="wf-tape wf-tape--top" aria-hidden />}
      {tapeCorner && <span className="wf-tape wf-tape--corner" aria-hidden />}

      {/* Ghost tratteggiato dello snap (matita rossa) mentre trascini.
          Coordinate container WM → translate relative al guscio finestra. */}
      {snap && (
        <div
          className="wf-snap-ghost"
          style={
            snap.kind === "max"
              ? { left: -win.x, top: -win.y, width: bounds.w, height: bounds.h }
              : { left: snap.x - win.x, top: snap.y - win.y, width: snap.w, height: snap.h }
          }
          aria-hidden
        />
      )}

      {/* Intestazione protocollata — drag handle + pulsanti timbrati */}
      <header
        className="wf-head"
        onPointerDown={(e) => {
          // Solo drag se primario e non sui pulsanti
          if (e.button !== 0) return;
          if ((e.target as HTMLElement).closest("button")) return;
          if (win.maximized) return;
          const root = (e.currentTarget as HTMLElement).closest("[data-wm-root]");
          const r = root?.getBoundingClientRect();
          dragState.current = {
            mode: "drag",
            startX: e.clientX,
            startY: e.clientY,
            startWX: win.x,
            startWY: win.y,
            startWW: win.w,
            startWH: win.h,
            originX: r?.left ?? 0,
            originY: r?.top ?? 0,
          };
          setDragging(true);
          document.body.style.userSelect = "none";
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onDoubleClick={() => toggleMaximize(win.id)}
        title="Drag per spostare · doppio-click per massimizzare/restore · bordo finestra per snap"
      >
        <div className="wf-head-top">
          <span className="wf-protocol">
            » scheda giocatore · wm in-app
            {win.maximized ? " · massimizzata" : ""}
          </span>
          <span className="wf-btns">
            <button
              type="button"
              className="wf-btn"
              onClick={(e) => {
                e.stopPropagation();
                handleMinimize();
              }}
              title="Minimizza (taskbar)"
              aria-label="Minimizza"
            >
              ─
            </button>
            <button
              type="button"
              className="wf-btn"
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
              className="wf-btn wf-btn--close"
              onClick={(e) => {
                e.stopPropagation();
                handleClose();
              }}
              title="Chiudi"
              aria-label="Chiudi"
            >
              ✕
            </button>
          </span>
        </div>
        <div className="wf-title-row">
          <h2 className="wf-title">{win.title}</h2>
          <svg
            className="wf-squiggle"
            viewBox="0 0 220 9"
            preserveAspectRatio="none"
            aria-hidden
          >
            <path d="M2 6 C 28 2, 52 8, 84 4.5 S 148 2.5, 178 5.5 S 208 4, 218 5" />
          </svg>
        </div>
      </header>

      {/* Contenuto (scrollable) dentro la safe-area del foglio.
          v2.3.6: il guscio .wf-shell ha già il foglio come background,
          quindi il corpo è TRASPARENTE: lascia vedere il foglio sotto.
          Niente più wm-body-bg (era il doppio PNG legal pad + pergamena
          sovrapposti): il foglio è uno solo, scelto a caso, sul guscio. */}
      <div className="wf-body">{children}</div>

      {/* Angolo piegato: resize handle cartaceo (↘) */}
      {!win.maximized && (
        <div
          className="wf-fold"
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
              originX: 0,
              originY: 0,
            };
            document.body.style.userSelect = "none";
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
          }}
          title="Trascina per ridimensionare"
        />
      )}
    </div>
  );
}
