// Store Zustand per stato giocatori + filtri UI.
// Tutte le mutazioni passano per api/tauri.ts (comandi Rust), mai SQL diretto.
//
// M2: il filtro db_id è gestito qui. Valori possibili:
//   null/undefined → "active" (default: usa active_db_id dal backend)
//   "all"          → tutti i DB
//   "<uuid>"       → un DB specifico

import { create } from "zustand";
import { api } from "@/api/tauri";
import type {
  CreatePlayerInput,
  ListFilters,
  Player,
  PosFanta,
  UpdatePlayerInput,
} from "@/types/player";

interface PlayersState {
  // Stato dati
  players: Player[];
  totalCount: number;
  loading: boolean;
  error: string | null;
  lastUpdated: string | null;

  // Filtri UI
  search: string;
  roleFilter: PosFanta | null; // null = tutti
  dbFilter: string | null; // null = active DB, "all" = tutti, "<uuid>" = specific DB (M2)
  includeArchive: boolean; // M2: toggle archivio in vista Rosa
  selectedId: string | null;

  // Azioni
  setSearch: (s: string) => void;
  setRoleFilter: (r: PosFanta | null) => void;
  setDbFilter: (d: string | null) => void;
  setIncludeArchive: (v: boolean) => void;
  setSelectedId: (id: string | null) => void;
  refresh: () => Promise<void>;
  createPlayer: (input: CreatePlayerInput) => Promise<Player>;
  updatePlayer: (input: UpdatePlayerInput) => Promise<Player>;
  deletePlayer: (id: string) => Promise<boolean>;
}

function buildFilters(
  search: string,
  role: PosFanta | null,
  dbFilter: string | null,
  includeArchive: boolean,
): ListFilters {
  const f: ListFilters = {};
  if (search.trim()) f.search = search.trim();
  if (role) f.pos_fanta = role;
  if (dbFilter) f.db_id = dbFilter; // "all" o un UUID
  if (includeArchive) f.include_archive = true;
  return f;
}

export const usePlayersStore = create<PlayersState>((set, get) => ({
  players: [],
  totalCount: 0,
  loading: false,
  error: null,
  lastUpdated: null,

  search: "",
  roleFilter: null,
  dbFilter: null,
  includeArchive: false,
  selectedId: null,

  setSearch: (s) => {
    set({ search: s });
    void get().refresh();
  },

  setRoleFilter: (r) => {
    set({ roleFilter: r });
    void get().refresh();
  },

  setDbFilter: (d) => {
    set({ dbFilter: d });
    void get().refresh();
  },

  setIncludeArchive: (v) => {
    set({ includeArchive: v });
    void get().refresh();
  },

  setSelectedId: (id) => set({ selectedId: id }),

  refresh: async () => {
    const { search, roleFilter, dbFilter, includeArchive } = get();
    const filters = buildFilters(search, roleFilter, dbFilter, includeArchive);
    set({ loading: true, error: null });
    try {
      const [players, count] = await Promise.all([
        api.listPlayers(filters),
        api.countPlayers(filters),
      ]);
      set({
        players,
        totalCount: count,
        loading: false,
        lastUpdated: new Date().toISOString(),
        error: null,
      });
    } catch (e) {
      set({
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },

  createPlayer: async (input) => {
    const player = await api.createPlayer(input);
    await get().refresh();
    return player;
  },

  updatePlayer: async (input) => {
    const player = await api.updatePlayer(input);
    await get().refresh();
    return player;
  },

  deletePlayer: async (id) => {
    const ok = await api.deletePlayer(id);
    if (get().selectedId === id) set({ selectedId: null });
    await get().refresh();
    return ok;
  },
}));
