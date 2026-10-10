
// Store Zustand per stato workspace multi-DB (M2).
// Mantiene: lista databases, active_id, loading/error.
// Mutazioni: refresh, createDatabase, deleteDatabase, setActiveDatabase.
//
// M2.1 — FIX A4 (A8): l'active_id è persistito in localStorage a ogni
// setActiveDatabase. Al boot dell'app, App.tsx legge localStorage e
// chiama setActiveDatabase con l'id salvato PRIMA di refreshMeta (così
// il backend ha già il DB attivo corretto quando il frontend legge i
// giocatori). Nessuna modifica al backend, nessun tocco allo schema.

import { create } from "zustand";
import { api } from "@/api/tauri";
import type { DatabaseMeta, DatabaseType } from "@/types/player";

const ACTIVE_DB_LS_KEY = "dossierfanta.activeDbId";

function loadActiveDbIdFromLs(): string | null {
  try {
    return localStorage.getItem(ACTIVE_DB_LS_KEY);
  } catch {
    return null;
  }
}

function saveActiveDbIdToLs(id: string): void {
  try {
    localStorage.setItem(ACTIVE_DB_LS_KEY, id);
  } catch {
    // localStorage può fallire (private mode, quota) — non bloccante
  }
}

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
  /** M2.1: ripristina il DB attivo da localStorage. Chiamato al boot. */
  restoreFromLocalStorage: () => Promise<void>;
}

export const useDbStore = create<DbState>((set, get) => ({
  databases: [],
  activeId: loadActiveDbIdFromLs(),
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
      // FIX A4: persisti in localStorage per sopravvivenza al riavvio
      saveActiveDbIdToLs(active.id);
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
    // FIX A4: persisti in localStorage a ogni switch
    saveActiveDbIdToLs(meta.id);
    return meta;
  },

  getActiveDatabase: () => {
    const { databases, activeId } = get();
    if (!activeId) return null;
    return databases.find((d) => d.id === activeId) ?? null;
  },

  restoreFromLocalStorage: async () => {
    const stored = loadActiveDbIdFromLs();
    if (!stored) return;
    // Verifica che il DB salvato esista ancora (potrebbe essere stato
    // eliminato in un'altra sessione). Se sì, chiama setActiveDatabase
    // per ripristinarlo come attivo nel backend.
    try {
      const dbs = await api.listDatabases();
      if (dbs.some((d) => d.id === stored)) {
        await api.setActiveDatabase(stored);
        set({ activeId: stored });
      } else {
        // DB non più esistente: pulisci localStorage
        try {
          localStorage.removeItem(ACTIVE_DB_LS_KEY);
        } catch {
          // ignore
        }
      }
    } catch {
      // se la listDatabases fallisce, lascia che refresh() venga chiamata dopo
    }
  },
}));
