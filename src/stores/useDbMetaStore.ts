// Store separato per metadati DB (path, conteggi globali).
// Mantenuto separato dal playersStore per evitare re-render quando
// cambiano solo i filtri UI.

import { create } from "zustand";
import { api } from "@/api/tauri";
import type { DbInfo } from "@/types/player";

interface DbMetaState {
  info: DbInfo | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export const useDbMetaStore = create<DbMetaState>((set) => ({
  info: null,
  loading: false,
  error: null,
  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const info = await api.getDbInfo();
      set({ info, loading: false });
    } catch (e) {
      set({
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
}));
