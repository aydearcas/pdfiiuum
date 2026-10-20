// Anotaciones pendientes de guardar. Todas las coordenadas están en el espacio
// de usuario del PDF (puntos, origen abajo a la izquierda), como las usa PDFium.

export type Rect = [number, number, number, number]; // x1, y1, x2, y2
export type Point = [number, number];

export type MarkupKind = "highlight" | "underline" | "strikeout";
export type AnnotKind = MarkupKind | "note" | "text" | "ink";

interface Base {
  id: string;
  /** Página empezando en 1 (como pdf.js). */
  page: number;
  color: string;
  contents?: string;
  date: string;
  /** Autor: el usuario de Windows. */
  author?: string;
  /** Si ya estaba guardada en el PDF: [página desde 0, índice en la página]. */
  origin?: [number, number];
}

export interface MarkupAnnot extends Base {
  kind: MarkupKind;
  rects: Rect[];
  quote: string;
}
export interface NoteAnnot extends Base {
  kind: "note";
  /** Esquina superior izquierda del icono. */
  point: Point;
}
export interface TextAnnot extends Base {
  kind: "text";
  rect: Rect;
  text: string;
  fontSize: number;
}
export interface InkAnnot extends Base {
  kind: "ink";
  strokes: Point[][];
  width: number;
}

export type Annot = MarkupAnnot | NoteAnnot | TextAnnot | InkAnnot;

/** Tamaño del icono de nota en puntos (PDFium lo dibuja a 20×20). */
export const NOTE_SIZE = 20;
export const TEXT_LINE_HEIGHT = 1.2;
export const TEXT_FONT = "Helvetica, Arial, sans-serif";

export const PALETTE = ["#ffd400", "#7ce35b", "#3fa9f5", "#ff6fb5", "#e2231a", "#13a35a", "#1d4ed8", "#111111"];
/** Colores claros pensados para resaltar (se mezclan con el texto en modo multiplicar). */
export const HIGHLIGHT_COLORS = ["#ffd400", "#ff9f1a", "#7ce35b", "#3fd6c9", "#3fa9f5", "#b388ff", "#ff6fb5", "#ff5252"];

export const paletteFor = (kind: AnnotKind) => (kind === "highlight" ? HIGHLIGHT_COLORS : PALETTE);
export const FONT_SIZES = [10, 12, 14, 18, 24, 32];
export const INK_WIDTHS = [1, 2, 4, 8];

export const KIND_LABEL: Record<AnnotKind, string> = {
  highlight: "Resaltado",
  underline: "Subrayado",
  strikeout: "Tachado",
  note: "Nota",
  text: "Texto",
  ink: "Dibujo",
};

let seq = 0;
export const newId = () => `a${Date.now().toString(36)}${(seq++).toString(36)}`;

export function normalize([x1, y1, x2, y2]: Rect): Rect {
  return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
}

