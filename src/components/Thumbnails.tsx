import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import type { PDFDocument } from "../lib/pdf";

const THUMB_WIDTH = 132;

/** Modo «Organizar páginas»: selección de varias páginas y reordenar arrastrando. */
export interface PageEditing {
  /** Páginas seleccionadas (desde 1). */
  selected: number[];
  onSelectPages(pages: number[]): void;
  /** Mueve las páginas delante de la página `before` (número de páginas + 1 = al final). */
  onMove(pages: number[], before: number): void;
}

interface Props {
  doc: PDFDocument;
  currentPage: number;
  onSelect(page: number): void;
  editing?: PageEditing;
}

export default function Thumbnails({ doc, currentPage, onSelect, editing }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const pages = Array.from({ length: doc.numPages }, (_, i) => i + 1);
  const lastClicked = useRef<number | null>(null);
  const [drag, setDrag] = useState<{ pages: number[]; before: number } | null>(null);

  // Mantiene visible la miniatura de la página actual.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-page="${currentPage}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [currentPage]);

  /** Clic: Ctrl añade o quita, Mayús selecciona el intervalo desde el último clic. */
  const select = (n: number, e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => {
    onSelect(n);
    if (!editing) return;
    let sel: number[];
    if (e.shiftKey && lastClicked.current) {
      const [a, b] = [Math.min(lastClicked.current, n), Math.max(lastClicked.current, n)];
      sel = [...new Set([...editing.selected, ...pages.slice(a - 1, b)])];
    } else if (e.ctrlKey || e.metaKey) {
      sel = editing.selected.includes(n) ? editing.selected.filter((p) => p !== n) : [...editing.selected, n];
    } else sel = [n];
    lastClicked.current = n;
    editing.onSelectPages(sel.sort((a, b) => a - b));
  };

  /**
   * Arrastrar para reordenar con eventos de puntero (el arrastre HTML no funciona en la app
   * porque la ventana recibe los archivos que se sueltan en ella).
   */
  const startDrag = (n: number, e: RPointerEvent) => {
    if (!editing || e.button !== 0) return;
    const list = listRef.current!;
    const target = e.currentTarget as HTMLElement;
    const start = { x: e.clientX, y: e.clientY };
    const moving = editing.selected.includes(n) ? editing.selected : [n];
    let current: { pages: number[]; before: number } | null = null;
    try {
      target.setPointerCapture(e.pointerId);
    } catch {
      /* puntero ya liberado: el arrastre sigue mientras esté sobre la miniatura */
    }

    const onMove = (ev: PointerEvent) => {
      if (!current && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 6) return;
      // Cerca de los bordes, la lista se desplaza sola.
      const box = list.getBoundingClientRect();
      if (ev.clientY < box.top + 30) list.scrollTop -= 12;
      else if (ev.clientY > box.bottom - 30) list.scrollTop += 12;
      let before = pages.length + 1;
      for (const el of list.querySelectorAll<HTMLElement>(".thumb")) {
        const r = el.getBoundingClientRect();
        if (ev.clientY < r.top + r.height / 2) {
          before = Number(el.dataset.page);
          break;
        }
      }
      current = { pages: moving, before };
      setDrag(current);
    };
    const onUp = (ev: PointerEvent) => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
      setDrag(null);
      if (current) editing.onMove(current.pages, current.before);
      else select(n, ev);
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  };

  return (
    <div className={`thumbs${editing ? " editing" : ""}${drag ? " dragging" : ""}`} ref={listRef}>
      {pages.map((n) => (
        <Thumb
          key={n}
          doc={doc}
          page={n}
          active={n === currentPage}
          selected={!!editing?.selected.includes(n)}
          drop={drag?.before === n ? "before" : drag?.before === n + 1 && n === pages.length ? "after" : null}
          root={listRef}
          onClick={(e) => !editing && select(n, e)}
          onPointerDown={(e) => startDrag(n, e)}
        />
      ))}
    </div>
  );
}

function Thumb({
  doc,
  page,
  active,
  selected,
  drop,
  root,
  onClick,
  onPointerDown,
}: {
  doc: PDFDocument;
  page: number;
  active: boolean;
  selected: boolean;
  drop: "before" | "after" | null;
  root: React.RefObject<HTMLDivElement | null>;
  onClick(e: React.MouseEvent): void;
  onPointerDown(e: RPointerEvent): void;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [ratio, setRatio] = useState(1.414);

  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => entries.some((e) => e.isIntersecting) && setVisible(true),
      { root: root.current, rootMargin: "400px 0px" },
    );
    io.observe(btnRef.current!);
    return () => io.disconnect();
  }, [root]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let task: { cancel(): void; promise: Promise<void> } | null = null;
    (async () => {
      const p = await doc.getPage(page);
      if (cancelled) return;
      const base = p.getViewport({ scale: 1 });
      const dpr = window.devicePixelRatio || 1;
      const viewport = p.getViewport({ scale: (THUMB_WIDTH * dpr) / base.width });
      setRatio(base.height / base.width);
      const canvas = canvasRef.current!;
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      task = p.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport });
      await task.promise.catch(() => {});
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [visible, doc, page]);

  return (
    <button
      ref={btnRef}
      data-page={page}
      className={`thumb${active ? " active" : ""}${selected ? " selected" : ""}${drop ? ` drop-${drop}` : ""}`}
      onClick={onClick}
      onPointerDown={onPointerDown}
      title={`Página ${page}`}
    >
      <span className="thumb-paper" style={{ width: THUMB_WIDTH, height: THUMB_WIDTH * ratio }}>
        <canvas ref={canvasRef} />
      </span>
      <span className="thumb-label">{page}</span>
    </button>
  );
}
