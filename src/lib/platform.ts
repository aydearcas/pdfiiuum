// Capa de plataforma: usa Tauri (Rust) cuando corre como app de escritorio, el puente con la
// app instalada cuando es el visor de la extensión del navegador, y un respaldo con APIs del
// navegador cuando se prueba con `npm run dev`.
import { invoke } from "@tauri-apps/api/core";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { NativeExisting } from "./annotations";
import type { PageContent, PageEdit, PagesEdit } from "./edit";
import { call, toBase64 } from "./bridge";

export const isTauri = "__TAURI_INTERNALS__" in window;
/** Visor de la extensión del navegador (página chrome-extension://…/viewer.html). */
export const isExtension = location.protocol === "chrome-extension:";
/**
 * Visor dentro de un iframe de otra página. Cualquier web puede incrustar el visor de la
 * extensión con el PDF que quiera; abrirlo ahí mandaría ese PDF al PDFium de la app sin
 * que el usuario haga nada, así que en ese caso no se carga.
 */
export const isEmbedded = !isTauri && window.self !== window.top;
/** Anotaciones guardables, modo edición y páginas: hacen falta PDFium (app o puente). */
export const hasPdfium = isTauri || isExtension;
/** Guardar escribe en el archivo elegido (y luego en el mismo) en vez de descargar una copia. */
export const savesInPlace = isTauri || "showSaveFilePicker" in window;

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
  if (savesInPlace) return saveWithPicker(bytes, suggestedName, path, forceDialog);
  const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = suggestedName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return suggestedName;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FileHandle = any;
/** Archivos elegidos con el selector del navegador, por la «ruta» que se da a la pestaña. */
const fileHandles = new Map<string, FileHandle>();
let handleSeq = 0;

/** Navegador: el selector «Guardar como» y, las siguientes veces, el mismo archivo. */
async function saveWithPicker(bytes: Uint8Array, suggestedName: string, path: string | null, forceDialog: boolean) {
  let handle = path && !forceDialog ? fileHandles.get(path) : undefined;
  if (!handle) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handle = await (window as any).showSaveFilePicker({
        suggestedName,
        types: [{ description: "Documento PDF", accept: { "application/pdf": [".pdf"] } }],
      });
    } catch (e) {
      if ((e as Error).name === "AbortError") return null;
      throw e;
    }
  }
  const writable = await handle.createWritable();
  await writable.write(bytes);
  await writable.close();
  // La «ruta» solo sirve para volver a encontrar el archivo; termina en su nombre.
  const key = path && fileHandles.get(path) === handle ? path : `navegador-${++handleSeq}/${handle.name}`;
  fileHandles.set(key, handle);
  return key;
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
  if (isExtension) {
    const bytes = await bakeAnnotations(original, changes);
    const target = await savePdf(bytes, suggestedName, path, forceDialog);
    return target ? { path: target, bytes } : null;
  }
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
  if (isExtension) {
    const r = await call<NativeExisting[]>("extract_annotations", null, pdf);
    return { annots: r.result, display: r.bytes };
  }
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
export async function pageContent(pdf: Uint8Array, page: number): Promise<PageContent> {
  if (isExtension) return (await call<PageContent>("page_content", { page: page - 1 }, pdf)).result;
  return invoke<PageContent>("page_content", pdf, { headers: { page: String(page - 1) } });
}

/** Aplica un cambio a una página. Devuelve el PDF editado y, si lo hay, un aviso. */
export async function editPage(
  pdf: Uint8Array,
  page: number,
  edit: PageEdit,
): Promise<{ bytes: Uint8Array; notice: string | null }> {
  if (isExtension) {
    const r = await call<{ notice: string | null }>("edit_page", { page: page - 1, edit }, pdf);
    return { bytes: r.bytes!, notice: r.result.notice };
  }
  const [meta, bytes] = unframe<{ notice: string | null }>(
    await invoke<ArrayBuffer>("edit_page", framed({ page: page - 1, edit }, pdf)),
  );
  return { bytes, notice: meta.notice };
}

/** Gira, borra, mueve o inserta páginas. Devuelve el PDF resultante. */
export async function editPages(pdf: Uint8Array, edit: PagesEdit): Promise<Uint8Array> {
  if (isExtension) return (await call("edit_pages", edit, pdf)).bytes!;
  return new Uint8Array(await invoke<ArrayBuffer>("edit_pages", framed(edit, pdf)));
}

/** PDF nuevo con esas páginas (desde 1). */
export async function extractPages(pdf: Uint8Array, pages: number[]): Promise<Uint8Array> {
  if (isExtension) return (await call("extract_pages", pages.map((p) => p - 1), pdf)).bytes!;
  return new Uint8Array(await invoke<ArrayBuffer>("extract_pages", framed(pages.map((p) => p - 1), pdf)));
}

