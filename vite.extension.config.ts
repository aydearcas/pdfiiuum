import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Visor de pdfiiuum para la extensión del navegador: la misma interfaz, compilada como
// browser-extension/viewer/viewer.html con rutas relativas (se sirve desde chrome-extension://).
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    target: "es2022",
    outDir: "browser-extension/viewer",
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
    // Las páginas de extensión no admiten scripts en línea.
    modulePreload: { polyfill: false },
    rollupOptions: { input: "viewer.html" },
  },
});