export function union(rects: Rect[]): Rect {
  return rects.reduce<Rect>(
    (u, r) => [Math.min(u[0], r[0]), Math.min(u[1], r[1]), Math.max(u[2], r[2]), Math.max(u[3], r[3])],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
}

export function bounds(a: Annot): Rect {
  switch (a.kind) {
    case "note":
      return [a.point[0], a.point[1] - NOTE_SIZE, a.point[0] + NOTE_SIZE, a.point[1]];
    case "text":
      return normalize(a.rect);
    case "ink": {
      const pts = a.strokes.flat();
      const h = a.width / 2;
      const u = union(pts.map(([x, y]) => [x, y, x, y] as Rect));
      return [u[0] - h, u[1] - h, u[2] + h, u[3] + h];
    }
    default:
      return union(a.rects);
  }
}

export function contains([x1, y1, x2, y2]: Rect, [x, y]: Point, pad = 0): boolean {
  return x >= x1 - pad && x <= x2 + pad && y >= y1 - pad && y <= y2 + pad;
}

/** Fecha en formato PDF: D:AAAAMMDDHHmmSS+hh'mm' */
export function pdfDate(d = new Date()): string {
  const p = (n: number) => String(Math.abs(n)).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  return (
    `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` +
    `${off >= 0 ? "+" : "-"}${p(Math.trunc(off / 60))}'${p(off % 60)}'`
  );
}

/** «D:20261020213000+02'00'» → «20/10/2026 21:30». */
export function formatPdfDate(d: string | null | undefined): string {
  const m = d?.match(/^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?/);
  if (!m) return "";
  const [, y, mo = "01", da = "01", h, mi] = m;
  return `${da}/${mo}/${y}${h ? ` ${h}:${mi ?? "00"}` : ""}`;
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Caja que ocupa un texto (en puntos) con la tipografía Helvetica. */
export function measureText(text: string, fontSize: number, top: Point): Rect {
  const ctx = document.createElement("canvas").getContext("2d")!;
  ctx.font = `${fontSize}px ${TEXT_FONT}`;
  const lines = text.split("\n");
  const width = Math.max(...lines.map((l) => ctx.measureText(l).width), fontSize);
  const height = lines.length * fontSize * TEXT_LINE_HEIGHT;
  const [x, y] = top;
  return [x, y - height - 2, x + width + 6, y];
}

/** Anotación guardada en el PDF tal como la devuelve `extract_annotations` (Rust). */
export interface NativeExisting {
  kind: AnnotKind;
  page: number;
  index: number;
  color: [number, number, number];
  rects: Rect[];
  point: Point | null;
  rect: Rect | null;
  text: string | null;
  fontSize: number | null;
  width: number | null;
  strokes: Point[][];
  contents: string;
  author: string;
  date: string;
}

const toHex = (c: [number, number, number]) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");

/** Convierte una anotación guardada en una editable, recordando de dónde viene. */
export function fromNative(e: NativeExisting): Annot {
  const base = {
    id: `s${e.page}-${e.index}`,
    page: e.page + 1,
    color: toHex(e.color),
    contents: e.contents,
    date: e.date,
    author: e.author,
    origin: [e.page, e.index] as [number, number],
  };
  switch (e.kind) {
    case "note":
      return { ...base, kind: "note", point: e.point ?? [0, 0] };
    case "text":
      return { ...base, kind: "text", rect: e.rect ?? [0, 0, 0, 0], text: e.text ?? "", fontSize: e.fontSize ?? 12 };
    case "ink":
      return { ...base, kind: "ink", strokes: e.strokes, width: e.width ?? 1 };
    default:
      return { ...base, kind: e.kind, rects: e.rects, quote: "" };
  }
}

/** Contenido que se guarda (sin la cita, que solo es para mostrar). */
const signature = (a: Annot) => JSON.stringify({ ...a, quote: undefined });

/**
 * Cambios respecto a lo que hay guardado en el PDF: originales que hay que quitar
 * (borradas o modificadas) y anotaciones que hay que escribir (nuevas o modificadas).
 */
export function diffAnnots(baseline: Annot[], current: Annot[]) {
  const before = new Map(baseline.map((a) => [a.id, signature(a)]));
  const now = new Set(current.map((a) => a.id));
  const changed = current.filter((a) => before.get(a.id) !== signature(a));
  const changedIds = new Set(changed.map((a) => a.id));
  const remove = baseline.filter((a) => !now.has(a.id) || changedIds.has(a.id)).map((a) => a.origin!);
  return { remove, add: changed, changedIds, dirty: remove.length > 0 || changed.length > 0 };
}

/** Formato que espera el comando `save_annotated` de Rust. */
export function toNative(a: Annot) {
  const base = {
    kind: a.kind,
    page: a.page - 1,
    color: hexToRgb(a.color),
    contents: a.contents || undefined,
    date: a.date,
    author: a.author || undefined,
  };
  switch (a.kind) {
    case "note":
      return { ...base, point: a.point };
    case "text":
      return { ...base, rect: a.rect, text: a.text, fontSize: a.fontSize };
    case "ink":
      return { ...base, strokes: a.strokes, width: a.width };
    default:
      return { ...base, rects: a.rects };
  }
}