/** Escribe en el PDF las anotaciones pendientes, sin guardarlo en disco. */
export async function bakeAnnotations(
  pdf: Uint8Array,
  changes: { remove: [number, number][]; add: unknown[] },
): Promise<Uint8Array> {
  if (isExtension) return (await call("bake_annotations", changes, pdf)).bytes!;
  return new Uint8Array(await invoke<ArrayBuffer>("bake_annotations", framed(changes, pdf)));
}

/** Navegador: descarga el PDF a la carpeta de descargas, como el botón del visor del navegador. */
export function downloadPdf(bytes: Uint8Array, name: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Visor del navegador: abre el PDF tal como se ve (guardado en Descargas) en la app instalada. */
export async function openInApp(pdf: Uint8Array, name: string): Promise<string> {
  return (await call<{ path: string }>("open_in_app", { name }, pdf)).result.path;
}

/** Un archivo de entrada para el modo edición: ruta en la app, contenido en el navegador. */
export type FileSource = { path: string } | { data: string };

/** Navegador: elige un archivo con <input type="file"> y lo devuelve en base64. */
function pickFile(accept: string): Promise<FileSource | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = async () => {
      const file = input.files?.[0];
      resolve(file ? { data: toBase64(new Uint8Array(await file.arrayBuffer())) } : null);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/** Elige un PDF para insertar sus páginas (null si se cancela). */
export async function pickPdfSource(): Promise<FileSource | null> {
  if (!isTauri) return pickFile("application/pdf,.pdf");
  const path = await open({ multiple: false, directory: false, filters: PDF_FILTER });
  return path ? { path } : null;
}

/** Extensión del navegador: carpeta para «Cargar descomprimida» y navegadores instalados. */
export interface ExtensionInfo {
  folder: string;
  browsers: { id: string; name: string }[];
}

export function extensionInfo(): Promise<ExtensionInfo> {
  return invoke<ExtensionInfo>("extension_info");
}

export function openExtensionFolder(): Promise<void> {
  return invoke("open_extension_folder");
}

/** Abre la página de extensiones de Chrome, Edge o Brave. */
export function openBrowserExtensions(id: string): Promise<void> {
  return invoke("open_browser_extensions", { id });
}

/** Elige una imagen para insertarla en el PDF (null si se cancela). */
export async function pickImage(): Promise<FileSource | null> {
  if (!isTauri) return pickFile("image/png,image/jpeg,image/gif,image/bmp,image/webp");
  const path = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Imágenes", extensions: ["png", "jpg", "jpeg", "gif", "bmp", "webp"] }],
  });
  return path ? { path } : null;
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
  userName ??= isTauri
    ? invoke<string>("user_name").catch(() => "")
    : isExtension
      ? call<string>("user_name", null).then((r) => r.result).catch(() => "")
      : Promise.resolve("");
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

/**
 * Visor del navegador: el PDF que se estaba abriendo (viewer.html?file=<dirección>). Se descarga
 * con la sesión del navegador, como haría su propio visor.
 */
export async function getStartupDocument(): Promise<OpenedFile | null> {
  const url = viewedUrl();
  if (!url) return null;
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`el servidor respondió ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { name: nameFromResponse(res, url), path: null, bytes };
}

/**
 * Dirección del PDF que muestra el visor: todo lo que sigue a «?file=», sin descodificar (la
 * regla de la extensión la añade tal cual, con sus propios «&» y «%»).
 */
export function viewedUrl(): string | null {
  if (!isExtension) return null;
  const i = location.href.indexOf("?file=");
  return i < 0 ? null : location.href.slice(i + 6) || null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const chrome: any;

/** Visor del navegador: vuelve a abrir el PDF con el visor propio del navegador. */
export async function showInBrowserViewer(): Promise<void> {
  const url = viewedUrl();
  if (url) await chrome.runtime.sendMessage({ type: "browser-viewer", url });
}

/** Nombre del archivo: el que indique el servidor o el final de la dirección. */
function nameFromResponse(res: Response, url: string): string {
  const cd = res.headers.get("content-disposition") || "";
  const star = cd.match(/filename\*\s*=\s*[^']*'[^']*'([^;]+)/i);
  const plain = cd.match(/filename\s*=\s*"?([^";]+)"?/i);
  let name = "";
  try {
    name = star ? decodeURIComponent(star[1]) : plain ? plain[1] : decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
  } catch {
    name = "";
  }
  name = name.trim() || "documento.pdf";
  return /\.pdf$/i.test(name) ? name : `${name}.pdf`;
}

export async function setWindowTitle(title: string) {
  if (isTauri) await getCurrentWindow().setTitle(title);
  else document.title = title;
}
