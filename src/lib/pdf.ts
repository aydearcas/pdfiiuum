import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
// pdf_viewer.mjs lee la librería desde esta global al cargarse.
(globalThis as { pdfjsLib?: unknown }).pdfjsLib = pdfjs;

const ASSETS = `${import.meta.env.BASE_URL}pdfjs/`;

/** Iconos que usa pdf.js para las notas ya guardadas en el PDF. */
export const IMAGE_RESOURCES = `${ASSETS}images/`;

export type PDFDocument = pdfjs.PDFDocumentProxy;

// En pdf.js v6 solo la tarea de carga puede liberar el documento.
const tasks = new WeakMap<PDFDocument, pdfjs.PDFDocumentLoadingTask>();

export async function loadPdf(bytes: Uint8Array): Promise<PDFDocument> {
  // pdf.js transfiere (vacía) el buffer al worker, así que le pasamos una copia.
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    cMapUrl: `${ASSETS}cmaps/`,
    standardFontDataUrl: `${ASSETS}standard_fonts/`,
    wasmUrl: `${ASSETS}wasm/`,
    iccUrl: `${ASSETS}iccs/`,
  });
  const pdf = await task.promise;
  tasks.set(pdf, task);
  return pdf;
}

export function closePdf(pdf: PDFDocument) {
  tasks.get(pdf)?.destroy();
}
