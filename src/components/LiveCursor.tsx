// src/components/LiveCursor.tsx — Cursore collaborativo live (M3a — B.6).
//
// Renderizza un cursore colorato (label + caret) sopra un campo editabile,
// mostrando dove un peer remoto sta scrivendo. Funziona nel WM in-app (layer 1).
// Nelle finestre OS native (layer 2), il cursore appare solo se il peer remoto
// sta editando la stessa scheda (perché la finestra OS è una vista della
// stessa scheda via Yjs shared state).
//
// # Posizionamento
//
// Il posizionamento del cursore rispetto al campo richiede il calcolo delle
// coordinate del caret nel testo. Per evitare di re-implementare caret
// positioning (che è complesso con wrap, font metrics, ecc.), usiamo
// `getCaretCoordinates()` helper che crea un div specchio del campo e
// misura la posizione del carattere. Per textarea/input semplici, si
// approssima con `selectionStart` × character width.
//
// # Animazioni
//
// - Fade-in 200ms ease (quando il cursore appare)
// - Fade-out 300ms ease dopo che il peer smette di editare (idle > 3s)
// - No CSS transition sul posizionamento (jump diretto, altrimenti sembra lag)
//
// # Z-index
//
// Z3 = sopra le card player, sotto i tooltip glossario. Definito in
// `src/styles/taccuino.css` o inline qui.

import { useEffect, useState, useRef, useCallback } from "react";
import type { LiveCursor } from "@/types/sync";

export interface LiveCursorProps {
  /** Cursore del peer remoto da renderizzare. */
  cursor: LiveCursor;
  /** Ref al campo DOM a cui il cursore è applicato.
   *  Se null/undefined, il cursore non viene renderizzato (campo non visibile). */
  fieldRef: React.RefObject<HTMLElement | null>;
  /** ID univoco del campo corrente (per matching con cursor.field). */
  fieldId: string;
  /** Callback quando il cursore deve essere rimosso (es. timeout idle). */
  onTimeout?: (userId: string) => void;
}

/**
 * Componente che renderizza un singolo cursore collaborativo.
 *
 * Uso tipico (in un componente con un campo editabile):
 *
 *   const fieldRef = useRef<HTMLTextAreaElement>(null);
 *   const [cursors, setCursors] = useState<Map<string, LiveCursor>>(new Map());
 *   useEffect(() => observeCursors(setCursors), []);
 *   // ... nel render:
 *   <textarea ref={fieldRef} field="players.abc.notes" ... />
 *   {Array.from(cursors.values())
 *     .filter((c) => c.field === "players.abc.notes")
 *     .map((c) => (
 *       <LiveCursor key={c.userId} cursor={c} fieldRef={fieldRef} fieldId="players.abc.notes" />
 *     ))}
 */
