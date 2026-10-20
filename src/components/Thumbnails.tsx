import { useEffect, useRef, useState } from "react";
import type { PDFDocument } from "../lib/pdf";

const THUMB_WIDTH = 132;

interface Props {
  doc: PDFDocument;
  currentPage: number;
  onSelect(page: number): void;
}

export default function Thumbnails({ doc, currentPage, onSelect }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const pages = Array.from({ length: doc.numPages }, (_, i) => i + 1);

  // Mantiene visible la miniatura de la página actual.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-page="${currentPage}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [currentPage]);

  return (
    <aside className="thumbs" ref={listRef}>
      {pages.map((n) => (
        <Thumb
          key={n}
          doc={doc}
          page={n}
          active={n === currentPage}
          root={listRef}
          onClick={() => onSelect(n)}
        />
      ))}
    </aside>
  );
}

function Thumb({
  doc,
  page,
  active,
  root,
  onClick,
}: {
  doc: PDFDocument;
  page: number;
  active: boolean;
  root: React.RefObject<HTMLDivElement | null>;
  onClick(): void;
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
      className={`thumb${active ? " active" : ""}`}
      onClick={onClick}
      title={`Página ${page}`}
    >
      <span className="thumb-paper" style={{ width: THUMB_WIDTH, height: THUMB_WIDTH * ratio }}>
        <canvas ref={canvasRef} />
      </span>
      <span className="thumb-label">{page}</span>
    </button>
  );
}
