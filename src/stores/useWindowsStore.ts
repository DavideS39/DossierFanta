// Store Zustand per stato finestre del Window Manager in-app (M2.1, Cap.17).
//
// Stato finestre: posizione (x, y), dimensioni (w, h), z-order, minimized.
// Tutte le finestre vivono dentro la finestra principale dell'app
// (non escono dai bounds). Drag dalla chrome, resize dall'angolo ↘,
// snap ai bordi, minimizza in taskbar, massimizza.
//
// Stato sincronizzato con le finestre OS native via eventi Tauri:
// - openPlayerWindow(player_id) crea finestra OS
// - closePlayerWindow(player_id) chiude
// - listOsPlayerWindows() per sapere quali sono "staccate"
//
// Z-order: l'ultima finestra cliccata è in primo piano. Alt+W cicla.

import { create } from "zustand";

export interface WindowState {
  id: string; // player_id
  title: string; // nome giocatore per la chrome
  x: number;
  y: number;
  w: number;
  h: number;
  z: number; // z-order (più alto = più in primo piano)
  minimized: boolean;
  maximized: boolean;
  // Stato pre-maximize per restore
  prevRect?: { x: number; y: number; w: number; h: number };
}

interface WindowsStoreState {
  windows: WindowState[];
  nextZ: number;
  activeId: string | null;

  // Azioni
  openPlayerWindow: (playerId: string, title: string) => void;
  closeWindow: (playerId: string) => void;
  focusWindow: (playerId: string) => void;
  moveWindow: (playerId: string, x: number, y: number) => void;
  resizeWindow: (playerId: string, w: number, h: number) => void;
  minimizeWindow: (playerId: string) => void;
  restoreFromTaskbar: (playerId: string) => void;
  toggleMaximize: (playerId: string) => void;
  cycleZOrder: () => void; // Alt+W
  // Per OS-native: traccia quali player_id sono "staccati" in finestra OS
  detachedToOs: Set<string>;
  setDetachedToOs: (ids: string[]) => void;
  detachToOs: (playerId: string) => void;
  attachFromOs: (playerId: string) => void;
}

const MIN_W = 320;
const MIN_H = 400;
const OFFSET_STEP = 28;

export const useWindowsStore = create<WindowsStoreState>((set, get) => ({
  windows: [],
  nextZ: 40, // Z4 partenza
  activeId: null,
  detachedToOs: new Set<string>(),

  openPlayerWindow: (playerId, title) => {
    const existing = get().windows.find((w) => w.id === playerId);
    if (existing) {
      // Già aperta: focus + unminimize
      get().focusWindow(playerId);
      set((s) => ({
        windows: s.windows.map((w) =>
          w.id === playerId ? { ...w, minimized: false } : w,
        ),
      }));
      return;
    }

    // Calcola posizione: cascata con offset per finestre multiple
    const count = get().windows.length;
    const offset = (count % 6) * OFFSET_STEP;
    const baseW = 560;
    const baseH = 640;
    // Posizionamento: centrato-ish, con cascata
    const x = Math.max(20, 120 + offset);
    const y = Math.max(20, 60 + offset);
    const z = get().nextZ;

    set((s) => ({
      windows: [
        ...s.windows,
        {
          id: playerId,
          title,
          x,
          y,
          w: baseW,
          h: baseH,
          z,
          minimized: false,
          maximized: false,
        },
      ],
      nextZ: z + 1,
      activeId: playerId,
    }));
  },

  closeWindow: (playerId) => {
    set((s) => ({
      windows: s.windows.filter((w) => w.id !== playerId),
      activeId: s.activeId === playerId ? null : s.activeId,
    }));
  },

  focusWindow: (playerId) => {
    const z = get().nextZ;
    set((s) => ({
      windows: s.windows.map((w) =>
        w.id === playerId ? { ...w, z, minimized: false } : w,
      ),
      nextZ: z + 1,
      activeId: playerId,
    }));
  },

  moveWindow: (playerId, x, y) => {
    // Clamp: non far uscire la finestra fuori dai bounds
    const clampedX = Math.max(0, x);
    const clampedY = Math.max(0, y);
    set((s) => ({
      windows: s.windows.map((w) =>
        w.id === playerId
          ? { ...w, x: clampedX, y: clampedY, maximized: false }
          : w,
      ),
    }));
  },

  resizeWindow: (playerId, w, h) => {
    const clampedW = Math.max(MIN_W, w);
    const clampedH = Math.max(MIN_H, h);
    set((s) => ({
      windows: s.windows.map((w_) =>
        w_.id === playerId
          ? { ...w_, w: clampedW, h: clampedH, maximized: false }
          : w_,
      ),
    }));
  },

  minimizeWindow: (playerId) => {
    set((s) => ({
      windows: s.windows.map((w) =>
        w.id === playerId ? { ...w, minimized: true } : w,
      ),
      activeId: s.activeId === playerId ? null : s.activeId,
    }));
  },

  restoreFromTaskbar: (playerId) => {
    set((s) => ({
      windows: s.windows.map((w) =>
        w.id === playerId ? { ...w, minimized: false } : w,
      ),
    }));
    get().focusWindow(playerId);
  },

  toggleMaximize: (playerId) => {
    set((s) => {
      const w = s.windows.find((x) => x.id === playerId);
      if (!w) return s;
      if (w.maximized) {
        // Restore
        const prev = w.prevRect ?? { x: w.x, y: w.y, w: 560, h: 640 };
        return {
          windows: s.windows.map((x) =>
            x.id === playerId
              ? { ...x, maximized: false, ...prev }
              : x,
          ),
        };
      } else {
        // Maximize: usa la viewport dell'app (assumiamo 100vw x 100vh via CSS)
        return {
          windows: s.windows.map((x) =>
            x.id === playerId
              ? {
                  ...x,
                  maximized: true,
                  prevRect: { x: x.x, y: x.y, w: x.w, h: x.h },
                  x: 0,
                  y: 0,
                  w: window.innerWidth,
                  h: window.innerHeight - 32, // lascia spazio per taskbar
                }
              : x,
          ),
        };
      }
    });
  },

  cycleZOrder: () => {
    // Alt+W: cicla tra finestre aperte (non minimizzate)
    const open = get().windows.filter((w) => !w.minimized);
    if (open.length === 0) return;
    // Sort per z, cicla il primo (più in alto) → in fondo
    const sorted = [...open].sort((a, b) => b.z - a.z);
    const top = sorted[0];
    if (top) {
      get().focusWindow(top.id);
    }
  },

  setDetachedToOs: (ids) => {
    set({ detachedToOs: new Set(ids) });
  },

  detachToOs: (playerId) => {
    // Chiudi la finestra in-app (la OS prende il posto)
    set((s) => ({
      windows: s.windows.filter((w) => w.id !== playerId),
      detachedToOs: new Set([...s.detachedToOs, playerId]),
      activeId: s.activeId === playerId ? null : s.activeId,
    }));
  },

  attachFromOs: (playerId) => {
    // Riapri la finestra in-app (la OS è stata chiusa)
    set((s) => {
      const next = new Set(s.detachedToOs);
      next.delete(playerId);
      return { detachedToOs: next };
    });
    // Non chiamiamo openPlayerWindow qui: il chiamante deve farlo
    // esplicitamente per passare il titolo corretto
  },
}));
