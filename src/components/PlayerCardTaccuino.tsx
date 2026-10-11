/**
 * PlayerCardTaccuino — card giocatore redesigned (M2 design system + M2.1 v2.3 realistic).
 *
 * M2.1 v2.3 (Cap.16 riscritto):
 *  - Scheda strappata 8-12 punti via clip-path (.tacc-card--v23)
 *  - Ombre multilayer 3-strati (contact/mid/ambient) su .tacc-card--v23
 *  - Hover: si raddrizza (rotate(0deg)) + translateY(-3px) + ombre +50%
 *  - Bordi più organici (8-12 punti con variazione non lineare)
 *  - Ombra interna sul bordo strappato (inset shadow via filter)
 *  - Z-axis: card = Z1, hover = Z2
 *
 * M2.1 v2.3 (Cap.8 + Cap.9 riscritti):
 *  - Timbro di stato cliccabile → menu a 3 voci (Scoutato/Da fare/Totale)
 *    (StatusToggle component). Click → set_player_status(playerId, newStatus)
 *  - Tooltip glossario ? accanto a f₥, M, MV, FVM, fascia, priorità
 *    (GlossaryTooltip component). Hover mostra definizione in popover cartaceo.
 *
 * Click sulla card → apre form come finestra WM (M2.1 v2.3 Cap.17).
 * Doppio-click → apre in finestra OS nativa (open_player_window).
 *
 * Pinzatrice □ in angolo top-left quando priority === 5/5.
 * f₥ Fantamilioni (glifo Unicode U+20A5).
 * Chip DB provenienza (se il player appartiene a un DB non attivo).
 * Niente emoji: solo glyph testuali Unicode (★ ◆ ▲ ▼ → » □ ⚠ ✓ ? ₥ ⇄ ─ ✕).
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
  /**
   * M2.1 B5 — Doppio-click sulla card: stacca la scheda in finestra OS nativa
   * via api.openPlayerWindow(player_id). Se omitted, il doppio-click non fa
   * nulla di diverso dal single-click (apre WM in-app).
   */
  onDetachOs?: () => void;
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
  onDetachOs,
  archived = false,
  dbLabel,
}: Props) {
  // Rotazione casuale ±0.7° stabile per istanza (v2.3: leggermente più accentuata)
  const id = useId();
  const rotation = useMemo(() => {
    const seed = hashString(id);
    return (((seed % 15) - 7) / 10); // -0.7 .. +0.7
  }, [id]);

  const role = player.pos_fanta;
  const roleColor = role ? ROLE_COLORS[role] : null;
  const fasciaColor = player.fascia ? FASCIA_COLORS[player.fascia] ?? "#6B4A2C" : null;
  const isMaxPriority = player.priority >= 5;

  // M2.1 B3: stato locale per il menu di toggle status
  const [statusMenu, setStatusMenu] = useState<{ x: number; y: number } | null>(null);

  const handleCardClick = () => {
    if (archived) return; // archived = read-only
    onSelect();
    onEdit();
  };

  const handleStatusClick = (e: React.MouseEvent) => {
    if (archived) return;
    e.stopPropagation();
    e.preventDefault();
    setStatusMenu({ x: e.clientX, y: e.clientY + 16 });
  };

  return (
    <div
      className={`tacc-card tacc-card--v23 ${selected ? "is-selected" : ""} ${archived ? "is-archived" : ""}`}
      style={{ transform: `rotate(${rotation}deg)` }}
      onClick={handleCardClick}
      onDoubleClick={(e) => {
        // M2.1 B5: doppio-click sulla card → stacca in finestra OS nativa
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
      title={`${archived ? "Archiviato: " : ""}${player.name} — doppio-click per aprire in finestra OS nativa`}
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

        {/* Priorità: stelle (o niente se 5/5 → pinzatrice) — con tooltip */}
        {!isMaxPriority && (
          <GlossaryTooltip term="priorita">
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
          </GlossaryTooltip>
        )}
      </div>

      {/* Fascia + status (timbri rotati) */}
      <div className="mt-2 mb-2 flex items-center gap-2 flex-wrap">
        {player.fascia && (
          <GlossaryTooltip term="fascia">
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
          </GlossaryTooltip>
        )}
        {/* M2.1 B3: timbro di stato cliccabile */}
        {!archived && (
          <span
            onClick={handleStatusClick}
            title="Click per cambiare stato (Scoutato / Da fare / Totale)"
            style={{ cursor: "pointer", display: "inline-flex", alignItems: "center", gap: "0.2rem" }}
          >
            {player.status === "scoutato" ? (
              <Stamp variant="scoutato">Scoutato</Stamp>
            ) : player.status === "da_fare" ? (
              <Stamp variant="da-fare">Da fare</Stamp>
            ) : (
              <Stamp variant="custom" color="var(--ink-soft)">Totale</Stamp>
            )}
            <span
              className="tacc-glyph"
              style={{ fontSize: "10px", color: "var(--ink-soft)", opacity: 0.7 }}
              aria-hidden
            >
              ⇄
            </span>
          </span>
        )}
        {archived && <Stamp variant="archiviato">Archiviato</Stamp>}
      </div>

      {/* Valori disambiguati: f₥ / M / MV / FVM — con tooltip glossario (M2.1 B4) */}
      <div
        className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs"
        style={{ fontFamily: "var(--font-body)" }}
      >
        <ValueChipTooltip
          label="f₥"
          value={fmtFmil(player.fmil_spesi).replace("f₥ ", "")}
          raw={fmtFmil(player.fmil_spesi)}
          term="fmil"
        />
        <ValueChipTooltip
          label="FVM"
          value={player.fvm !== null ? String(player.fvm) : "—"}
          raw={fmtFvm(player.fvm)}
          term="fvm"
        />
        <ValueChipTooltip
          label="M"
          value={player.med !== null ? player.med.toFixed(2) : "—"}
          raw={fmtMed(player.med)}
          term="med"
        />
        <ValueChipTooltip
          label="MV"
          value={player.medv !== null ? player.medv.toFixed(2) : "—"}
          raw={fmtMedv(player.medv)}
          term="medv"
        />
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

      {/* Menu di toggle status (rendered outside the card via portal-like fixed positioning) */}
      {statusMenu && (
        <StatusToggle
          player={player}
          x={statusMenu.x}
          y={statusMenu.y}
          onClose={() => setStatusMenu(null)}
        />
      )}
    </div>
  );
}

function ValueChipTooltip({
  label,
  value,
  raw,
  term,
}: {
  label: string;
  value: string;
  raw: string;
  term: "fmil" | "med" | "medv" | "fvm" | "fascia" | "priorita";
}) {
  return (
    <div className="flex items-center gap-1" title={raw}>
      <GlossaryTooltip term={term}>
        <span
          className="text-ink-soft text-[10px] uppercase tracking-wider"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {label}
        </span>
      </GlossaryTooltip>
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
