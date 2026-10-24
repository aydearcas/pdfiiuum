// Trazos a mano alzada: suavizado, simplificación, borrado y estado del lápiz.
import type { InkAnnot, Point } from "./annotations";

/** Trazos seguidos más cerca que esto (ms) se guardan en la misma anotación, como en OneNote. */
export const GROUP_MS = 1500;
/** …siempre que el trazo nuevo empiece a menos de esta distancia (puntos PDF) del grupo. */
export const GROUP_GAP = 60;

/** Botón de goma: el extremo trasero del lápiz (botón 5) o el botón lateral (botón 2). */
export const ERASER_BUTTONS = 32 | 2;

/** Último dibujo creado, para seguir añadiéndole trazos mientras se escribe. */
export const lastInk: { id: string | null; page: number; at: number } = { id: null, page: 0, at: 0 };

/**
 * Desde que se usa un lápiz, el dedo solo desplaza la página (no dibuja ni con la herramienta
 * Dibujo). La clase en <body> cambia el touch-action de la capa de dibujo.
 */
export function markPenSeen() {
  document.body.classList.add("pen-seen");
}
export const penSeen = () => document.body.classList.contains("pen-seen");

/** Esquinas redondeadas (Chaikin): convierte el polígono de muestras en una curva suave. */
function chaikin(pts: Point[], rounds = 2): Point[] {
  let out = pts;
  for (let r = 0; r < rounds && out.length > 2; r++) {
    const next: Point[] = [out[0]];
    for (let i = 0; i < out.length - 1; i++) {
      const [ax, ay] = out[i];
      const [bx, by] = out[i + 1];
      next.push([0.75 * ax + 0.25 * bx, 0.75 * ay + 0.25 * by], [0.25 * ax + 0.75 * bx, 0.25 * ay + 0.75 * by]);
    }
    next.push(out[out.length - 1]);
    out = next;
  }
  return out;
}

function segDist([px, py]: Point, [ax, ay]: Point, [bx, by]: Point): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Douglas-Peucker: quita los puntos que no cambian la forma más de `tol`. */
function simplify(pts: Point[], tol: number): Point[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = 0;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const d = segDist(pts[i], pts[a], pts[b]);
      if (d > worst) [worst, at] = [d, i];
    }
    if (worst > tol) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/**
 * Trazo listo para guardar: suavizado y con los puntos justos. `tol` es el error admitido en
 * puntos PDF (depende del zoom con el que se dibujó). Un toque sin moverse se guarda como punto.
 */
export function finishStroke(raw: Point[], tol: number): Point[] {
  if (raw.length === 1) {
    const [x, y] = raw[0];
    return [raw[0], [x + 0.1, y]];
  }
  const round = (n: number) => Math.round(n * 100) / 100;
  return simplify(chaikin(raw), tol).map(([x, y]) => [round(x), round(y)] as Point);
}

/** Trazado SVG con curvas por los puntos medios: sin esquinas aunque haya pocos puntos. */
export function smoothPathD(pts: Point[]): string {
  if (!pts.length) return "";
  const f = (n: number) => n.toFixed(1);
  if (pts.length < 3) return pts.map(([x, y], i) => `${i ? "L" : "M"}${f(x)} ${f(y)}`).join(" ");
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x, y] = pts[i];
    const [nx, ny] = pts[i + 1];
    d += ` Q${f(x)} ${f(y)} ${f((x + nx) / 2)} ${f((y + ny) / 2)}`;
  }
  const [lx, ly] = pts[pts.length - 1];
  return d + ` L${f(lx)} ${f(ly)}`;
}

/** Índice del trazo de `a` que pasa a menos de `tol` del punto (o -1). */
export function strokeAt(a: InkAnnot, pt: Point, tol: number): number {
  const reach = tol + a.width / 2;
  return a.strokes.findIndex((s) =>
    s.length === 1
      ? Math.hypot(pt[0] - s[0][0], pt[1] - s[0][1]) <= reach
      : s.some((p, i) => i > 0 && segDist(pt, s[i - 1], p) <= reach),
  );
}

/** Distancia del punto a la caja que ocupa la anotación (0 si está dentro). */
export function distToInk(a: InkAnnot, [x, y]: Point): number {
  const pts = a.strokes.flat();
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const dx = Math.max(Math.min(...xs) - x, 0, x - Math.max(...xs));
  const dy = Math.max(Math.min(...ys) - y, 0, y - Math.max(...ys));
  return Math.hypot(dx, dy);
}
