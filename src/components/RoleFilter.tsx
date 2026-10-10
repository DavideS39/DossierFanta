import { usePlayersStore } from "@/stores/usePlayersStore";
import { POS_FANTA_VALUES } from "@/types/player";
import { ROLE_COLORS } from "@/lib/format";

/**
 * Filtro ruolo v2.3.2: chip stile timbro (bordo color ruolo, pressione
 * = riempimento). Click su una chip setta roleFilter nello store, che
 * triggera refresh().
 */
export function RoleFilter() {
  const roleFilter = usePlayersStore((s) => s.roleFilter);
  const setRoleFilter = usePlayersStore((s) => s.setRoleFilter);

  return (
    <div className="flex items-center gap-1.5 flex-wrap" role="group" aria-label="Filtra per ruolo">
      <button
        type="button"
        onClick={() => setRoleFilter(null)}
        className="df-chip df-chip--ink"
        style={{ color: "var(--ink)" }}
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
            className="df-chip"
            style={{
              color: active ? "#FFF" : c.bg,
              backgroundColor: active ? c.bg : "transparent",
            }}
            aria-pressed={active}
            title={`Solo ${role}`}
          >
            {role}
          </button>
        );
      })}
    </div>
  );
}
