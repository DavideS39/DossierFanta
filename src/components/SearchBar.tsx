import { useEffect, useRef, useState } from "react";
import { usePlayersStore } from "@/stores/usePlayersStore";

/**
 * SearchBar con debounce 250ms. Aggiorna `search` nello store, che a sua
 * volta triggera `refresh()` con il nuovo filtro.
 *
 * Il debounce è lato componente (non store) per evitare di refreshare a
 * ogni keystroke durante la digitazione.
 */
export function SearchBar() {
  const search = usePlayersStore((s) => s.search);
  const setSearch = usePlayersStore((s) => s.setSearch);
  const [local, setLocal] = useState(search);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLocal(search);
  }, [search]);

  const onChange = (v: string) => {
    setLocal(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setSearch(v), 250);
  };

  return (
    <div className="relative flex-1 max-w-md">
      <input
        type="search"
        value={local}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Cerca per nome o squadra…"
        className="w-full pl-9 pr-3 py-2 font-body text-ink bg-paper-dim border border-ink/30 rounded shadow-sm focus:outline-none focus:border-ink focus:ring-2 focus:ring-ink/10 placeholder:text-ink-soft/60"
      />
      <span
        aria-hidden
        className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-soft select-none"
      >
        🔍
      </span>
      {local && (
        <button
          type="button"
          onClick={() => onChange("")}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-soft hover:text-red text-lg leading-none"
          aria-label="Cancella ricerca"
        >
          ×
        </button>
      )}
    </div>
  );
}
