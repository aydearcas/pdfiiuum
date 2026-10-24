// Abrir un documento: las anotaciones que ya tiene pasan a la capa editable de la app
// y pdf.js muestra una copia del PDF sin ellas (para no dibujarlas dos veces).
import { loadPdf, type PDFDocument } from "./pdf";
import { fromNative, type Annot, type Rect } from "./annotations";
import { extractAnnotations, hasPdfium } from "./platform";

export interface OpenedDocument {
  pdf: PDFDocument;
  /** Anotaciones guardadas en el PDF, ya editables. */
  baseline: Annot[];
  /**
   * Las anotaciones del PDF aún no se han leído con PDFium: pdf.js las dibuja tal cual, sin
   * poder editarlas, hasta que el usuario empieza a anotar, editar o guardar.
   */
  deferred: boolean;
}

/**
 * Con `defer` (visor del navegador) no se usa PDFium al abrir: el PDF puede venir de cualquier
 * web, y PDFium corre en la app instalada, fuera del sandbox del navegador. Solo se le manda
 * cuando el usuario hace algo que lo necesita.
 */
export async function openDocument(bytes: Uint8Array, { defer = false } = {}): Promise<OpenedDocument> {
  const deferred = hasPdfium && defer;
  const extracted = hasPdfium && !defer ? await extractAnnotations(bytes).catch(() => null) : null;
  const pdf = await loadPdf(extracted?.display ?? bytes);
  const baseline = extracted ? await withQuotes(pdf, extracted.annots.map(fromNative)) : [];
  return { pdf, baseline, deferred };
}

interface TextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

/** Añade a los resaltados/subrayados/tachados el texto que cubren (para el panel y la tarjeta). */
async function withQuotes(pdf: PDFDocument, annots: Annot[]): Promise<Annot[]> {
  const pages = new Set(annots.filter((a) => "rects" in a).map((a) => a.page));
  const text = new Map<number, TextItem[]>();
  for (const n of pages) {
    const content = await (await pdf.getPage(n)).getTextContent();
    text.set(n, (content.items as TextItem[]).filter((i) => "str" in i));
  }
  return annots.map((a) => ("rects" in a ? { ...a, quote: quoteUnder(a.rects, text.get(a.page) ?? []) } : a));
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
