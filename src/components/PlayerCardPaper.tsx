/**
 * PlayerCardPaper — scheda giocatore come CARTOLINA STRAPPATA reale (v2.3.2).
 *
 * v2.3.2 (restyling fotografico, Cap.16): il fondo della card è una delle
 * 4 texture fotografiche in src/assets/paper/ (PNG strappati reali forniti
 * dal product owner, normalizzati in WebP RGBA). Il bordo irregolare NON è
 * un clip-path CSS: è l'alpha della foto. Le ombre multilayer del Cap.16
 * (contact / mid / ambient) sono `filter: drop-shadow()` applicati al solo
 * layer di sfondo, quindi la sagoma strappata proietta la PROPRIA ombra
 * sulla scrivania. Hover: la card si raddrizza e si solleva (Z1→Z2).
 * Selezione: alone rosso timbro attorno alla sagoma.
 *
 * Layout interno (dentro la safe-area misurata per variante):
 *   riga 1  nome (Special Elite) + chip ruolo
 *   riga 2  squadra · ruolo reale · db
 *   riga 3  timbri: priorità ★ · fascia · stato (click ⇄ toggle manuale)
 *   riga 4  stats f₥ / FVM / M / MV con tooltip glossario (?)
 *   riga 5  footer: chip DB · id · azioni al hover (✎ ✕ ⧉)
 *   pinzatrice □ posata in alto a sx per priority 5/5 (Cap.16 comp.4)
 *
 * Comportamenti preservati da M2.1:
 *  - click card → seleziona + apre finestra WM in-app
 *  - doppio-click → detach in finestra OS nativa (Tauri multi-window)
 *  - click timbro stato → menu 3 voci (Scoutato / Da fare / Totale)
 *  - archived → read-only, desaturata, timbro ARCHIVIATO
 */

