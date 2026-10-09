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

import { useEffect, useRef, useState } from "react";
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
      {(open || pinned) && (
        <span
          className="glossary-popover tacc-realistic-shadow"
          role="tooltip"
          style={{
            position: "absolute",
            // Sopra il children, leggermente shiftato a sinistra
            bottom: "calc(100% + 6px)",
            left: "50%",
            transform: "translateX(-50%)",
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
        </span>
      )}
    </span>
  );
}
