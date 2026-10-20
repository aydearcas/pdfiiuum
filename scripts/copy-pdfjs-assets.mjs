// Copia los recursos de pdf.js (cmaps, fuentes estándar, wasm) a public/pdfjs
// para que funcionen igual en desarrollo y en la app empaquetada.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let pkgDir;
try {
  pkgDir = dirname(require.resolve("pdfjs-dist/package.json"));
} catch {
  console.log("[pdfjs-assets] pdfjs-dist aún no está instalado, se omite.");
  process.exit(0);
}

const outDir = join(process.cwd(), "public", "pdfjs");
mkdirSync(outDir, { recursive: true });
for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs", "web/images"]) {
  const src = join(pkgDir, dir);
  if (existsSync(src)) {
    // web/images (iconos de notas) se publica como pdfjs/images
    cpSync(src, join(outDir, dir.replace(/^web\//, "")), { recursive: true });
    console.log(`[pdfjs-assets] ${dir} copiado`);
  }
}
