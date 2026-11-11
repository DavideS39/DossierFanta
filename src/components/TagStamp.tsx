/**
 * TagStamp — M4 (v2.6) — Tag-timbro rotato su carta.
 *
 * NON è un chip generico: è un timbro inchiostro su carta. Struttura:
 *  - Rotazione: stabile per label (hash-based, ±10°)
 *  - Colore: tag.color (HSL da hash) o derivato al volo da label
 *  - Texture: CSS con uneven coverage via box-shadow inset multipla
 *    (3 ombre inset per simulare assorbimento irregolare dell'inchiostro)
 *  - Bordo: 2px solid + outline 1px inset a opacità 0.5
 *  - Font: Special Elite (display), uppercase, letter-spacing 0.04em
 *  - Opacity 0.85 (timbro assorbito, non stampa fresca)
 *
 * Vincolo HARD #20: M4 NON fa overhaul grafico. Questo è il rendering BASE.
 * M4.G farà l'overhaul con texture inchiostro realistica (SVG, bleed,
 * micro-bolle). Per ora il CSS base è sufficiente — l'importante è che la
 * STRUTTURA sia un timbro rotato, non un chip piatto.
 *
 * PROPS:
 *  - tag: { id, label, color }
 *  - onRemove?: () => void (pulsante ✕)
 *  - onClick?: () => void (filter bar — toggle filtro)
 *  - selected?: boolean (filter bar active state)
 *  - size?: 'sm' | 'md' (sm per card, md per filter bar)
 */

import { useMemo } from "react";
import { hashToColor, hashToRotationDeg, hslToRgbTriple } from "@/lib/tagHash";

interface TagStampProps {
  tag: {
    id: string;
    label: string;
    color?: string | null;
  };
  onRemove?: () => void;
  onClick?: () => void;
  selected?: boolean;
  size?: "sm" | "md";
  /** Title HTML per il tooltip nativo. Default: label del tag. */
  title?: string;
}

export function TagStamp({
  tag,
  onRemove,
  onClick,
  selected = false,
  size = "md",
  title,
}: TagStampProps) {
  // Colore: usa tag.color se disponibile (cache da DB), altrimenti deriva
  // al volo da label (stesso algoritmo — garantito identico).
  const color = useMemo(
    () => tag.color ?? hashToColor(tag.label),
    [tag.color, tag.label],
  );
  // Rotazione: sempre derivata da label (mai cache — è deterministica).
  const rotation = useMemo(() => hashToRotationDeg(tag.label), [tag.label]);
  // Tripla RGB per rgba() del selected background.
  const [r, g, b] = useMemo(() => hslToRgbTriple(color), [color]);

  const isInteractive = !!onClick;
  const sizeClass = size === "sm" ? "tag-stamp--sm" : "tag-stamp--md";

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onClick) onClick();
  };
  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (onRemove) onRemove();
  };

  // Inline style per i CSS custom properties (rotazione + colore).
  // Le ombre inset (texture) sono nel CSS file (stabili, non cambiano per tag).
  const style: React.CSSProperties = {
    "--tag-color": color,
    "--tag-rgb": `${r}, ${g}, ${b}`,
    "--tag-rotation": `${rotation}deg`,
    cursor: isInteractive ? "pointer" : "default",
  } as React.CSSProperties;

  return (
    <span
      className={`tag-stamp ${sizeClass} ${selected ? "is-selected" : ""} ${isInteractive ? "is-clickable" : ""}`}
      style={style}
      onClick={isInteractive ? handleClick : undefined}
      title={title ?? tag.label}
      role={isInteractive ? "button" : undefined}
      tabIndex={isInteractive ? 0 : undefined}
      onKeyDown={
        isInteractive
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
      aria-pressed={isInteractive ? selected : undefined}
    >
      <span className="tag-stamp__label">{tag.label}</span>
      {onRemove && (
        <button
          type="button"
          className="tag-stamp__remove"
          onClick={handleRemove}
          aria-label={`Rimuovi tag "${tag.label}"`}
          title={`Rimuovi tag "${tag.label}"`}
        >
          ✕
        </button>
      )}
    </span>
  );
}