export function LiveCursor({
  cursor,
  fieldRef,
  fieldId,
  onTimeout,
}: LiveCursorProps): React.ReactElement | null {
  // Match: il cursore si renderizza solo se è per il campo corrente
  if (cursor.field !== fieldId) return null;

  const [position, setPosition] = useState<{ top: number; left: number } | null>(
    null
  );
  const [isVisible, setIsVisible] = useState(true);
  const lastUpdatedAt = useRef(Date.parse(cursor.updatedAt) || Date.now());
  // M3a.1 — Fix bug latente: `ReturnType<typeof setTimeout>` è un tipo,
  // non un valore. La riga originale `const timeoutRef = ReturnType<typeof setTimeout>`
  // era un no-op che assegnava il tipo come valore (TS2693) e dichiarava
  // timeoutRef senza mai usarlo (TS6133). Rimosso: il timer di timeout è
  // già gestito dallo useEffect sotto (variabile locale `timer`).

  // Calcola la posizione del caret nel campo
  const computePosition = useCallback(() => {
    const el = fieldRef.current;
    if (!el) return null;
    return getCaretCoordinates(el, cursor.position);
  }, [fieldRef, cursor.position]);

  // Aggiorna posizione quando il cursore o il campo cambiano
  useEffect(() => {
    const pos = computePosition();
    if (pos) {
      setPosition(pos);
      setIsVisible(true);
      lastUpdatedAt.current = Date.parse(cursor.updatedAt) || Date.now();
    }
  }, [cursor.position, cursor.selection, cursor.updatedAt, computePosition]);

  // Timeout: nascondi cursore se idle > 3s
  useEffect(() => {
    if (!isVisible) return;
    const timer = setTimeout(() => {
      setIsVisible(false);
      onTimeout?.(cursor.userId);
    }, 3_000 + (Date.now() - lastUpdatedAt.current));
    return () => clearTimeout(timer);
  }, [isVisible, cursor.userId, onTimeout]);

  if (!position || !isVisible) return null;

  return (
    <div
      className="live-cursor"
      style={{
        position: "absolute",
        top: `${position.top}px`,
        left: `${position.left}px`,
        zIndex: 30, // Z3 — sopra card, sotto tooltip glossario
        pointerEvents: "none",
        opacity: 1,
        transition: "opacity 300ms ease-out",
      }}
      aria-hidden="true"
    >
      {/* Caret verticale colorato */}
      <div
        style={{
          position: "absolute",
          width: "2px",
          height: "1.4em",
          background: cursor.color,
          top: 0,
          left: 0,
          animation: "livecursor-fadein 200ms ease-out",
        }}
      />
      {/* Label con nome utente + glyph penna */}
      <div
        style={{
          position: "absolute",
          top: "1.4em",
          left: 0,
          background: cursor.color,
          color: "#FFFFFF",
          fontFamily: "Inter, system-ui, sans-serif",
          fontSize: "10px",
          fontWeight: 600,
          padding: "1px 5px",
          borderRadius: "3px 3px 3px 0",
          whiteSpace: "nowrap",
          display: "flex",
          alignItems: "center",
          gap: "3px",
          boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
          animation: "livecursor-fadein 200ms ease-out",
        }}
      >
        {/* Glyph penna SVG inline (no emoji, come da vincolo HARD #10) */}
        <svg
          width="9"
          height="9"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 19l7-7 3 3-7 7-3-3z" />
          <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
          <path d="M2 2l7.586 7.586" />
          <circle cx="11" cy="11" r="2" />
        </svg>
        {cursor.name}
      </div>
      <style>{`
        @keyframes livecursor-fadein {
          from { opacity: 0; }
          to { opacity: 1; }
        }
      `}</style>
    </div>
  );
}

// ----------------------------------------------------------------------
// Helper: calcolo caret coordinates (approssimato)
// ----------------------------------------------------------------------

/**
 * Calcola la posizione (top, left in px) del caret nel campo `el`
 * alla posizione `position` (offset caratteri).
 *
 * Approccio: crea un div specchio con le stesse dimensioni/font del campo,
 * copia il testo fino a `position`, misura la posizione dell'ultimo
 * carattere nel div specchio. Funziona bene per textarea/input senza
 * text-wrap complesso; per wrap, approssima con character width × position.
 *
 * Per un'implementazione robusta (es. per textareas grandi con wrap),
 * usare la libreria `textarea-caret-position` o `caret-pos` in produzione.
 */
function getCaretCoordinates(
  el: HTMLElement,
  position: number
): { top: number; left: number } | null {
  // Per <input> e <textarea>: usa l'approssimazione character width
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement
  ) {
    // Calcola la dimensione media di un carattere (mono-spaced approssimation)
    const computed = window.getComputedStyle(el);
    const fontSize = parseFloat(computed.fontSize) || 14;
    const charWidth = fontSize * 0.55; // approssimazione media
    const lineHeight = parseFloat(computed.lineHeight) || fontSize * 1.4;
    const textValue = el.value || "";
    // Trova la riga corrente: contiamo i newline prima di `position`
    const textUpToCaret = textValue.slice(0, position);
    const lines = textUpToCaret.split("\n");
    const currentLine = lines.length - 1;
    const charInLine = lines[lines.length - 1].length;

    // Offset del campo rispetto al parent positioned (assoluto relativo)
    const rect = el.getBoundingClientRect();
    const parentRect = el.parentElement?.getBoundingClientRect() ?? rect;

    return {
      top: rect.top - parentRect.top + currentLine * lineHeight + 2,
      left: rect.left - parentRect.left + charInLine * charWidth + 4,
    };
  }
  // Per contenteditable o altri: fallback (0,0) — l'app caller può sovrascrivere
  return { top: 0, left: 0 };
}
