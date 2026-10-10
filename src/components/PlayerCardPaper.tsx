/**
 * PlayerCardPaper — scheda giocatore stile "torn paper" realistica (v2.3.1).
 *
 * Design basato sulla reference vecteezy (realistic brown torn ripped paper):
 *  - Sfondo carta warm ivory (#F2E6E0 / #FAFAF8) — più chiaro del M2 paper
 *  - Bordo strappato organico con 24+ punti clip-path (non geometrico)
 *  - Ombra multi-layer 3-strati (contact + ambient + depth) molto più marcata
 *  - SVG filter feTurbulence per texture granulare della carta (opzionale)
 *  - Nastro adesivo arancione in alto (centrato, leggermente ruotato)
 *  - Ombra layer posteriore (carta sotto, ruotata) per profondità 3D
 *  - Pinzatrice decorativa SVG in alto a sinistra (per priority 5/5)
 *  - Stats values BIG in rosso (#C0392B) + label minuscole uppercase
 *
 * Rispetto a PlayerCardTaccuino (M2):
 *  - Card più grande e densa
 *  - Layout gerarchico: header · stats grid · footer timbro
 *  - Stats values più grandi (fino a 32px per valori top, 24px per altri)
 *  - Footer con "APPROVED" stamp ruotato + ID giocatore (UUID breve)
 *
 * Mantiene tutti i comportamenti di PlayerCardTaccuino:
 *  - Timbro cliccabile per toggle status (M2.1 B3)
 *  - GlossaryTooltip su f₥ / M / MV / FVM (M2.1 B4)
 *  - Doppio-click → detach OS nativa (M2.1 B5)
 *  - Click singolo → WM in-app
 *  - Toggle "taccuino pulito" via body.tacc-clean-mode
 */

import { useId, useMemo, useState } from "react";
import type { Player } from "@/types/player";
import { fmtFmil, fmtMed, fmtMedv, fmtFvm, FASCIA_COLORS, ROLE_COLORS } from "@/lib/format";
import { Stamp } from "./Stamp";
import { GlossaryTooltip } from "./GlossaryTooltip";
import { StatusToggle } from "./StatusToggle";

interface Props {
  player: Player;
  selected: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  /** M2.1 B5 — Doppio-click sulla card: stacca in finestra OS nativa. */
  onDetachOs?: () => void;
  /** Se true, mostra il chip "ARCHIVIATO" rosso sbiadito e disabilita le azioni. */
  archived?: boolean;
  /** Nome del DB di provenienza, se diverso dal DB attivo (per chip). */
  dbLabel?: string | null;
}

