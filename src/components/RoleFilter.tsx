import { usePlayersStore } from "@/stores/usePlayersStore";
import { POS_FANTA_VALUES } from "@/types/player";
import { ROLE_COLORS } from "@/lib/format";

/**
 * Filtro ruolo: chip "Tutti" + chip per ogni ruolo (P/D/C/A).
 * Click su una chip setta roleFilter nello store, che triggera refresh().
 *
 * M2: stile taccuino applicato (font-family display, border angoli vivi).
 */
export function RoleFilter() {
  const roleFilter = usePlayersStore((s) => s.roleFilter);
  const setRoleFilter = usePlayersStore((s) => s.setRoleFilter);

  return (
    <div className="flex items-center gap-1 flex-wrap" role="group" aria-label="Filtra per ruolo">
      <button
        type="button"
        onClick={() => setRoleFilter(null)}
        className={`px-3 py-1 text-sm border transition-colors ${roleFilter === null ? "bg-ink text-paper border-ink" : "bg-paper text-ink border-ink/30 hover:border-ink"}`}
        style={{ fontFamily: "var(--font-display)" }}
        aria-pressed={roleFilter === null}
      >
        Tutti
      </button>
      {POS_FANTA_VALUES.map((role) => {
        const active = roleFilter === role;
        const c = ROLE_COLORS[role];
        return (
          <button
            key={role}
            type="button"
            onClick={() => setRoleFilter(role)}
            className="px-3 py-1 text-sm border transition-all"
            style={{
              fontFamily: "var(--font-display)",
              backgroundColor: active ? c.bg : "transparent",
              color: active ? c.fg : c.bg,
              borderColor: c.bg,
            }}
            aria-pressed={active}
          >
            {role}
          </button>
        );
      })}
    </div>
  );
}
