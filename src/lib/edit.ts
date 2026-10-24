// Modo edición: cambios en el contenido del PDF (no anotaciones), hechos con PDFium en Rust.
import type { Rect } from "./annotations";

/** Tramo de texto de una página: objetos seguidos de una línea con igual tipografía. */
export interface TextRun {
  /** Objetos de la página que lo forman (válidos para el PDF del que se leyeron). */
  objects: number[];
  text: string;
  rect: Rect;
  baseline: number;
  /** Tamaño con el que se ve, en puntos. */
  size: number;
  family: string;
  bold: boolean;
  italic: boolean;
  serif: boolean;
  mono: boolean;
  color: [number, number, number];
}

export interface ImageObject {
  index: number;
  rect: Rect;
}

/** Lo que se puede editar en una página. */
export interface PageContent {
  runs: TextRun[];
  images: ImageObject[];
}

export type EditFont = "sans" | "serif" | "mono";

/** Cambio en una página (coordenadas PDF); lo aplica `edit_page` en Rust. */
export type PageEdit =
  | { op: "text"; objects: number[]; text: string }
  | { op: "addText"; x: number; y: number; text: string; size: number; color: [number, number, number]; font: EditFont }
  | { op: "move"; index: number; rect: Rect }
  | { op: "delete"; indices: number[] }
  | { op: "addImage"; path: string; center: [number, number]; max: [number, number] }
  | { op: "cover"; rect: Rect };

export const EDIT_FONTS: { font: EditFont; label: string; css: string }[] = [
  { font: "sans", label: "Sans", css: "Helvetica, Arial, sans-serif" },
  { font: "serif", label: "Serif", css: '"Times New Roman", Times, serif' },
  { font: "mono", label: "Mono", css: '"Courier New", Courier, monospace' },
];

/** Tipografía CSS más parecida a la del tramo (la suya si está instalada en Windows). */
export function cssFont(run: TextRun, px: number): string {
  const generic = run.mono ? "monospace" : run.serif ? "serif" : "sans-serif";
  const family = run.family.replace(/["\\]/g, "");
  return `${run.italic ? "italic " : ""}${run.bold ? "bold " : ""}${px}px "${family}", ${generic}`;
}

/** Posición del cursor dentro de `text` para un clic a `x` px de su inicio. */
export function caretAt(text: string, font: string, x: number): number {
  const ctx = document.createElement("canvas").getContext("2d")!;
  ctx.font = font;
  let prev = 0;
  for (let i = 1; i <= text.length; i++) {
    const w = ctx.measureText(text.slice(0, i)).width;
    if (x < (prev + w) / 2) return i - 1;
    prev = w;
  }
  return text.length;
}

export function textWidth(text: string, font: string): number {
  const ctx = document.createElement("canvas").getContext("2d")!;
  ctx.font = font;
  return ctx.measureText(text).width;
}
