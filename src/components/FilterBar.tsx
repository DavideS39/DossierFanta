/**
 * FilterBar — M4 (v2.6) — Barra filtri sopra la lista Rosa.
 *
 * Sezioni:
 *  1. SEARCH: input testo (case-insensitive su name + team)
 *  2. TAG: mostra tutti i tag disponibili come TagStamp cliccabili
 *     (onClick → toggle filtro). Multi-select AND logico.
 *  3. RUOLO: chip P/D/C/A (riutilizza RoleFilter pattern, inlined per
 *     coerenza visiva con le altre sezioni).
 *  4. STATO: chip Scoutato/Da fare/Totale
 *  5. SORT: dropdown "Ordina per" con 7 opzioni + toggle direzione ↑/↓
 *  6. FILTRI SALVATI: dropdown con filtri salvati. Click → applica.
 *     Pulsante "salva filtro corrente" → modale con input nome.
 *  7. ESPANDI NOTE: toggle che rimuove il troncamento da tutte le
 *     .note-preview (body class 'expand-notes'). Persistito in localStorage.
 *  8. RESET: pulsante che rimuove tutti i filtri attivi.
 *  9. COUNTER: "143 risultati" (aggiornato dinamicamente).
 *
 * Stato filtri: vive in usePlayersStore (activeFilters: {tags, role,
 * status, sortBy, sortDir}). Il search è già nello store (search string).
 * La FilterBar scrive nello store, il store refresh la lista.
 *
 * Vincolo #20: niente overhaul grafico. CSS base coerente col design
 * system taccuino (font display Special Elite, colori ink/paper).
 */

import { useEffect, useMemo, useState } from "react";
import { api } from "@/api/tauri";
import { usePlayersStore } from "@/stores/usePlayersStore";
import {
  POS_FANTA_VALUES,
  POS_FANTA_LABELS,
  STATUS_VALUES,
  SORT_BY_VALUES,
  SORT_BY_LABELS,
  type PosFanta,
  type Status,
  type SortBy,
  type TagLabelCount,
  type Filter,
  type FilterCriteria,
} from "@/types/player";
import { TagStamp } from "./TagStamp";

const EXPAND_NOTES_KEY = "dossierfanta.expandNotes";

