import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // M2.2 — BUG B2 (Cap.17 "Troubleshooting layer 2", punto 2): Tauri apre
  // la finestra OS nativa con URL /player/:id. In dev Vite deve servire
  // index.html per qualunque route (SPA fallback), altrimenti la finestra
  // OS restituisce 404 e appare bianca. `appType: 'spa'` è il default di
  // Vite ma lo rendiamo esplicito per difenderci da config che lo
  // cambierebbero in futuro. In produzione Tauri 2 gestisce già il
  // fallback a dist/index.html via custom protocol.
  appType: "spa",
  // Tauri expects a fixed port, fail if it's busy
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
  },
  // Produce sourcemaps for debug builds; Tauri uses this for better errors
  build: {
    target: "es2022",
    sourcemap: !!process.env.TAURI_DEBUG,
    // Tauri Chromium supports modern ES; chunk size warnings are noisy
    chunkSizeWarningLimit: 1500,
  },
});
