/**
 * Tape — nastro adesivo riusabile (design system taccuino M2).
 *
 * Implementa il componente 3 del design system (PDF Cap.16):
 * - Div semi-trasparente giallo (rgba(217,196,112,0.55))
 * - Bordi tratteggiati laterali
 * - Leggera rotazione per effetto "incollato a mano"
 *
 * Usato per fissare "ritagli" insieme: tipicamente nella vista confronta
 * (M6, side-by-side) per indicare che due schede sono state "attaccate"
 * per il confronto. Disponibile già in M2 come componente riutilizzabile.
 */

interface TapeProps {
  children: React.ReactNode;
  /** Rotazione in gradi (default -0.8deg, leggera). */
  rotation?: number;
  /** Classi addizionali. */
  className?: string;
  /** Style inline addizionale. */
  style?: React.CSSProperties;
}

export function Tape({ children, rotation = -0.8, className = "", style }: TapeProps) {
  return (
    <div
      className={`tacc-tape ${className}`.trim()}
      style={{ transform: `rotate(${rotation}deg)`, ...style }}
    >
      {children}
    </div>
  );
}
