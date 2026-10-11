import type { Player } from "@/types/player";
import {
  FASCIA_COLORS,
  ROLE_COLORS,
  STATUS_COLORS,
} from "@/lib/format";

interface Props {
  player: Player;
  selected: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

/**
 * Card singolo giocatore. Mostra nome, squadra, ruolo, fascia, priorità
 * e i 4 valori chiave (f₥, M, MV, FVM) con simboli disambiguati.
 *
 * Interazione (FIX D4 — chiusura M1):
 * - Click singolo sul corpo della card → prima seleziona (onSelect, evidenza
 *   visiva con bordo rosso) POI apre il form di modifica (onEdit).
 * - I pulsanti "✎ Modifica" e "✕ Elimina" in hover rimangono come scorciatoie
 *   esplicite; fermano la propagazione con stopPropagation per non ri-aprire
 *   il form due volte.
 * - Il pulsante "✕ Elimina" NON elimina direttamente: apre il dialog di
 *   conferma gestito dal parent.
 *
 * Il simbolo f₥ è renderizzato inline (Unicode U+20A5, vedi format.ts).
 */
export function PlayerCard({ player, selected, onSelect, onEdit, onDelete }: Props) {
  const role = player.pos_fanta;
  const roleColor = role ? ROLE_COLORS[role] : null;
  const statusColor = STATUS_COLORS[player.status] ?? STATUS_COLORS.totali;
  const fasciaColor = player.fascia
    ? FASCIA_COLORS[player.fascia] ?? "#6B4A2C"
    : null;

  // Click sul corpo della card: seleziona + apre form di modifica.
  // I bottoni interni chiamano stopPropagation per evitare il doppio-trigger.
  const handleCardClick = () => {
    onSelect();
    onEdit();
  };

  return (
    <div
      className={`group relative bg-paper border-2 rounded-md shadow-card hover:shadow-card-hover transition-all cursor-pointer ${
        selected ? "border-red ring-2 ring-red/20" : "border-ink/40"
      }`}
      onClick={handleCardClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleCardClick();
        }
      }}
      aria-label={`Modifica ${player.name}`}
    >
      {/* Colore fascia: barra verticale a sinistra */}
      <div
        aria-hidden
        className="absolute left-0 top-0 bottom-0 w-1.5 rounded-l"
        style={{ backgroundColor: fasciaColor ?? "transparent" }}
      />

      <div className="pl-4 pr-3 py-3">
        {/* Header: ruolo badge + nome + squadra */}
        <div className="flex items-start gap-2">
          {roleColor && (
            <span
              className="shrink-0 w-7 h-7 flex items-center justify-center font-display font-bold text-sm rounded"
              style={{ backgroundColor: roleColor.bg, color: roleColor.fg }}
              title={`Ruolo fantacalcio: ${role}`}
            >
              {role}
            </span>
          )}
          <div className="flex-1 min-w-0">
            <div className="font-display text-base font-bold text-ink truncate">
              {player.name}
            </div>
            <div className="font-body text-xs text-ink-soft truncate">
              {player.team ?? "—"}
              {player.pos_real ? ` · ${player.pos_real}` : ""}
            </div>
          </div>

          {/* Priorità: 5 stelle */}
          <div
            className="shrink-0 font-display text-xs text-amber"
            title={`Priorità ${player.priority}/5`}
          >
            {"★".repeat(player.priority)}
            <span className="text-ink/20">{"★".repeat(5 - player.priority)}</span>
          </div>
        </div>

        {/* Fascia + status */}
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          {player.fascia && (
            <span
              className="px-2 py-0.5 font-body text-[11px] font-bold uppercase tracking-wide rounded"
              style={{
                backgroundColor: fasciaColor ?? "#6B4A2C",
                color: "#FFF",
              }}
            >
              {player.fascia}
            </span>
          )}
          <span
            className="px-2 py-0.5 font-body text-[11px] uppercase tracking-wide rounded"
            style={{
              backgroundColor: statusColor.bg,
              color: statusColor.fg,
            }}
          >
            {statusColor.label}
          </span>
        </div>

        {/* Valori disambiguati: f₥ / M / MV / FVM */}
        <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 font-body text-xs">
          <ValueChip label="f₥" value={player.fmil_spesi ?? "—"} />
          <ValueChip label="FVM" value={player.fvm ?? "—"} />
          <ValueChip label="M" value={player.med !== null ? player.med.toFixed(2) : "—"} />
          <ValueChip label="MV" value={player.medv !== null ? player.medv.toFixed(2) : "—"} />
        </div>

        {/* Azioni */}
        <div className="mt-3 flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
            className="px-2 py-1 font-body text-xs text-blue border border-blue/40 rounded hover:bg-blue hover:text-paper transition-colors"
          >
            ✎ Modifica
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="px-2 py-1 font-body text-xs text-red border border-red/40 rounded hover:bg-red hover:text-paper transition-colors"
          >
            ✕ Elimina
          </button>
        </div>
      </div>
    </div>
  );
}

function ValueChip({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-ink-soft text-[10px] uppercase tracking-wider">{label}</span>
      <span className="font-bold text-ink">{value}</span>
    </div>
  );
}
