// Firma manuscrita: se dibuja una vez, se guarda en este equipo y se coloca en cualquier PDF
// como un dibujo (anotación Ink), que luego se mueve, se cambia de tamaño o se borra.
import { useSyncExternalStore } from "react";
import { newId, pdfDate, type InkAnnot, type Point } from "./annotations";

/**
 * Trazos con el origen arriba a la izquierda y la altura de la firma como unidad: x va de 0 a
 * `aspect` e y de 0 a 1. `width` es el grosor del trazo, también en esa unidad.
 */
export interface Signature {
  strokes: Point[][];
  aspect: number;
  width: number;
  color: string;
}

export const SIGNATURE_COLORS = [
  { color: "#111111", label: "Negro" },
  { color: "#1d3fae", label: "Azul" },
];

/** Ancho con el que se coloca (puntos PDF, unos 5 cm), como mucho el 40 % de la página. */
const PLACE_WIDTH = 140;

const KEY = "pdfiiuum.signature";
const listeners = new Set<() => void>();
let cache: Signature | null | undefined;

function valid(s: unknown): s is Signature {
  if (!s || typeof s !== "object") return false;
  const v = s as Signature;
  const num = (n: unknown) => typeof n === "number" && Number.isFinite(n);
  return (
    num(v.aspect) &&
    v.aspect > 0 &&
    num(v.width) &&
    v.width > 0 &&
    typeof v.color === "string" &&
    /^#[0-9a-f]{6}$/i.test(v.color) &&
    Array.isArray(v.strokes) &&
    v.strokes.length > 0 &&
    v.strokes.every((st) => Array.isArray(st) && st.length > 0 && st.every((p) => Array.isArray(p) && num(p[0]) && num(p[1])))
  );
}

export function getSignature(): Signature | null {
  if (cache !== undefined) return cache;
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "null");
    cache = valid(parsed) ? parsed : null;
  } catch {
    cache = null;
  }
  return cache;
}

/** Guarda (o con `null` borra) la firma de este equipo. */
export function setSignature(s: Signature | null) {
  cache = s;
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    /* sin almacenamiento: la firma dura solo esta sesión */
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export const useSignature = () => useSyncExternalStore(subscribe, getSignature);

/**
 * Firma a partir de los trazos dibujados (píxeles, origen arriba a la izquierda): se recorta
 * a lo dibujado y se pasa a la unidad de la firma. `null` si no hay nada dibujado.
 */
export function makeSignature(strokes: Point[][], lineWidth: number, color: string): Signature | null {
  const pts = strokes.flat();
  if (!pts.length) return null;
  const h = lineWidth / 2;
  const minX = Math.min(...pts.map((p) => p[0])) - h;
  const minY = Math.min(...pts.map((p) => p[1])) - h;
  const maxX = Math.max(...pts.map((p) => p[0])) + h;
  const maxY = Math.max(...pts.map((p) => p[1])) + h;
  // Una raya horizontal no tiene altura: se toma como unidad el grosor del trazo.
  const unit = Math.max(maxY - minY, lineWidth * 2);
  const round = (n: number) => Math.round(n * 10000) / 10000;
  return {
    strokes: strokes.map((s) => s.map(([x, y]) => [round((x - minX) / unit), round((y - minY) / unit)] as Point)),
    aspect: round(Math.max(maxX - minX, lineWidth * 2) / unit),
    width: round(lineWidth / unit),
    color,
  };
}

/** Tamaño (puntos) con el que se coloca la firma en una página que se ve con `pageWidth` puntos de ancho. */
export function placeSize(s: Signature, pageWidth: number): [number, number] {
  const w = Math.min(PLACE_WIDTH, pageWidth * 0.4);
  return [w, w / s.aspect];
}

/**
 * Trazos de la firma en píxeles de la vista, centrada en `at` y con el tamaño con que se coloca
 * (`scale` píxeles por punto). Se colocan en la vista para que salga derecha aunque la página
 * esté girada.
 */
export function signatureInView(s: Signature, at: Point, scale: number, viewWidth: number): { strokes: Point[][]; width: number } {
  const [w, h] = placeSize(s, viewWidth / scale);
  const unit = h * scale;
  const left = at[0] - (w * scale) / 2;
  const top = at[1] - unit / 2;
  return {
    strokes: s.strokes.map((st) => st.map(([x, y]) => [left + x * unit, top + y * unit] as Point)),
    width: s.width * unit,
  };
}

/** La firma como dibujo de la página `page`; `toPdf` pasa de píxeles de la vista a puntos PDF. */
export function signatureAnnot(
  s: Signature,
  page: number,
  at: Point,
  scale: number,
  viewWidth: number,
  toPdf: (p: Point) => Point,
): InkAnnot {
  const view = signatureInView(s, at, scale, viewWidth);
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    id: newId(),
    kind: "ink",
    page,
    color: s.color,
    width: round(view.width / scale),
    strokes: view.strokes.map((st) => st.map((p) => toPdf(p).map(round) as Point)),
    contents: "",
    date: pdfDate(),
  };
}
