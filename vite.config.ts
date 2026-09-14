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
