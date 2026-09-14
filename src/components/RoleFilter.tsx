import { usePlayersStore } from "@/stores/usePlayersStore";
import { POS_FANTA_VALUES } from "@/types/player";
import { ROLE_COLORS } from "@/lib/format";

/**
 * Filtro ruolo: chip "Tutti" + chip per ogni ruolo (P/D/C/A).
 * Click su una chip setta roleFilter nello store, che triggera refresh().
 */
export function RoleFilter() {
  const roleFilter = usePlayersStore((s) => s.roleFilter);
  const setRoleFilter = usePlayersStore((s) => s.setRoleFilter);

  return (
    <div className="flex items-center gap-1 flex-wrap" role="group" aria-label="Filtra per ruolo">
      <button
        type="button"
        onClick={() => setRoleFilter(null)}
        className={`px-3 py-1.5 font-body text-sm rounded border transition-colors ${
          roleFilter === null
            ? "bg-ink text-paper border-ink"
            : "bg-paper text-ink border-ink/30 hover:border-ink"
        }`}
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
            className="px-3 py-1.5 font-body text-sm rounded border transition-all"
            style={{
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
