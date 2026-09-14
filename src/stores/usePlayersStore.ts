// Store Zustand per stato giocatori + filtri UI.
// Tutte le mutazioni passano per api/tauri.ts (comandi Rust), mai SQL diretto.

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
  selectedId: string | null;

  // Azioni
  setSearch: (s: string) => void;
  setRoleFilter: (r: PosFanta | null) => void;
  setSelectedId: (id: string | null) => void;
  refresh: () => Promise<void>;
  createPlayer: (input: CreatePlayerInput) => Promise<Player>;
  updatePlayer: (input: UpdatePlayerInput) => Promise<Player>;
  deletePlayer: (id: string) => Promise<boolean>;
}

function buildFilters(search: string, role: PosFanta | null): ListFilters {
  const f: ListFilters = {};
  if (search.trim()) f.search = search.trim();
  if (role) f.pos_fanta = role;
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
  selectedId: null,

  setSearch: (s) => {
    set({ search: s });
    // Refresh asincrono (debounce fatto nel componente SearchBar)
    void get().refresh();
  },

  setRoleFilter: (r) => {
    set({ roleFilter: r });
    void get().refresh();
  },

  setSelectedId: (id) => set({ selectedId: id }),

  refresh: async () => {
    const { search, roleFilter } = get();
    const filters = buildFilters(search, roleFilter);
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
