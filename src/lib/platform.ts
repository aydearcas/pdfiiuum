// Capa de plataforma: usa Tauri (Rust) cuando corre como app de escritorio
// y un respaldo con APIs del navegador cuando se prueba con `npm run dev`.
import { invoke } from "@tauri-apps/api/core";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { NativeExisting } from "./annotations";
import type { PageContent, PageEdit, PagesEdit } from "./edit";

export const isTauri = "__TAURI_INTERNALS__" in window;

export interface OpenedFile {
  name: string;
  /** Ruta en disco (solo en escritorio). */
  path: string | null;
  bytes: Uint8Array;
}

const PDF_FILTER = [{ name: "Documentos PDF", extensions: ["pdf"] }];

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export async function readPath(path: string): Promise<OpenedFile> {
  const buf = await invoke<ArrayBuffer>("read_pdf", { path });
  return { name: baseName(path), path, bytes: new Uint8Array(buf) };
}

export async function pickPdf(): Promise<OpenedFile | null> {
  if (isTauri) {
    const path = await open({ multiple: false, directory: false, filters: PDF_FILTER });
    if (!path) return null;
    return readPath(path);
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/pdf,.pdf";
    input.onchange = async () => {
      const file = input.files?.[0];
      resolve(file ? await fromBrowserFile(file) : null);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

export async function fromBrowserFile(file: File): Promise<OpenedFile> {
  return { name: file.name, path: null, bytes: new Uint8Array(await file.arrayBuffer()) };
}

/** Ruta donde guardar: la actual o la que elija el usuario (null si cancela). */
async function chooseTarget(suggestedName: string, path: string | null, forceDialog: boolean) {
  if (path && !forceDialog) return path;
  return save({ defaultPath: path ?? suggestedName, filters: PDF_FILTER });
}

/** Guarda los bytes. Devuelve la ruta usada, o null si el usuario canceló. */
export async function savePdf(
  bytes: Uint8Array,
  suggestedName: string,
  path: string | null,
  forceDialog: boolean,
): Promise<string | null> {
  if (isTauri) {
    const target = await chooseTarget(suggestedName, path, forceDialog);
    if (!target) return null;
    await invoke("write_pdf", bytes, { headers: { path: encodeURIComponent(target) } });
    return target;
  }
  const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = suggestedName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return suggestedName;
}

/**
 * Escribe las anotaciones con PDFium (Rust) y guarda. Devuelve la ruta y el PDF resultante,
 * o null si el usuario canceló el diálogo.
 */
export async function saveAnnotated(
  original: Uint8Array,
  changes: { remove: [number, number][]; add: unknown[] },
  suggestedName: string,
  path: string | null,
  forceDialog: boolean,
): Promise<{ path: string; bytes: Uint8Array } | null> {
  if (!isTauri) throw new Error("Guardar anotaciones solo está disponible en la app de escritorio.");
  const target = await chooseTarget(suggestedName, path, forceDialog);
  if (!target) return null;
  const out = await invoke<ArrayBuffer>("save_annotated", framed(changes, original), {
    headers: { path: encodeURIComponent(target) },
  });
  return { path: target, bytes: new Uint8Array(out) };
}

/** [longitud del JSON (u32 LE)][JSON][binario]: mensajes con datos y PDF a la vez. */
function framed(data: unknown, bin: Uint8Array): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(data));
  const body = new Uint8Array(4 + json.length + bin.length);
  new DataView(body.buffer).setUint32(0, json.length, true);
  body.set(json, 4);
  body.set(bin, 4 + json.length);
  return body;
}

/**
 * Anotaciones que ya contiene el PDF (leídas con PDFium) y una copia del PDF sin ellas
 * para mostrarla (null si no había ninguna).
 */
export async function extractAnnotations(pdf: Uint8Array): Promise<{ annots: NativeExisting[]; display: Uint8Array | null }> {
  const [annots, display] = unframe<NativeExisting[]>(await invoke<ArrayBuffer>("extract_annotations", pdf));
  return { annots, display: display.length ? display : null };
}

/** Inverso de `framed`: el JSON ya interpretado y el binario. */
function unframe<T>(buf: ArrayBuffer): [T, Uint8Array] {
  const out = new Uint8Array(buf);
  const len = new DataView(out.buffer, out.byteOffset, 4).getUint32(0, true);
  return [JSON.parse(new TextDecoder().decode(out.subarray(4, 4 + len))) as T, out.slice(4 + len)];
}

/** Modo edición: tramos de texto e imágenes de una página (desde 1). */
export function pageContent(pdf: Uint8Array, page: number): Promise<PageContent> {
  return invoke<PageContent>("page_content", pdf, { headers: { page: String(page - 1) } });
}

/** Aplica un cambio a una página. Devuelve el PDF editado y, si lo hay, un aviso. */
export async function editPage(
  pdf: Uint8Array,
  page: number,
  edit: PageEdit,
): Promise<{ bytes: Uint8Array; notice: string | null }> {
  const [meta, bytes] = unframe<{ notice: string | null }>(
    await invoke<ArrayBuffer>("edit_page", framed({ page: page - 1, edit }, pdf)),
  );
  return { bytes, notice: meta.notice };
}

/** Gira, borra, mueve o inserta páginas. Devuelve el PDF resultante. */
export async function editPages(pdf: Uint8Array, edit: PagesEdit): Promise<Uint8Array> {
  return new Uint8Array(await invoke<ArrayBuffer>("edit_pages", framed(edit, pdf)));
}

/** PDF nuevo con esas páginas (desde 1). */
export async function extractPages(pdf: Uint8Array, pages: number[]): Promise<Uint8Array> {
  return new Uint8Array(await invoke<ArrayBuffer>("extract_pages", framed(pages.map((p) => p - 1), pdf)));
}

/** Escribe en el PDF las anotaciones pendientes, sin guardarlo en disco. */
export async function bakeAnnotations(
  pdf: Uint8Array,
  changes: { remove: [number, number][]; add: unknown[] },
): Promise<Uint8Array> {
  return new Uint8Array(await invoke<ArrayBuffer>("bake_annotations", framed(changes, pdf)));
}

/** Elige un PDF para insertar sus páginas (ruta, o null si se cancela). */
export async function pickPdfPath(): Promise<string | null> {
  return open({ multiple: false, directory: false, filters: PDF_FILTER });
}

/** Elige una imagen para insertarla en el PDF (ruta, o null si se cancela). */
export async function pickImage(): Promise<string | null> {
  return open({
    multiple: false,
    directory: false,
    filters: [{ name: "Imágenes", extensions: ["png", "jpg", "jpeg", "gif", "bmp", "webp"] }],
  });
}

/** Pregunta Sí/No con el diálogo nativo (o confirm() en el navegador). */
export async function confirmDiscard(message: string): Promise<boolean> {
  if (!isTauri) return window.confirm(message);
  return ask(message, {
    title: "pdfiiuum",
    kind: "warning",
    okLabel: "Descartar cambios",
    cancelLabel: "Cancelar",
  });
}

/** Avisa antes de cerrar la ventana si hay cambios sin guardar. */
export async function guardClose(isDirty: () => boolean): Promise<() => void> {
  if (!isTauri) {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isDirty()) e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }
  const win = getCurrentWindow();
  return win.onCloseRequested(async (e) => {
    if (!isDirty()) return;
    e.preventDefault();
    if (await confirmDiscard("Hay anotaciones sin guardar. ¿Quieres cerrar sin guardarlas?")) {
      await win.destroy();
    }
  });
}

