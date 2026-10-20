import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://v2.tauri.app/start/frontend/vite/
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    // En Windows el vigilante nativo a veces se salta ediciones seguidas: sondeo.
    watch: { ignored: ["**/src-tauri/**"], usePolling: true, interval: 200 },
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 2000,
  },
});
