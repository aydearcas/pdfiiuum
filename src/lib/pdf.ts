import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { PasswordCancelled, askPassword, knownPasswords, rememberPassword } from "./passwords";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
// pdf_viewer.mjs lee la librería desde esta global al cargarse.
(globalThis as { pdfjsLib?: unknown }).pdfjsLib = pdfjs;

// Dirección completa: el worker de pdf.js carga el wasm por su cuenta y resolvería una ruta
// relativa desde su propia carpeta (assets/), no desde la página (visor de la extensión).
const ASSETS = new URL(`${import.meta.env.BASE_URL}pdfjs/`, location.href).href;

/** Iconos que usa pdf.js para las notas ya guardadas en el PDF. */
export const IMAGE_RESOURCES = `${ASSETS}images/`;

export type PDFDocument = pdfjs.PDFDocumentProxy;

// En pdf.js v6 solo la tarea de carga puede liberar el documento.
const tasks = new WeakMap<PDFDocument, pdfjs.PDFDocumentLoadingTask>();

/**
 * Abre el PDF con pdf.js. Si está cifrado prueba las contraseñas de la sesión y, si ninguna
 * sirve, la pide al usuario (`name` es el archivo, para el diálogo). Si cancela, lanza
 * `PasswordCancelled`.
 */
export async function loadPdf(bytes: Uint8Array, { name }: { name?: string } = {}): Promise<PDFDocument> {
  // pdf.js transfiere (vacía) el buffer al worker, así que le pasamos una copia.
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    cMapUrl: `${ASSETS}cmaps/`,
    standardFontDataUrl: `${ASSETS}standard_fonts/`,
    wasmUrl: `${ASSETS}wasm/`,
    iccUrl: `${ASSETS}iccs/`,
  });
  // La última que se escribió es la más probable.
  const candidates = [...knownPasswords()].reverse();
  let typed: string | null = null;
  let cancelled = false;
  task.onPassword = (update: (password: string) => void) => {
    const next = candidates.shift();
    if (next !== undefined) return update(next);
    askPassword({ name, retry: typed !== null }).then((password) => {
      if (password === null) {
        cancelled = true;
        task.destroy();
      } else {
        typed = password;
        update(password);
      }
    });
  };
  let pdf: PDFDocument;
  try {
    pdf = await task.promise;
  } catch (e) {
    if (cancelled) throw new PasswordCancelled();
    throw e;
  }
  if (typed !== null) rememberPassword(typed);
  tasks.set(pdf, task);
  return pdf;
}

export function closePdf(pdf: PDFDocument) {
  tasks.get(pdf)?.destroy();
}
