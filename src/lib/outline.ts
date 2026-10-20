// Marcadores (índice) del PDF, con la página a la que apunta cada uno.
import type { PDFDocument } from "./pdf";

export interface OutlineNode {
  id: string;
  title: string;
  /** Destino de pdf.js (nombre o array explícito); null si es un enlace web. */
  dest: string | unknown[] | null;
  url: string | null;
  /** Página de destino, empezando en 1 (null si no se puede resolver). */
  page: number | null;
  bold: boolean;
  italic: boolean;
  /** Abierto por defecto (Count positivo en el PDF). */
  open: boolean;
  children: OutlineNode[];
}

type RawItem = Awaited<ReturnType<PDFDocument["getOutline"]>>[number];

export async function loadOutline(pdf: PDFDocument): Promise<OutlineNode[]> {
  const raw = await pdf.getOutline();
  if (!raw?.length) return [];
  let seq = 0;
  const convert = async (items: RawItem[]): Promise<OutlineNode[]> =>
    Promise.all(
      items.map(async (it) => ({
        id: `o${seq++}`,
        title: it.title?.trim() || "(sin título)",
        dest: it.dest,
        url: it.url,
        page: await pageOf(pdf, it.dest),
        bold: !!it.bold,
        italic: !!it.italic,
        open: (it.count ?? 0) > 0,
        children: await convert(it.items ?? []),
      })),
    );
  return convert(raw);
}

async function pageOf(pdf: PDFDocument, dest: RawItem["dest"]): Promise<number | null> {
  try {
    const explicit = typeof dest === "string" ? await pdf.getDestination(dest) : dest;
    const target = explicit?.[0];
    if (target == null) return null;
    if (typeof target === "number") return target + 1;
    return (await pdf.getPageIndex(target)) + 1;
  } catch {
    return null;
  }
}

/**
 * Marcador de la sección que se está leyendo: el de página más alta que no pase de la actual.
 * Si varios empiezan en esa página, el primero en orden de lectura.
 */
export function currentNode(nodes: OutlineNode[], page: number): string | null {
  let best: { id: string; page: number } | null = null;
  const walk = (list: OutlineNode[]) => {
    for (const n of list) {
      if (n.page != null && n.page <= page && (!best || n.page > best.page)) best = { id: n.id, page: n.page };
      walk(n.children);
    }
  };
  walk(nodes);
  return (best as { id: string } | null)?.id ?? null;
}

/** Ids de los antepasados de un marcador (para desplegar hasta él). */
export function ancestorsOf(nodes: OutlineNode[], id: string): string[] {
  const path: string[] = [];
  const find = (list: OutlineNode[]): boolean => {
    for (const n of list) {
      if (n.id === id) return true;
      path.push(n.id);
      if (find(n.children)) return true;
      path.pop();
    }
    return false;
  };
  return find(nodes) ? path : [];
}