/**
 * Pestaña soltada fuera de la ventana. Rust mira qué hay bajo el puntero:
 * otra ventana de pdfiiuum (la pestaña pasa a ella), nada (ventana nueva) o,
 * si era la única pestaña y no hay ventana debajo, no hace nada.
 */
export async function dropTab(payload: unknown, sole: boolean): Promise<"attached" | "created" | "none"> {
  return invoke("drop_tab", {
    payload: JSON.stringify(payload),
    width: window.innerWidth,
    height: window.innerHeight,
    sole,
  });
}

/** Pestañas que otra ventana suelta sobre esta. */
export async function onAttachTab<T>(cb: (payload: T) => void): Promise<() => void> {
  if (!isTauri) return () => {};
  return getCurrentWebviewWindow().listen<string>("attach-tab", (e) => cb(JSON.parse(e.payload) as T));
}

/** Cierra esta ventana sin preguntar (se ha quedado sin pestañas). */
export async function closeWindowNow() {
  if (isTauri) await getCurrentWindow().destroy();
}

let userName: Promise<string> | null = null;
/** Nombre de usuario de Windows (autor de los comentarios). */
export function getUserName(): Promise<string> {
  userName ??= isTauri ? invoke<string>("user_name").catch(() => "") : Promise.resolve("");
  return userName;
}

/** Estado inicial de una ventana creada al sacar una pestaña (null en la ventana principal). */
export async function takeWindowPayload<T>(): Promise<T | null> {
  if (!isTauri) return null;
  const json = await invoke<string | null>("take_window_payload");
  return json ? (JSON.parse(json) as T) : null;
}

/** PDFs que otra ejecución de la app (doble clic en Explorador) envía a esta ventana. */
export async function onOpenFiles(cb: (paths: string[]) => void): Promise<() => void> {
  if (!isTauri) return () => {};
  return getCurrentWebviewWindow().listen<string[]>("open-files", (e) => cb(e.payload));
}

/** PDF con el que se lanzó la app (doble clic en un .pdf). */
export async function getStartupFile(): Promise<string | null> {
  if (!isTauri) return null;
  return invoke<string | null>("startup_file");
}

/** Archivos soltados sobre la ventana. */
export async function onFileDrop(cb: (paths: string[]) => void): Promise<() => void> {
  if (!isTauri) return () => {};
  return getCurrentWebviewWindow().onDragDropEvent((e) => {
    if (e.payload.type === "drop") cb(e.payload.paths.filter((p) => /\.pdf$/i.test(p)));
  });
}

export async function setWindowTitle(title: string) {
  if (isTauri) await getCurrentWindow().setTitle(title);
  else document.title = title;
}
