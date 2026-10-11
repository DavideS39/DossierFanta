/**
 * Stamp — timbro rotato riusabile (design system taccuino M2).
 *
 * Implementa il componente 2 del design system (PDF Cap.16):
 * - Bordo doppio (border + outline)
 * - Testo Special Elite uppercase
 * - Rotazione -8° a +12° casuale (se `rotation` non specificato)
 * - Effetto inchiostro assorbito: opacity < 1
 *
 * Varianti colore (vedi taccuino.css):
 *   - "scoutato"  → verde (#4A6741), opacity 0.85
 *   - "da-fare"   → ambra (#B8860B), opacity 0.85
 *   - "archiviato"→ rosso sbiadito (#A53028), opacity 0.6
 *   - "top"       → rosso (#8B2E1F), opacity 0.85
 *   - "custom"    → colore via prop `color`
 */

import { useId } from "react";

export type StampVariant = "scoutato" | "da-fare" | "archiviato" | "top" | "custom";

interface StampProps {
  /** Testo del timbro. Viene uppercase automaticamente. */
  children: string;
  /** Variante colore predefinita. */
  variant?: StampVariant;
  /** Colore custom (usato solo se variant === "custom"). */
  color?: string;
  /**
   * Rotazione in gradi. Se non specificata, viene generata una rotazione
   * casuale tra -8° e +12° (stabile per istanza tramite useId() come seed).
   */
  rotation?: number;
  /** Classi addizionali da applicare. */
  className?: string;
  /** Style inline addizionale (es. fontSize). */
  style?: React.CSSProperties;
}

export function Stamp({
  children,
  variant = "scoutato",
  color,
  rotation,
  className = "",
  style,
}: StampProps) {
  // Seed stabile per istanza: useId() ritorna stringa univoca, la hashiamo
  // per ottenere un numero pseudo-casuale stabile tra -8 e +12.
  const id = useId();
  const seed = hashString(id);
  const fallbackRotation = (seed % 21) - 8; // -8 .. +12
  const rot = rotation ?? fallbackRotation;

  const variantCls =
    variant === "custom"
      ? ""
      : `tacc-stamp--${variant}`;

  return (
    <span
      className={`tacc-stamp ${variantCls} ${className}`.trim()}
      style={{
        // @ts-expect-error custom property
        "--stamp-rot": `${rot}deg`,
        ...(variant === "custom" && color ? { color } : {}),
        ...style,
      }}
      aria-label={children}
    >
      {children.toUpperCase()}
    </span>
  );
}

/** Hash deterministico di una stringa → intero (per seed di rotazione). */
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}
