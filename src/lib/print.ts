// Imprimir: pdf.js pinta las páginas elegidas como imágenes en un contenedor que solo se ve al
// imprimir, y el diálogo de impresión del sistema (el del navegador o WebView2) elige impresora,
// copias, orientación y papel. Es lo mismo que hace el visor de PDF de Firefox.
import { AnnotationMode } from "pdfjs-dist";
import type { PDFDocument } from "./pdf";

/** Resolución de impresión: la de pdf.js, suficiente para texto nítido sin disparar la memoria. */
const DPI = 150;

/**
 * Lee un intervalo de páginas como «1-3, 5, 8-» (desde la 8 hasta el final) o «-4». Devuelve las
 * páginas (desde 1) en orden y sin repetir, o null si el texto no es válido.
 */
export function parsePageRange(text: string, count: number): number[] | null {
  const pages = new Set<number>();
  const parts = text.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  for (const part of parts) {
    const m = /^(\d*)\s*[-–]\s*(\d*)$/.exec(part) ?? /^(\d+)$/.exec(part);
    if (!m) return null;
    const single = m.length === 2;
    const from = single ? Number(m[1]) : m[1] ? Number(m[1]) : 1;
    const to = single ? from : m[2] ? Number(m[2]) : count;
    if (from < 1 || to > count || from > to) return null;
    for (let n = from; n <= to; n++) pages.add(n);
  }
  return [...pages].sort((a, b) => a - b);
}

export interface PrintJob {
  pdf: PDFDocument;
  /** Páginas desde 1. */
  pages: number[];
  onProgress?(done: number, total: number): void;
  signal?: AbortSignal;
}

/** Pinta las páginas y abre el diálogo de impresión. Termina cuando se cierra ese diálogo. */
export async function printPages({ pdf, pages, onProgress, signal }: PrintJob): Promise<void> {
  const container = document.createElement("div");
  container.className = "print-container";
  const style = document.createElement("style");
  const urls: string[] = [];
  const cleanup = () => {
    container.remove();
    style.remove();
    document.body.classList.remove("printing");
    urls.forEach((u) => URL.revokeObjectURL(u));
  };
  try {
    // Lo que se escribió en los campos del formulario se imprime tal cual.
    const printAnnotationStorage = pdf.annotationStorage.print;
    for (const [i, n] of pages.entries()) {
      if (signal?.aborted) return cleanup();
      const page = await pdf.getPage(n);
      const size = page.getViewport({ scale: 1 });
      // El papel toma el tamaño de la primera página; las demás se ajustan dentro.
      if (i === 0) style.textContent = `@page { size: ${size.width}pt ${size.height}pt; margin: 0; }`;
      const viewport = page.getViewport({ scale: DPI / 72 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({
        canvas,
        canvasContext: ctx,
        viewport,
        intent: "print",
        annotationMode: AnnotationMode.ENABLE_STORAGE,
        printAnnotationStorage,
      }).promise;
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
      if (!blob) throw new Error(`No se pudo preparar la página ${n}`);
      const url = URL.createObjectURL(blob);
      urls.push(url);
      const sheet = document.createElement("div");
      sheet.className = "print-page";
      const img = document.createElement("img");
      img.src = url;
      sheet.append(img);
      container.append(sheet);
      onProgress?.(i + 1, pages.length);
    }
    document.head.append(style);
    document.body.append(container);
    document.body.classList.add("printing");
    await Promise.all([...container.querySelectorAll("img")].map((img) => img.decode()));
    if (signal?.aborted) return cleanup();
    // window.print() vuelve al cerrar el diálogo; «afterprint» por si el navegador no espera.
    await new Promise<void>((resolve) => {
      const done = () => {
        window.removeEventListener("afterprint", done);
        resolve();
      };
      window.addEventListener("afterprint", done);
      window.print();
      setTimeout(done, 0);
    });
  } finally {
    // Algunos navegadores aún están leyendo las imágenes justo al volver de print().
    setTimeout(cleanup, 1000);
  }
}
