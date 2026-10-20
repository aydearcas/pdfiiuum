// Convierte la selección de texto de pdf.js en rectángulos (uno por línea) por página.
import type { PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import { normalize, type Rect } from "./annotations";

export interface PageSelection {
  page: number;
  rects: Rect[];
}

export interface TextSelection {
  pages: PageSelection[];
  text: string;
  /** Caja en pantalla del final de la selección, para colocar el menú. */
  anchor: DOMRect;
}

export function readSelection(viewer: PDFViewer): TextSelection | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const root =
    range.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? range.commonAncestorContainer.parentNode!
      : range.commonAncestorContainer;

  const byPage = new Map<number, Rect[]>();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let anchor: DOMRect | null = null;
  for (let node = walker.currentNode; node; node = walker.nextNode()!) {
    if (node.nodeType !== Node.TEXT_NODE || !range.intersectsNode(node)) continue;
    const el = node.parentElement;
    if (!el?.closest(".textLayer")) continue;
    const pageDiv = el.closest<HTMLElement>(".page");
    const page = Number(pageDiv?.dataset.pageNumber);
    if (!pageDiv || !page) continue;

    const part = document.createRange();
    part.selectNodeContents(node);
    if (node === range.startContainer) part.setStart(node, range.startOffset);
    if (node === range.endContainer) part.setEnd(node, range.endOffset);
    if (part.collapsed) continue;

    const view = viewer.getPageView(page - 1);
    const box = pageDiv.getBoundingClientRect();
    for (const r of part.getClientRects()) {
      if (r.width < 0.5 || r.height < 0.5) continue;
      const [x1, y1] = view.viewport.convertToPdfPoint(r.left - box.left, r.top - box.top);
      const [x2, y2] = view.viewport.convertToPdfPoint(r.right - box.left, r.bottom - box.top);
      const list = byPage.get(page) ?? [];
      list.push(normalize([x1, y1, x2, y2]));
      byPage.set(page, list);
      anchor = r;
    }
  }
  if (!anchor || byPage.size === 0) return null;

  return {
    pages: [...byPage].map(([page, rects]) => ({ page, rects: mergeLines(rects) })),
    text: sel.toString(),
    anchor,
  };
}

/** Une los trozos de una misma línea en un único rectángulo. */
function mergeLines(rects: Rect[]): Rect[] {
  const sorted = [...rects].sort((a, b) => b[3] - a[3] || a[0] - b[0]);
  const lines: Rect[] = [];
  for (const r of sorted) {
    const h = r[3] - r[1];
    const line = lines.find((l) => {
      const overlap = Math.min(l[3], r[3]) - Math.max(l[1], r[1]);
      const gap = Math.max(r[0] - l[2], l[0] - r[2]);
      return overlap > 0.5 * Math.min(h, l[3] - l[1]) && gap < h * 1.5;
    });
    if (line) {
      line[0] = Math.min(line[0], r[0]);
      line[1] = Math.min(line[1], r[1]);
      line[2] = Math.max(line[2], r[2]);
      line[3] = Math.max(line[3], r[3]);
    } else lines.push([...r]);
  }
  return lines;
}
