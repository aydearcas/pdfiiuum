// Comentarios y marcas que ya están guardados dentro del PDF (leídos con pdf.js).
import type { PDFDocument } from "./pdf";
import { normalize, type AnnotKind, type Rect } from "./annotations";

export interface SavedAnnot {
  id: string;
  page: number;
  kind: AnnotKind;
  color: string;
  contents: string;
  author: string;
  date: string;
  /** Texto que cubre el resaltado/subrayado/tachado. */
  quote: string;
  rect: Rect;
}

const KINDS: Record<string, AnnotKind> = {
  Text: "note",
  Highlight: "highlight",
  Underline: "underline",
  StrikeOut: "strikeout",
};

interface RawAnnot {
  id: string;
  subtype: string;
  rect: number[];
  color: Uint8ClampedArray | number[] | null;
  contentsObj?: { str: string };
  titleObj?: { str: string };
  modificationDate?: string | null;
  creationDate?: string | null;
  quadPoints?: ArrayLike<number> | null;
  inReplyTo?: string;
}

interface TextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

const toHex = (c: RawAnnot["color"]) =>
  c && c.length >= 3 ? "#" + [...c].slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("") : "#ffd400";

/** Lee notas y marcas de todas las páginas. `isCancelled` permite abandonar si cambia el documento. */
export async function readSavedAnnots(pdf: PDFDocument, isCancelled: () => boolean): Promise<SavedAnnot[]> {
  const out: SavedAnnot[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    if (isCancelled()) return out;
    const page = await pdf.getPage(n);
    const raw = ((await page.getAnnotations({ intent: "display" })) as RawAnnot[]).filter(
      (a) => KINDS[a.subtype] && !a.inReplyTo,
    );
    if (!raw.length) continue;
    let items: TextItem[] | null = null;
    for (const a of raw) {
      const kind = KINDS[a.subtype];
      const rects = quads(a);
      if (kind !== "note" && !items) {
        items = ((await page.getTextContent()).items as TextItem[]).filter((i) => "str" in i);
      }
      out.push({
        id: a.id,
        page: n,
        kind,
        color: toHex(a.color),
        contents: a.contentsObj?.str ?? "",
        author: a.titleObj?.str ?? "",
        date: a.modificationDate ?? a.creationDate ?? "",
        quote: kind === "note" || !items ? "" : quoteUnder(rects, items),
        rect: normalize(a.rect as Rect),
      });
    }
  }
  return out;
}

/** Rectángulos de las QuadPoints (uno por línea). */
function quads(a: RawAnnot): Rect[] {
  const q = a.quadPoints;
  if (!q || q.length < 8) return [normalize(a.rect as Rect)];
  const rects: Rect[] = [];
  for (let i = 0; i + 7 < q.length; i += 8) {
    const xs = [q[i], q[i + 2], q[i + 4], q[i + 6]];
    const ys = [q[i + 1], q[i + 3], q[i + 5], q[i + 7]];
    rects.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
  }
  return rects;
}

/** Texto aproximado bajo los rectángulos (recorta cada trozo según el solape horizontal). */
function quoteUnder(rects: Rect[], items: TextItem[]): string {
  const lines: string[] = [];
  for (const [x1, y1, x2, y2] of rects) {
    let line = "";
    for (const it of items) {
      if (!it.str || !it.width) continue;
      const x = it.transform[4];
      const y = it.transform[5];
      const h = it.height || Math.abs(it.transform[3]) || 1;
      const overlapY = Math.min(y + h, y2) - Math.max(y, y1);
      if (overlapY < h * 0.5) continue;
      const from = Math.max(0, (x1 - x) / it.width);
      const to = Math.min(1, (x2 - x) / it.width);
      if (to <= from) continue;
      const len = it.str.length;
      line += it.str.slice(Math.round(from * len), Math.round(to * len));
    }
    if (line.trim()) lines.push(line.trim());
  }
  return lines.join(" ");
}
