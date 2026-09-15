// Store Zustand per stato workspace multi-DB (M2).
// Mantiene: lista databases, active_id, loading/error.
// Mutazioni: refresh, createDatabase, deleteDatabase, setActiveDatabase.

import { create } from "zustand";
import { api } from "@/api/tauri";
import type { DatabaseMeta, DatabaseType } from "@/types/player";

interface DbState {
  // Stato dati
  databases: DatabaseMeta[];
  activeId: string | null;
  loading: boolean;
  error: string | null;
  lastUpdated: string | null;

  // Azioni
  refresh: () => Promise<void>;
  createDatabase: (name: string, type?: DatabaseType) => Promise<DatabaseMeta>;
  deleteDatabase: (id: string) => Promise<boolean>;
  setActiveDatabase: (id: string) => Promise<DatabaseMeta>;
  getActiveDatabase: () => DatabaseMeta | null;
}

export const useDbStore = create<DbState>((set, get) => ({
  databases: [],
  activeId: null,
  loading: false,
  error: null,
  lastUpdated: null,

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const [dbs, active] = await Promise.all([
        api.listDatabases(),
        api.getActiveDatabase(),
      ]);
      set({
        databases: dbs,
        activeId: active.id,
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

  createDatabase: async (name, type) => {
    const meta = await api.createDatabase(name, type);
    await get().refresh();
    return meta;
  },

  deleteDatabase: async (id) => {
    const ok = await api.deleteDatabase(id);
    await get().refresh();
    return ok;
  },

  setActiveDatabase: async (id) => {
    const meta = await api.setActiveDatabase(id);
    set({ activeId: meta.id });
    return meta;
  },

  getActiveDatabase: () => {
    const { databases, activeId } = get();
    if (!activeId) return null;
    return databases.find((d) => d.id === activeId) ?? null;
  },
}));
