import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Trash2, X } from "lucide-react";
import { KIND_LABEL, formatPdfDate, paletteFor, type Annot } from "../lib/annotations";

interface Props {
  annot: Annot;
  /** Caja de la anotación en coordenadas de pantalla. */
  getAnchor(): DOMRect;
  /** Zona visible (el área del documento) dentro de la que debe quedar la tarjeta. */
  getBounds(): DOMRect;
  autoFocus: boolean;
  onBegin(): void;
  onChange(patch: Partial<Annot>): void;
  onDelete(): void;
  onClose(): void;
}

const GAP = 12;
const MARGIN = 8;

/**
 * Tarjeta de la anotación seleccionada: color, comentario y borrar.
 * Se dibuja fuera de la página (position: fixed) y se recoloca para no salirse de la vista.
 */
export default function AnnotCard({ annot, getAnchor, getBounds, autoFocus, onBegin, onChange, onDelete, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; hidden: boolean }>({ left: 0, top: 0, hidden: true });
  const [, setTick] = useState(0);
  const quote = "quote" in annot ? annot.quote : "";
  const commentable = annot.kind === "note" || "rects" in annot;

  // Recalcular al desplazar o redimensionar.
  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    document.addEventListener("scroll", bump, true);
    window.addEventListener("resize", bump);
    return () => {
      document.removeEventListener("scroll", bump, true);
      window.removeEventListener("resize", bump);
    };
  }, []);

  useLayoutEffect(() => {
    const el = ref.current!;
    const a = getAnchor();
    const b = getBounds();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const visible = a.bottom > b.top && a.top < b.bottom && a.right > b.left && a.left < b.right;

    let left: number;
    let top = a.top;
    if (a.right + GAP + w <= b.right - MARGIN) left = a.right + GAP; // derecha
    else if (a.left - GAP - w >= b.left + MARGIN) left = a.left - GAP - w; // izquierda
    else {
      // debajo (o encima si no cabe)
      left = a.left;
      top = a.bottom + GAP;
      if (top + h > b.bottom - MARGIN) top = a.top - GAP - h;
    }
    left = clamp(left, b.left + MARGIN, b.right - w - MARGIN);
    top = clamp(top, b.top + MARGIN, b.bottom - h - MARGIN);
    // Se ejecuta en cada render (el zoom mueve la anotación); solo actualiza si cambia algo.
    setPos((p) =>
      Math.abs(p.left - left) < 0.5 && Math.abs(p.top - top) < 0.5 && p.hidden === !visible
        ? p
        : { left, top, hidden: !visible },
    );
  });

  const colors = paletteFor(annot.kind);

  return createPortal(
    <div
      ref={ref}
      className="comment-card"
      style={{ left: pos.left, top: pos.top, visibility: pos.hidden ? "hidden" : "visible" }}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div className="comment-head">
        <div className="comment-title">
          <span>{KIND_LABEL[annot.kind]}</span>
          <small>
            {[annot.author, formatPdfDate(annot.date)].filter(Boolean).join(" · ")}
          </small>
        </div>
        <span className="spacer" />
        <button className="mini-btn" title="Eliminar (Supr)" onClick={onDelete}>
          <Trash2 size={15} />
        </button>
        <button className="mini-btn" title="Cerrar (Esc)" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      <div className="card-swatches">
        {colors.map((c) => (
          <button
            key={c}
            className={`swatch small${annot.color.toLowerCase() === c ? " active" : ""}`}
            style={{ background: c }}
            aria-label={`Color ${c}`}
            onClick={() => {
              if (annot.color === c) return;
              onBegin();
              onChange({ color: c });
            }}
          />
        ))}
      </div>
      {quote && <blockquote>{quote}</blockquote>}
      {commentable && (
        <textarea
          autoFocus={autoFocus}
          placeholder="Añade un comentario…"
          value={annot.contents ?? ""}
          onFocus={onBegin}
          onChange={(e) => onChange({ contents: e.target.value })}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") onClose();
          }}
        />
      )}
    </div>,
    document.body,
  );
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(v, Math.max(min, max)));