export function PlayerCardPaper({
  player,
  selected,
  onSelect,
  onEdit,
  onDelete,
  onDetachOs,
  archived = false,
  dbLabel,
}: Props) {
  // Rotazione casuale ±0.7° stabile per istanza
  const id = useId();
  const rotation = useMemo(() => {
    const seed = hashString(id);
    return (((seed % 15) - 7) / 10); // -0.7 .. +0.7
  }, [id]);

  // Variante colore carta: pseudo-random tra 3 tonalità (stable per istanza)
  const paperVariant = useMemo(() => {
    const seed = hashString(id);
    const variants = [
      { bg: "#F5EDE3", edge: "#E8DFD3", shadow: "rgba(60, 50, 40, 0.18)" }, // ivory warm
      { bg: "#FAF6ED", edge: "#EDE5D5", shadow: "rgba(60, 50, 40, 0.16)" }, // off-white cream
      { bg: "#F2E6E0", edge: "#E5D5CD", shadow: "rgba(60, 50, 40, 0.20)" }, // rosa-beige chiaro
    ];
    return variants[seed % variants.length];
  }, [id]);

  const role = player.pos_fanta;
  const roleColor = role ? ROLE_COLORS[role] : null;
  const fasciaColor = player.fascia ? FASCIA_COLORS[player.fascia] ?? "#6B4A2C" : null;
  const isMaxPriority = player.priority >= 5;

  // M2.1 B3: stato locale per il menu di toggle status
  const [statusMenu, setStatusMenu] = useState<{ x: number; y: number } | null>(null);

  const handleCardClick = () => {
    if (archived) return;
    onSelect();
    onEdit();
  };

  const handleStatusClick = (e: React.MouseEvent) => {
    if (archived) return;
    e.stopPropagation();
    e.preventDefault();
    setStatusMenu({ x: e.clientX, y: e.clientY + 16 });
  };

  // Clip-path per bordo strappato organico: 24 punti top + 24 punti bottom
  // per evitare l'aspetto "geometrico" del polygon 30-punti di PlayerCardTaccuino
  const tornClipPath = useMemo(() => {
    const seed = hashString(id);
    // Genera punti pseudo-random ma stabili
    const topPoints: string[] = [];
    const bottomPoints: string[] = [];
    for (let i = 0; i <= 100; i += 4) {
      const topVar = ((seed >> i) & 0xF) / 15 * 4; // 0..4
      const botVar = ((seed >> (i + 8)) & 0xF) / 15 * 4;
      topPoints.push(`${i}% ${topVar}%`);
      bottomPoints.push(`${100 - i}% ${100 - botVar}%`);
    }
    return `polygon(${topPoints.join(", ")}, ${bottomPoints.join(", ")})`;
  }, [id]);

  return (
    <div
      className="tacc-paper-shell"
      style={{
        position: "relative",
        transform: `rotate(${rotation}deg)`,
        cursor: archived ? "default" : "pointer",
      }}
    >
      {/* SVG filter per texture noise carta (def una volta sola, hidden) */}
      <svg
        aria-hidden
        style={{ position: "absolute", width: 0, height: 0, overflow: "hidden" }}
      >
        <defs>
          <filter id={`paper-texture-${id.slice(1, 9)}`}>
            <feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="3" stitchTiles="stitch" />
            <feColorMatrix type="matrix" values="1 0 0 0 0, 0 1 0 0 0, 0 0 1 0 0, 0 0 0 0.04 0" />
            <feComposite operator="in" in2="SourceGraphic" />
            <feBlend in="SourceGraphic" mode="multiply" />
          </filter>
        </defs>
      </svg>

      {/* Layer ombra posteriore: carta sotto ruotata per profondità 3D */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          backgroundColor: paperVariant.edge,
          transform: `rotate(${rotation > 0 ? -1 : 1}deg) translate(4px, 6px) scale(0.985)`,
          opacity: 0.55,
          filter: "blur(0.5px)",
          borderRadius: 2,
          boxShadow: "0 2px 4px rgba(60, 50, 40, 0.10)",
        }}
      />

      {/* Carta principale */}
      <div
        className={`tacc-paper ${selected ? "is-selected" : ""} ${archived ? "is-archived" : ""}`}
        style={{
          position: "relative",
          backgroundColor: paperVariant.bg,
          color: "#2C241B",
          clipPath: tornClipPath,
          // Multi-layer shadow per effetto carta posata
          boxShadow: selected
            ? `0 0 0 2px var(--red), 0 2px 4px ${paperVariant.shadow}, 0 8px 16px rgba(43, 27, 18, 0.20), 0 16px 32px rgba(43, 27, 18, 0.12)`
            : `0 1px 2px ${paperVariant.shadow}, 0 4px 8px rgba(43, 27, 18, 0.14), 0 12px 24px rgba(43, 27, 18, 0.10)`,
          transition: "transform 200ms ease, box-shadow 200ms ease",
          cursor: archived ? "default" : "pointer",
          padding: "1.5rem 1.1rem 1.1rem",
          minHeight: "280px",
        }}
        onClick={handleCardClick}
        onDoubleClick={(e) => {
          if (archived) return;
          e.stopPropagation();
          e.preventDefault();
          if (onDetachOs) onDetachOs();
        }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleCardClick();
          }
        }}
        title={`${archived ? "Archiviato: " : ""}${player.name} — doppio-click per finestra OS nativa`}
        aria-label={`${archived ? "Archiviato: " : ""}${player.name}`}
      >
        {/* Layer: texture noise overlay sottile */}
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            opacity: 0.6,
            mixBlendMode: "multiply",
            backgroundImage: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 200'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='1 0 0 0 0, 0 1 0 0 0, 0 0 1 0 0, 0 0 0 0.04 0'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>")`,
          }}
        />

        {/* Nastro adesivo arancione in alto (centrato, leggermente ruotato) */}
        {!archived && (
          <div
            aria-hidden
            style={{
              position: "absolute",
              top: "-10px",
              left: "50%",
              transform: `translateX(-50%) rotate(${(rotation * -2 - 1).toFixed(2)}deg)`,
              width: "70px",
              height: "20px",
              backgroundColor: "#F4B350",
              opacity: 0.85,
              boxShadow: "0 2px 4px rgba(0,0,0,0.10)",
              // Strisce orizzontali molto sottili per simulare la trama del nastro adesivo
              backgroundImage:
                "repeating-linear-gradient(0deg, transparent 0px, transparent 4px, rgba(0,0,0,0.04) 4px, rgba(0,0,0,0.04) 5px)",
              borderLeft: "1px dashed rgba(60,50,40,0.25)",
              borderRight: "1px dashed rgba(60,50,40,0.25)",
              zIndex: 5,
            }}
          />
        )}

        {/* Pinzatrice decorativa SVG (priority 5/5) */}
        {isMaxPriority && !archived && (
          <svg
            aria-hidden
            viewBox="0 0 24 40"
            style={{
              position: "absolute",
              top: "-12px",
              left: "8px",
              width: "14px",
              height: "24px",
              transform: "rotate(-12deg)",
              filter: "drop-shadow(1px 1px 0 rgba(0,0,0,0.20))",
              zIndex: 6,
              pointerEvents: "none",
            }}
          >
            <path
              d="M12,0 L12,28 Q12,36 6,36 Q0,36 0,30 Q0,24 6,24 Q12,24 12,32"
              fill="none"
              stroke="#2C241B"
              strokeWidth={2.5}
              strokeLinecap="round"
            />
            <circle cx="12" cy="6" r="2" fill="#2C241B" />
          </svg>
        )}

        {/* Contenuto */}
        <div style={{ position: "relative", zIndex: 2 }}>
          {/* Header: nome + ruolo + squadra */}
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: "0.5rem",
              marginBottom: "0.85rem",
              paddingBottom: "0.75rem",
              borderBottom: "2px dashed #D4C9B8",
            }}
          >
            {roleColor && (
              <span
                style={{
                  flexShrink: 0,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: "1.75rem",
                  height: "1.75rem",
                  fontFamily: "var(--font-display)",
                  fontWeight: "bold",
                  fontSize: "0.85rem",
                  backgroundColor: roleColor.bg,
                  color: roleColor.fg,
                  borderRadius: 2,
                }}
                title={`Ruolo fantacalcio: ${role}`}
              >
                {role}
              </span>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontFamily: "var(--font-display)",
                  fontSize: "1.05rem",
                  fontWeight: "bold",
                  color: "#2C241B",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  letterSpacing: "-0.01em",
                }}
              >
                {player.name}
              </div>
              <div
                style={{
                  fontFamily: "var(--font-body)",
                  fontSize: "0.7rem",
                  color: "#5C5347",
                  fontStyle: "italic",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {player.team ?? "—"}
                {player.pos_real ? ` · ${player.pos_real}` : ""}
              </div>
            </div>
            {!isMaxPriority && (
              <GlossaryTooltip term="priorita">
                <div
                  style={{
                    fontFamily: "var(--font-display)",
                    fontSize: "0.7rem",
                    color: "var(--amber)",
                    flexShrink: 0,
                  }}
                  title={`Priorità ${player.priority}/5`}
                >
                  <span aria-hidden>
                    {"★".repeat(player.priority)}
                    <span style={{ color: "rgba(43,27,18,0.18)" }}>
                      {"★".repeat(5 - player.priority)}
                    </span>
                  </span>
                </div>
              </GlossaryTooltip>
            )}
          </div>

          {/* Fascia + status timbri */}
          <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap", marginBottom: "0.85rem" }}>
            {player.fascia && (
              <GlossaryTooltip term="fascia">
                <span
                  style={{
                    display: "inline-block",
                    padding: "0.15rem 0.45rem",
                    fontFamily: "var(--font-display)",
                    fontSize: "0.6rem",
                    fontWeight: "bold",
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                    backgroundColor: fasciaColor ?? "#6B4A2C",
                    color: "#FFF",
                    borderRadius: 2,
                  }}
                >
                  {player.fascia}
                </span>
              </GlossaryTooltip>
            )}
            {!archived && (
              <span
                onClick={handleStatusClick}
                title="Click per cambiare stato"
                style={{ cursor: "pointer", display: "inline-flex", alignItems: "center", gap: "0.2rem" }}
              >
                {player.status === "scoutato" ? (
                  <Stamp variant="scoutato">Scoutato</Stamp>
                ) : player.status === "da_fare" ? (
                  <Stamp variant="da-fare">Da fare</Stamp>
                ) : (
                  <Stamp variant="custom" color="#5C5347">Totale</Stamp>
                )}
                <span
                  style={{ fontSize: "0.6rem", color: "#8B7355", opacity: 0.7, fontFamily: "var(--font-display)" }}
                  aria-hidden
                >
                  ⇄
                </span>
              </span>
            )}
            {archived && <Stamp variant="archiviato">Archiviato</Stamp>}
          </div>

          {/* Stats grid: valori BIG con label minuscole */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "0.65rem 0.75rem",
              padding: "0.5rem 0",
              borderTop: "1px solid rgba(43,27,18,0.08)",
              borderBottom: "1px solid rgba(43,27,18,0.08)",
            }}
          >
            <StatBox
              label="f₥"
              value={fmtFmil(player.fmil_spesi).replace("f₥ ", "")}
              raw={fmtFmil(player.fmil_spesi)}
              term="fmil"
              accent={player.fmil_spesi !== null && player.fmil_spesi > 50}
            />
            <StatBox
              label="FVM"
              value={player.fvm !== null ? String(player.fvm) : "—"}
              raw={fmtFvm(player.fvm)}
              term="fvm"
              accent={player.fvm !== null && player.fvm > 30}
            />
            <StatBox
              label="M"
              value={player.med !== null ? player.med.toFixed(2) : "—"}
              raw={fmtMed(player.med)}
              term="med"
            />
            <StatBox
              label="MV"
              value={player.medv !== null ? player.medv.toFixed(2) : "—"}
              raw={fmtMedv(player.medv)}
              term="medv"
              accent={player.medv !== null && player.medv >= 6.5}
            />
          </div>

          {/* Chip DB provenienza (se diverso dal attivo) */}
          {dbLabel && (
            <div style={{ marginTop: "0.5rem" }}>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.2rem",
                  padding: "0.1rem 0.4rem",
                  fontFamily: "var(--font-body)",
                  fontSize: "0.55rem",
                  backgroundColor: "rgba(43,27,18,0.08)",
                  border: "1px solid rgba(43,27,18,0.20)",
                  borderRadius: 2,
                  color: "#5C5347",
                  textTransform: "lowercase",
                }}
              >
                » {dbLabel}
              </span>
            </div>
          )}

          {/* Footer: timbro stato + ID giocatore */}
          <div
            style={{
              marginTop: "0.85rem",
              paddingTop: "0.5rem",
              borderTop: "1px solid rgba(43,27,18,0.08)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-end",
              gap: "0.5rem",
            }}
          >
            {/* Azioni hover */}
            {!archived && (
              <div style={{ display: "flex", gap: "0.3rem" }}>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onEdit();
                  }}
                  style={{
                    padding: "0.2rem 0.5rem",
                    fontSize: "0.65rem",
                    color: "var(--blue)",
                    border: "1px solid rgba(44,74,107,0.4)",
                    background: "transparent",
                    cursor: "pointer",
                    fontFamily: "var(--font-body)",
                  }}
                  title="Modifica"
                >
                  ✎
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete();
                  }}
                  style={{
                    padding: "0.2rem 0.5rem",
                    fontSize: "0.65rem",
                    color: "var(--red)",
                    border: "1px solid rgba(139,46,31,0.4)",
                    background: "transparent",
                    cursor: "pointer",
                    fontFamily: "var(--font-body)",
                  }}
                  title="Elimina"
                >
                  ✕
                </button>
              </div>
            )}
            <div
              style={{
                marginLeft: "auto",
                fontFamily: "var(--font-body)",
                fontSize: "0.55rem",
                color: "rgba(92,83,71,0.65)",
                textTransform: "uppercase",
                letterSpacing: "0.04em",
              }}
              title={`ID: ${player.id}`}
            >
              ID: {player.id.slice(0, 8).toUpperCase()}
            </div>
          </div>
        </div>

        {/* Status toggle menu (portal-like fixed) */}
        {statusMenu && (
          <StatusToggle
            player={player}
            x={statusMenu.x}
            y={statusMenu.y}
            onClose={() => setStatusMenu(null)}
          />
        )}
      </div>
    </div>
  );
}

/** StatBox: singolo valore stat con label minuscola. Valori "accent" (top) in rosso. */
function StatBox({
  label,
  value,
  raw,
  term,
  accent,
}: {
  label: string;
  value: string;
  raw: string;
  term: "fmil" | "med" | "medv" | "fvm" | "fascia" | "priorita";
  accent?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: "0.1rem",
        position: "relative",
      }}
      title={raw}
    >
      <GlossaryTooltip term={term}>
        <span
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "0.55rem",
            textTransform: "uppercase",
            letterSpacing: "0.15em",
            color: "#8B7355",
          }}
        >
          {label}
        </span>
      </GlossaryTooltip>
      <span
        style={{
          fontFamily: "var(--font-display)",
          fontSize: accent ? "1.4rem" : "1.15rem",
          fontWeight: "bold",
          color: accent ? "#C0392B" : "#2C241B",
          lineHeight: 1.1,
          // Sottolineatura manuale stile penna
          borderBottom: "1.5px solid rgba(43,27,18,0.20)",
          paddingBottom: "1px",
          display: "inline-block",
          minWidth: "2.5rem",
        }}
      >
        {value}
      </span>
    </div>
  );
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}