export function FilterBar() {
  // Stato store
  const search = usePlayersStore((s) => s.search);
  const setSearch = usePlayersStore((s) => s.setSearch);
  const roleFilter = usePlayersStore((s) => s.roleFilter);
  const setRoleFilter = usePlayersStore((s) => s.setRoleFilter);
  const statusFilter = usePlayersStore((s) => s.statusFilter);
  const setStatusFilter = usePlayersStore((s) => s.setStatusFilter);
  const activeTagFilters = usePlayersStore((s) => s.activeTagFilters);
  const toggleTagFilter = usePlayersStore((s) => s.toggleTagFilter);
  const sortBy = usePlayersStore((s) => s.sortBy);
  const sortDir = usePlayersStore((s) => s.sortDir);
  const setSort = usePlayersStore((s) => s.setSort);
  const resetFilters = usePlayersStore((s) => s.resetFilters);
  const totalCount = usePlayersStore((s) => s.totalCount);
  const loading = usePlayersStore((s) => s.loading);

  // Stato tag labels + filtri salvati (caricati all'avvio)
  const [tagLabels, setTagLabels] = useState<TagLabelCount[]>([]);
  const [savedFilters, setSavedFilters] = useState<Filter[]>([]);

  // Modale "salva filtro corrente"
  const [savingFilter, setSavingFilter] = useState(false);
  const [newFilterName, setNewFilterName] = useState("");

  // Toggle espandi note (persistito)
  const [expandNotes, setExpandNotes] = useState<boolean>(() => {
    try {
      return localStorage.getItem(EXPAND_NOTES_KEY) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (expandNotes) {
      document.body.classList.add("expand-notes");
    } else {
      document.body.classList.remove("expand-notes");
    }
    try {
      localStorage.setItem(EXPAND_NOTES_KEY, expandNotes ? "1" : "0");
    } catch {
      // ignore
    }
  }, [expandNotes]);

  // Load tag labels + saved filters
  const refreshLabels = () => {
    api.listAllTagLabels()
      .then(setTagLabels)
      .catch(() => {
        // ignore
      });
  };
  const refreshFilters = () => {
    api.listFilters()
      .then(setSavedFilters)
      .catch(() => {
        // ignore
      });
  };
  useEffect(() => {
    refreshLabels();
    refreshFilters();
  }, []);

  // Refresh tag labels quando cambia il numero di player (potrebbe essere
  // stato aggiunto un tag). Approximazione: ascolta totalCount.
  useEffect(() => {
    refreshLabels();
  }, [totalCount]);

  const activeCount = useMemo(() => {
    let n = 0;
    if (search.trim()) n++;
    if (roleFilter) n++;
    if (statusFilter) n++;
    if (activeTagFilters.length > 0) n += activeTagFilters.length;
    if (sortBy) n++;
    return n;
  }, [search, roleFilter, statusFilter, activeTagFilters, sortBy]);

  const handleSaveFilter = async () => {
    const name = newFilterName.trim();
    if (!name) return;
    const criteria: FilterCriteria = {
      tags: activeTagFilters.length > 0 ? activeTagFilters : undefined,
      role: roleFilter ?? undefined,
      status: statusFilter ?? undefined,
      search: search.trim() || undefined,
      sort_by: sortBy ?? undefined,
      sort_dir: sortDir ?? undefined,
    };
    // Rimuove keys undefined per JSON pulito.
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(criteria)) {
      if (v !== undefined && v !== null && v !== "") clean[k] = v;
    }
    try {
      await api.saveFilter(name, JSON.stringify(clean));
      setNewFilterName("");
      setSavingFilter(false);
      refreshFilters();
    } catch (e) {
      alert(`Impossibile salvare filtro: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleApplyFilter = async (filter: Filter) => {
    try {
      const criteria = JSON.parse(filter.criteria_json) as Partial<FilterCriteria>;
      // Applica i criteri allo store.
      resetFilters();
      if (criteria.search) setSearch(criteria.search);
      if (criteria.role) setRoleFilter(criteria.role as PosFanta);
      if (criteria.status) setStatusFilter(criteria.status as Status);
      if (criteria.sort_by) {
        setSort(criteria.sort_by as SortBy, criteria.sort_dir ?? "desc");
      }
      if (criteria.tags && criteria.tags.length > 0) {
        for (const t of criteria.tags) {
          toggleTagFilter(t);
        }
      }
    } catch (e) {
      alert(`Impossibile applicare filtro: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleDeleteFilter = async (id: string, name: string) => {
    if (!confirm(`Eliminare il filtro "${name}"?`)) return;
    try {
      await api.deleteFilter(id);
      refreshFilters();
    } catch (e) {
      alert(`Impossibile eliminare filtro: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // M4 —nota: handleDeleteFilter è disponibile per future UI di gestione filtri
  // (icona ✕ accanto al dropdown o vista "gestisci filtri"). Per M4 base non
  // è collegato a un pulsante visibile: la delete avviene tramite il comando
  // Rust delete_filter (api.deleteFilter) e l'azione store deleteSavedFilter.
  void handleDeleteFilter;

  return (
    <div className="filter-bar" role="region" aria-label="Filtri lista Rosa">
      {/* Riga 1: search + sort + saved filters + espandi note + reset */}
      <div className="filter-bar__row filter-bar__row--top">
        <div className="filter-bar__search">
          <span className="filter-bar__icon" aria-hidden>⌕</span>
          <input
            type="text"
            className="tacc-input filter-bar__search-input"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Cerca per nome o squadra…"
            aria-label="Cerca giocatore"
            style={{ fontSize: "0.75rem" }}
          />
        </div>

        <div className="filter-bar__sort">
          <span className="filter-bar__label">Ordina per:</span>
          <select
            className="tacc-select filter-bar__sort-select"
            value={sortBy ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              if (v) {
                setSort(v as SortBy, sortDir ?? "desc");
              } else {
                setSort(null, null);
              }
            }}
            aria-label="Ordina per"
            style={{ fontSize: "0.7rem" }}
          >
            <option value="">default (priorità)</option>
            {SORT_BY_VALUES.map((s) => (
              <option key={s} value={s}>{SORT_BY_LABELS[s]}</option>
            ))}
          </select>
          <button
            type="button"
            className="filter-bar__sort-dir"
            onClick={() => setSort(sortBy ?? "priority", sortDir === "asc" ? "desc" : "asc")}
            title={sortDir === "asc" ? "Crescente (clic per decrescente)" : "Decrescente (clic per crescente)"}
            disabled={!sortBy}
          >
            {sortDir === "asc" ? "↑" : "↓"}
          </button>
        </div>

        <div className="filter-bar__saved">
          <select
            className="tacc-select filter-bar__saved-select"
            defaultValue=""
            onChange={(e) => {
              const id = e.target.value;
              if (!id) return;
              const f = savedFilters.find((x) => x.id === id);
              if (f) void handleApplyFilter(f);
              e.target.value = "";
            }}
            aria-label="Filtri salvati"
            style={{ fontSize: "0.7rem" }}
          >
            <option value="">▤ filtri salvati ({savedFilters.length})</option>
            {savedFilters.map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
          <button
            type="button"
            className="df-btn filter-bar__save-btn"
            onClick={() => setSavingFilter(true)}
            disabled={activeCount === 0}
            title={activeCount === 0 ? "Imposta almeno un filtro prima di salvare" : "Salva filtro corrente con nome"}
            style={{ fontSize: "0.65rem", padding: "0.15rem 0.5rem" }}
          >
            + salva filtro
          </button>
        </div>

        <label
          className="filter-bar__expand-toggle"
          title="Rimuove il troncamento da tutte le note-preview nelle card"
        >
          <input
            type="checkbox"
            checked={expandNotes}
            onChange={(e) => setExpandNotes(e.target.checked)}
          />
          espandi note
        </label>

        <button
          type="button"
          className="df-btn filter-bar__reset"
          onClick={() => resetFilters()}
          disabled={activeCount === 0}
          title="Rimuove tutti i filtri attivi"
          style={{ fontSize: "0.7rem", padding: "0.2rem 0.6rem" }}
        >
          ↺ reset
        </button>

        <span
          className={`filter-bar__counter ${loading ? "is-loading" : ""}`}
          aria-live="polite"
        >
          {loading ? "…" : `${totalCount} risultati`}
          {activeCount > 0 && (
            <span className="filter-bar__counter-active"> · {activeCount} filtro{activeCount > 1 ? "i" : ""} attiv{activeCount > 1 ? "i" : "o"}</span>
          )}
        </span>
      </div>

      {/* Riga 2: filtri tag + ruolo + stato */}
      <div className="filter-bar__row filter-bar__row--filters">
        {/* TAG */}
        <div className="filter-bar__group filter-bar__group--tags">
          <span className="filter-bar__label">Tag:</span>
          {tagLabels.length === 0 ? (
            <span className="filter-bar__empty">— nessun tag ancora creato —</span>
          ) : (
            <div className="filter-bar__tags">
              {tagLabels.map((row) => {
                const isActive = activeTagFilters.includes(row.label);
                return (
                  <TagStamp
                    key={row.label}
                    tag={{ id: `filter-${row.label}`, label: row.label }}
                    size="sm"
                    onClick={() => toggleTagFilter(row.label)}
                    selected={isActive}
                    title={`${row.label} (${row.count} giocatori) — click per ${isActive ? "disattivare" : "attivare"} filtro AND`}
                  />
                );
              })}
            </div>
          )}
        </div>

        {/* RUOLO */}
        <div className="filter-bar__group" role="group" aria-label="Filtra per ruolo">
          <span className="filter-bar__label">Ruolo:</span>
          {POS_FANTA_VALUES.map((r) => {
            const active = roleFilter === r;
            return (
              <button
                key={r}
                type="button"
                className="df-chip df-chip--ink"
                aria-pressed={active}
                onClick={() => setRoleFilter(active ? null : r)}
                title={POS_FANTA_LABELS[r]}
                style={{ fontSize: "0.7rem" }}
              >
                {r}
              </button>
            );
          })}
        </div>

        {/* STATO */}
        <div className="filter-bar__group" role="group" aria-label="Filtra per stato scouting">
          <span className="filter-bar__label">Stato:</span>
          <button
            type="button"
            className="df-chip df-chip--ink"
            aria-pressed={statusFilter === null}
            onClick={() => setStatusFilter(null)}
            style={{ fontSize: "0.7rem" }}
          >
            Tutti
          </button>
          {STATUS_VALUES.map((s) => {
            const active = statusFilter === s;
            const label = s === "scoutato" ? "Scoutati" : s === "da_fare" ? "Da fare" : "Totali";
            return (
              <button
                key={s}
                type="button"
                className="df-chip df-chip--ink"
                aria-pressed={active}
                onClick={() => setStatusFilter(active ? null : s)}
                style={{ fontSize: "0.7rem" }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Modale "salva filtro corrente" */}
      {savingFilter && (
        <div
          className="filter-bar__modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSavingFilter(false);
          }}
        >
          <div className="filter-bar__modal" role="dialog" aria-modal="true" aria-label="Salva filtro">
            <h3>Salva filtro corrente</h3>
            <p className="filter-bar__modal-criteria">
              Filtri attivi: {activeCount} · tags: {activeTagFilters.length > 0 ? activeTagFilters.join(", ") : "—"} · ruolo: {roleFilter ?? "—"} · stato: {statusFilter ?? "—"} · sort: {sortBy ? `${SORT_BY_LABELS[sortBy]} ${sortDir}` : "—"}
            </p>
            <input
              type="text"
              className="tacc-input filter-bar__modal-input"
              value={newFilterName}
              onChange={(e) => setNewFilterName(e.target.value)}
              placeholder="Nome del filtro (es. 'Asta attaccanti')"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleSaveFilter();
                if (e.key === "Escape") setSavingFilter(false);
              }}
              style={{ fontSize: "0.85rem" }}
            />
            <div className="filter-bar__modal-actions">
              <button type="button" className="df-btn" onClick={() => setSavingFilter(false)}>
                annulla
              </button>
              <button
                type="button"
                className="df-btn df-btn--primary"
                onClick={() => void handleSaveFilter()}
                disabled={!newFilterName.trim()}
              >
                salva
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
