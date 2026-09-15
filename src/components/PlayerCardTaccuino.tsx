/**
 * PlayerCardTaccuino — card giocatore redesigned (M2 design system).
 *
 * Sostituisce PlayerCard M1 con il design taccuino scout 80s:
 * - Scheda strappata via clip-path (.tacc-card)
 * - Rotazione casuale ±0.5° (stabile per istanza)
 * - Hover: si raddrizza (rotate(0deg)) e si solleva (translateY(-2px))
 * - Timbri rotati per stato (Stamp component)
 * - Pinzatrice □ in angolo top-left quando priority === 5/5
 * - f₥ Fantamilioni (glifo Unicode U+20A5)
 * - Chip DB provenienza (se il player appartiene a un DB non attivo)
 * - Niente emoji: solo glyph testuali Unicode (★ ◆ ▲ ▼ → » □)
 *
 * Click: apre form di modifica (come in M1).
 * Pulsanti Modifica/Elimina in hover (come M1, con stopPropagation).
 */

import { useId, useMemo } from "react";
import type { Player } from "@/types/player";
import { fmtFmil, fmtMed, fmtMedv, fmtFvm, FASCIA_COLORS, ROLE_COLORS } from "@/lib/format";
import { Stamp } from "./Stamp";

interface Props {
  player: Player;
  selected: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  /** Se true, mostra il chip "ARCHIVIATO" rosso sbiadito e disabilita le azioni. */
  archived?: boolean;
  /** Nome del DB di provenienza, se diverso dal DB attivo (per chip). */
  dbLabel?: string | null;
}

export function PlayerCardTaccuino({
  player,
  selected,
  onSelect,
  onEdit,
  onDelete,
  archived = false,
  dbLabel,
}: Props) {
  // Rotazione casuale ±0.5° stabile per istanza
  const id = useId();
  const rotation = useMemo(() => {
    const seed = hashString(id);
    return ((seed % 11) - 5) / 10; // -0.5 .. +0.5
  }, [id]);

  const role = player.pos_fanta;
  const roleColor = role ? ROLE_COLORS[role] : null;
  const fasciaColor = player.fascia ? FASCIA_COLORS[player.fascia] ?? "#6B4A2C" : null;
  const isMaxPriority = player.priority >= 5;

  const handleCardClick = () => {
    if (archived) return; // archived = read-only
    onSelect();
    onEdit();
  };

  return (
    <div
      className={`tacc-card ${selected ? "is-selected" : ""} ${archived ? "is-archived" : ""}`}
      style={{ transform: `rotate(${rotation}deg)` }}
      onClick={handleCardClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleCardClick();
        }
      }}
      aria-label={`${archived ? "Archiviato: " : ""}${player.name}`}
    >
      {/* Pinzatrice (priority 5/5) */}
      {isMaxPriority && !archived && (
        <span className="tacc-pin" aria-hidden title="Priorità massima 5/5">
          □
        </span>
      )}

      {/* Header: ruolo badge + nome + squadra */}
      <div className="flex items-start gap-2 mb-1">
        {roleColor && (
          <span
            className="shrink-0 w-7 h-7 flex items-center justify-center font-display font-bold text-sm rounded-sm"
            style={{ backgroundColor: roleColor.bg, color: roleColor.fg }}
            title={`Ruolo fantacalcio: ${role}`}
          >
            {role}
          </span>
        )}
        <div className="flex-1 min-w-0">
          <div
            className="font-display text-base font-bold text-ink truncate"
            style={{ fontFamily: "var(--font-display)" }}
          >
            {player.name}
          </div>
          <div
            className="text-xs text-ink-soft truncate"
            style={{ fontFamily: "var(--font-body)" }}
          >
            {player.team ?? "—"}
            {player.pos_real ? ` · ${player.pos_real}` : ""}
          </div>
        </div>

        {/* Priorità: stelle (o niente se 5/5 → pinzatrice) */}
        {!isMaxPriority && (
          <div
            className="shrink-0 text-xs text-amber"
            style={{ fontFamily: "var(--font-display)" }}
            title={`Priorità ${player.priority}/5`}
          >
            <span aria-hidden>
              {"★".repeat(player.priority)}
              <span className="text-ink/20">{"★".repeat(5 - player.priority)}</span>
            </span>
          </div>
        )}
      </div>

      {/* Fascia + status (timbri rotati) */}
      <div className="mt-2 mb-2 flex items-center gap-2 flex-wrap">
        {player.fascia && (
          <span
            className="px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-sm"
            style={{
              fontFamily: "var(--font-display)",
              backgroundColor: fasciaColor ?? "#6B4A2C",
              color: "#FFF",
            }}
          >
            {player.fascia}
          </span>
        )}
        {archived ? (
          <Stamp variant="archiviato">Archiviato</Stamp>
        ) : player.status === "scoutato" ? (
          <Stamp variant="scoutato">Scoutato</Stamp>
        ) : player.status === "da_fare" ? (
          <Stamp variant="da-fare">Da fare</Stamp>
        ) : null}
      </div>

      {/* Valori disambiguati: f₥ / M / MV / FVM */}
      <div
        className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs"
        style={{ fontFamily: "var(--font-body)" }}
      >
        <ValueChip label="f₥" value={fmtFmil(player.fmil_spesi).replace("f₥ ", "")} raw={fmtFmil(player.fmil_spesi)} />
        <ValueChip label="FVM" value={player.fvm !== null ? String(player.fvm) : "—"} raw={fmtFvm(player.fvm)} />
        <ValueChip label="M" value={player.med !== null ? player.med.toFixed(2) : "—"} raw={fmtMed(player.med)} />
        <ValueChip label="MV" value={player.medv !== null ? player.medv.toFixed(2) : "—"} raw={fmtMedv(player.medv)} />
      </div>

      {/* Chip DB provenienza (se diverso dal attivo) */}
      {dbLabel && (
        <div className="mt-2">
          <span className="tacc-db-chip">» {dbLabel}</span>
        </div>
      )}

      {/* Azioni (nascondi se archiviato) */}
      {!archived && (
        <div className="mt-3 flex items-center gap-2 opacity-0 hover:opacity-100 group-hover:opacity-100 transition-opacity">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
            className="px-2 py-1 text-xs text-blue border border-blue/40 rounded hover:bg-blue hover:text-paper transition-colors"
            style={{ fontFamily: "var(--font-body)" }}
          >
            ✎ Modifica
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="px-2 py-1 text-xs text-red border border-red/40 rounded hover:bg-red hover:text-paper transition-colors"
            style={{ fontFamily: "var(--font-body)" }}
          >
            ✕ Elimina
          </button>
        </div>
      )}
    </div>
  );
}

function ValueChip({ label, value, raw }: { label: string; value: string; raw: string }) {
  return (
    <div className="flex items-center gap-1" title={raw}>
      <span
        className="text-ink-soft text-[10px] uppercase tracking-wider"
        style={{ fontFamily: "var(--font-display)" }}
      >
        {label}
      </span>
      <span className="font-bold text-ink">{value}</span>
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