import { useMemo, useState } from "react";
import type { Player } from "@/types/player";
import { fmtFmil, FASCIA_COLORS, ROLE_COLORS } from "@/lib/format";
import { paperFor, hashString, type PaperVariant } from "@/assets/paper";
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
  onDelete,
  onEdit,
  onDetachOs,
  archived = false,
  dbLabel,
}: Props) {
  const paper = useMemo(() => paperFor(player.id), [player.id]);

  // Rotazione casuale ±0.7° stabile per giocatore (Cap.16 comp.1)
  const rotation = useMemo(() => {
    const seed = hashString(player.id);
    return ((seed % 15) - 7) / 10; // -0.7 .. +0.7
  }, [player.id]);

  const role = player.pos_fanta;
  const roleColor = role ? ROLE_COLORS[role] : null;
  const fasciaColor = player.fascia ? FASCIA_COLORS[player.fascia] ?? "#6B4A2C" : null;
  const isMaxPriority = player.priority >= 5;

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
    setStatusMenu({ x: e.clientX, y: e.clientY + 14 });
  };

  const safeStyle = {
    "--paper-img": `url("${paper.img}")`,
    "--aspect": String(paper.aspect),
    "--safe-t": `${paper.safe.t}%`,
    "--safe-r": `${paper.safe.r}%`,
    "--safe-b": `${paper.safe.b}%`,
    "--safe-l": `${paper.safe.l}%`,
    "--rot": `${rotation}deg`,
  } as React.CSSProperties;

  return (
    <div
      className={`pcard-shell ${selected ? "is-selected" : ""} ${archived ? "is-archived" : ""}`}
      style={{ ...safeStyle, cursor: archived ? "default" : "pointer" }}
    >
      {/* Layer fotografico: alpha = bordo strappato, drop-shadow = ombre Cap.16 */}
      <div className="pcard-paper" aria-hidden />

      {/* Contenuto dentro la safe-area */}
      <div
        className="pcard-content"
        onClick={handleCardClick}
        onDoubleClick={(e) => {
          if (archived) return;
          e.stopPropagation();
          e.preventDefault();
          if (onDetachOs) onDetachOs();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleCardClick();
          }
        }}
        role="button"
        tabIndex={0}
        title={`${archived ? "Archiviato: " : ""}${player.name} — doppio-click per finestra OS nativa`}
        aria-label={`${archived ? "Archiviato: " : ""}${player.name}`}
      >
        {isMaxPriority && !archived && (
          <span className="pcard-staple" aria-label="priorità massima: pinzatrice">
            ▫
          </span>
        )}

        <div className="pcard-head">
          <span className="pcard-name">{player.name}</span>
          {role && roleColor && (
            <span className="pcard-role" style={{ backgroundColor: roleColor.bg }} title={roleColor.label}>
              {role}
            </span>
          )}
        </div>

        <div className="pcard-meta">
          {player.team ?? "squadra n/d"}
          {player.pos_real ? ` · ${player.pos_real}` : ""}
        </div>

        <div className="pcard-stamps">
          <GlossaryTooltip term="priorita">
            <span className="pcard-stars" aria-label={`priorità ${player.priority} su 5`}>
              {"★".repeat(Math.max(0, Math.min(5, player.priority)))}
              <span className="off">{"★".repeat(Math.max(0, 5 - player.priority))}</span>
            </span>
          </GlossaryTooltip>

          {player.fascia && (
            <GlossaryTooltip term="fascia">
              <Stamp variant="custom" color={fasciaColor ?? undefined}>
                {player.fascia}
              </Stamp>
            </GlossaryTooltip>
          )}

          {!archived ? (
            <span
              onClick={handleStatusClick}
              title="Click per cambiare stato (toggle manuale)"
              style={{ cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 3 }}
            >
              {player.status === "scoutato" ? (
                <Stamp variant="scoutato">Scoutato</Stamp>
              ) : player.status === "da_fare" ? (
                <Stamp variant="da-fare">Da fare</Stamp>
              ) : (
                <Stamp variant="custom" color="#5C5347">Totale</Stamp>
              )}
              <span aria-hidden style={{ fontSize: 9, color: "rgba(90,70,50,0.65)", fontFamily: "var(--font-display)" }}>
                ⇄
              </span>
            </span>
          ) : (
            <Stamp variant="archiviato">Archiviato</Stamp>
          )}
        </div>

        <div className="pcard-stats">
          <Stat term="fmil" label="f₥" value={fmtFmil(player.fmil_spesi).replace("f₥ ", "")} accent={player.fmil_spesi !== null && player.fmil_spesi > 50} />
          <Stat term="fvm" label="FVM" value={player.fvm !== null ? String(player.fvm) : "—"} accent={player.fvm !== null && player.fvm > 30} />
          <Stat term="med" label="M" value={player.med !== null ? player.med.toFixed(2) : "—"} />
          <Stat term="medv" label="MV" value={player.medv !== null ? player.medv.toFixed(2) : "—"} accent={player.medv !== null && player.medv >= 6.5} />
        </div>

        <div className="pcard-foot">
          {dbLabel && <span className="pcard-dbchip">» {dbLabel}</span>}
          <span className="pcard-id" title={`ID: ${player.id}`}>
            {player.id.slice(-4).toUpperCase()}
          </span>
        </div>

        {!archived && (
          <span className="pcard-actions" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="pcard-action" title="Apri scheda (WM)" onClick={onEdit}>
              ✎
            </button>
            {onDetachOs && (
              <button type="button" className="pcard-action" title="Stacca in finestra OS" onClick={onDetachOs}>
                ⧉
              </button>
            )}
            <button type="button" className="pcard-action pcard-action--del" title="Elimina" onClick={onDelete}>
              ✕
            </button>
          </span>
        )}
      </div>

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

/** Cella stat: label minuscola con tooltip glossario + valore typewriter. */
function Stat({
  term,
  label,
  value,
  accent,
}: {
  term: "fmil" | "med" | "medv" | "fvm";
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <span className="pcard-stat">
      <GlossaryTooltip term={term}>
        <span className="pcard-stat-label">{label}</span>
      </GlossaryTooltip>
      <span className={`pcard-stat-value ${accent ? "accent" : ""}`}>{value}</span>
    </span>
  );
}

export type { PaperVariant };
