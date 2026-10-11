/**
 * GlossaryTooltip — popover cartaceo per definizioni termini tecnici (M2.1, Cap.9).
 *
 * Props:
 *  - `term`: chiave del termine in src/data/glossary.json
 *  - `children`: etichetta da mostrare accanto al glyph ?
 *
 * Renderizza: children + glyph ? (Special Elite 9.5px ink-soft). Hover
 * desktop o tap touch → popover cartaceo con:
 *   - title (Special Elite, bold)
 *   - def (Courier Prime)
 *   - example (Courier Prime italic, ink-soft)
 *
 * Comportamento:
 *  - Hover: popover appare con 100ms delay, scompare con 300ms delay (anti-flicker)
 *  - Click: popover persiste in modalità "pinned" fino a click fuori o ESC
 *  - ESC: chiude qualsiasi popover aperto (listener globale)
 *
 * Stili: il popover ha sfondo paper, bordo 1px ink-soft, ombra 3-layer Z3
 * (vedi taccuino-realistic.css). Z-index 70 per stare sopra ogni cosa tranne
 * modale Z5.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import glossaryJson from "@/data/glossary.json";

type GlossaryEntry = { title: string; def: string; example: string };
const glossary = glossaryJson as Record<string, GlossaryEntry>;

interface Props {
  term: keyof typeof glossary;
  children: React.ReactNode;
}

export function GlossaryTooltip({ term, children }: Props) {
  const entry = glossary[term];
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const popRef = useRef<HTMLSpanElement | null>(null);
  // v2.3.2 — popover renderizzato via PORTAL su document.body con position
  // fixed: non viene più clippano dall'overflow del container scrollabile
  // della scrivania. Flip sotto se non c'è spazio sopra, clamp al viewport.
  // `px` = x della punta rispetto al popover.
  const [place, setPlace] = useState<{ top: number; left: number; px: number; below: boolean } | null>(null);

  useLayoutEffect(() => {
    if (!(open || pinned)) {
      setPlace(null);
      return;
    }
    const el = popRef.current;
    const wrap = wrapRef.current;
    if (!el || !wrap) return;
    const w = el.getBoundingClientRect();
    const wr = wrap.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let below = false;
    let top = wr.top - w.height - 8;
    if (top < 8) {
      top = wr.bottom + 8;
      below = true;
    }
    if (top + w.height > vh - 8) top = Math.max(8, vh - w.height - 8);
    const center = Math.min(Math.max(wr.left + wr.width / 2, 8 + w.width / 2), vw - 8 - w.width / 2);
    const left = center - w.width / 2;
    const px = wr.left + wr.width / 2 - left;
    setPlace({ top, left, px, below });
  }, [open, pinned]);

  // ESC chiude il popover (globale, ma solo se è aperto)
  useEffect(() => {
    if (!open && !pinned) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPinned(false);
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, pinned]);

  // Click fuori chiude il popover pinned
  useEffect(() => {
    if (!pinned) return;
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setPinned(false);
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [pinned]);

  if (!entry) {
    // Termine non trovato nel glossary — mostra solo children, senza glyph
    return <span>{children}</span>;
  }

  const startHover = () => {
    if (pinned) return; // se pinned, hover non chiude
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setOpen(true), 100);
  };
  const endHover = () => {
    if (pinned) return;
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setOpen(false), 300);
  };
  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    // Toggle pinned: se aperto e pinned → chiudi; se aperto e non pinned → pinna; se chiuso → apri e pinna
    if (open && pinned) {
      setPinned(false);
      setOpen(false);
    } else if (open && !pinned) {
      setPinned(true);
    } else {
      setOpen(true);
      setPinned(true);
    }
  };

  return (
    <span
      ref={wrapRef}
      className="glossary-tooltip-wrap"
      onMouseEnter={startHover}
      onMouseLeave={endHover}
      style={{ position: "relative", display: "inline-flex", alignItems: "baseline", cursor: "help" }}
    >
      {children}
      <button
        type="button"
        className="glossary-tooltip-glyph"
        onClick={handleClick}
        aria-label={`Definizione: ${entry.title}`}
        aria-expanded={open || pinned}
        style={{
          fontFamily: "var(--font-display)",
          fontSize: "9.5px",
          color: "var(--ink-soft)",
          background: "transparent",
          border: "none",
          padding: "0 0 0 2px",
          cursor: "help",
          lineHeight: 1,
        }}
        tabIndex={0}
      >
        ?
      </button>
      {(open || pinned) &&
        createPortal(
          <span
            ref={popRef}
            className={`glossary-popover tacc-realistic-shadow ${place?.below ? "flip-below" : ""}`}
            role="tooltip"
            style={{
              position: "fixed",
              top: place ? `${place.top}px` : "-9999px",
              left: place ? `${place.left}px` : "-9999px",
              visibility: place ? "visible" : "hidden",
              ["--pointer-x" as string]: place ? `${place.px}px` : "50%",
              zIndex: 70,
              width: "min(280px, 70vw)",
              padding: "0.55rem 0.75rem",
              backgroundColor: "var(--paper)",
              border: "1px solid var(--ink-soft)",
              boxShadow:
                "0 1px 2px rgba(43,27,18,0.30), 0 4px 8px rgba(43,27,18,0.18), 0 12px 24px rgba(43,27,18,0.12)",
              fontFamily: "var(--font-body)",
              fontSize: "11px",
              color: "var(--ink)",
              textAlign: "left",
              lineHeight: 1.4,
            }}
          >
          <span
            className="glossary-popover-title"
            style={{
              display: "block",
              fontFamily: "var(--font-display)",
              fontWeight: "bold",
              color: "var(--ink)",
              borderBottom: "1px solid rgba(43,27,18,0.2)",
              paddingBottom: "0.25rem",
              marginBottom: "0.35rem",
            }}
          >
            {entry.title}
          </span>
          <span style={{ display: "block", color: "var(--ink)" }}>{entry.def}</span>
          {entry.example && (
            <span
              style={{
                display: "block",
                marginTop: "0.35rem",
                paddingTop: "0.35rem",
                borderTop: "1px dashed rgba(43,27,18,0.15)",
                color: "var(--ink-soft)",
                fontStyle: "italic",
              }}
            >
              {entry.example}
            </span>
          )}
          </span>,
          document.body,
        )}
    </span>
  );
}
