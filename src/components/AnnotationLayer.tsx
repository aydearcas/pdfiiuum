import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { MessageSquareText } from "lucide-react";
import type { PageViewport } from "pdfjs-dist";
import AnnotCard from "./AnnotCard";
import {
  NOTE_SIZE,
  TEXT_FONT,
  TEXT_LINE_HEIGHT,
  bounds,
  measureText,
  newId,
  normalize,
  pdfDate,
  type Annot,
  type Point,
  type Rect,
  type TextAnnot,
} from "../lib/annotations";
import type { Tool, ToolStyle } from "../lib/tools";

export interface LayerCallbacks {
  onCreate(a: Annot): void;
  onSelect(id: string | null): void;
  /** Marca el inicio de un cambio (para deshacer). */
  onBegin(): void;
  onChange(id: string, patch: Partial<Annot>): void;
  onDelete(id: string): void;
  onEdit(id: string | null): void;
}

interface Props extends LayerCallbacks {
  page: number;
  viewport: PageViewport;
  annots: Annot[];
  selectedId: string | null;
  editingId: string | null;
  tool: Tool;
  style: ToolStyle;
}

type Box = { left: number; top: number; width: number; height: number };

export default function AnnotationLayer(p: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [draftInk, setDraftInk] = useState<Point[] | null>(null);
  const [draftText, setDraftText] = useState<Point | null>(null);
  const vp = p.viewport;
  const scale = vp.scale;

  const toView = ([x, y]: Point): Point => vp.convertToViewportPoint(x, y) as Point;
  const toBox = (r: Rect): Box => {
    const [a, b] = [toView([r[0], r[1]]), toView([r[2], r[3]])];
    return {
      left: Math.min(a[0], b[0]),
      top: Math.min(a[1], b[1]),
      width: Math.abs(a[0] - b[0]),
      height: Math.abs(a[1] - b[1]),
    };
  };
  const toPdf = (e: { clientX: number; clientY: number }): Point => {
    const box = rootRef.current!.getBoundingClientRect();
    return vp.convertToPdfPoint(e.clientX - box.left, e.clientY - box.top) as Point;
  };

  const creating = p.tool === "note" || p.tool === "text" || p.tool === "ink";

  const onPointerDown = (e: RPointerEvent) => {
    // Fuera de las herramientas de creación la capa no recibe clics (pointer-events: none).
    if (e.button !== 0 || !creating) return;
    e.preventDefault();
    e.stopPropagation();
    // Con un texto a medio escribir, el clic fuera solo lo confirma (preventDefault evita el blur).
    if (draftText || document.activeElement?.classList.contains("text-editor")) {
      (document.activeElement as HTMLElement | null)?.blur();
      return;
    }
    const pt = toPdf(e);
    if (p.tool === "note") {
      const h = NOTE_SIZE / 2;
      p.onCreate({
        id: newId(),
        kind: "note",
        page: p.page,
        color: p.style.colors.note,
        point: [pt[0] - h, pt[1] + h],
        contents: "",
        date: pdfDate(),
      });
    } else if (p.tool === "text") {
      setDraftText([pt[0], pt[1] + (p.style.fontSize * TEXT_LINE_HEIGHT) / 2]);
    } else if (p.tool === "ink") {
      (e.target as Element).setPointerCapture(e.pointerId);
      setDraftInk([pt]);
    }
  };

  const onPointerMove = (e: RPointerEvent) => {
    if (!draftInk) return;
    const pt = toPdf(e);
    const last = draftInk[draftInk.length - 1];
    if (Math.hypot(pt[0] - last[0], pt[1] - last[1]) * scale < 1.5) return;
    setDraftInk([...draftInk, pt]);
  };

  const onPointerUp = () => {
    if (!draftInk) return;
    if (draftInk.length > 1) {
      p.onCreate({
        id: newId(),
        kind: "ink",
        page: p.page,
        color: p.style.colors.ink,
        width: p.style.inkWidth,
        strokes: [draftInk.map(([x, y]) => [round(x), round(y)])],
        date: pdfDate(),
      });
    }
    setDraftInk(null);
  };

  const commitDraftText = (text: string) => {
    if (draftText && text.trim()) {
      p.onCreate({
        id: newId(),
        kind: "text",
        page: p.page,
        color: p.style.colors.text,
        fontSize: p.style.fontSize,
        text,
        rect: measureText(text, p.style.fontSize, draftText),
        date: pdfDate(),
      });
    }
    setDraftText(null);
  };

  const selected = p.annots.find((a) => a.id === p.selectedId) ?? null;

  return (
    <div
      ref={rootRef}
      className={`annot-layer${creating ? " creating" : ""} tool-${p.tool}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <svg className="annot-svg" width={vp.width} height={vp.height}>
        {p.annots.map((a) => {
          if (a.kind === "highlight")
            return a.rects.map((r, i) => {
              const b = toBox(r);
              return <rect key={a.id + i} className="hl" {...xywh(b)} fill={a.color} />;
            });
          if (a.kind === "underline" || a.kind === "strikeout")
            return a.rects.map((r, i) => {
              const [x1, y1, x2, y2] = normalize(r);
              const h = y2 - y1;
              const y = a.kind === "underline" ? y1 + h * 0.08 : y1 + h * 0.45;
              const [s, t] = [toView([x1, y]), toView([x2, y])];
              return (
                <line
                  key={a.id + i}
                  x1={s[0]}
                  y1={s[1]}
                  x2={t[0]}
                  y2={t[1]}
                  stroke={a.color}
                  strokeWidth={Math.max(1, h / 14) * scale}
                />
              );
            });
          if (a.kind === "ink")
            return a.strokes.map((s, i) => (
              <g key={a.id + i} data-annot-id={a.id}>
                <path d={pathD(s.map(toView))} className="ink" stroke={a.color} strokeWidth={a.width * scale} />
                <path
                  d={pathD(s.map(toView))}
                  className="ink-hit"
                  strokeWidth={Math.max(12, a.width * scale + 8)}
                  onPointerDown={(e) => startDrag(e, a)}
                />
              </g>
            ));
          return null;
        })}
        {draftInk && (
          <path
            d={pathD(draftInk.map(toView))}
            className="ink"
            stroke={p.style.colors.ink}
            strokeWidth={p.style.inkWidth * scale}
          />
        )}
        {selected && <rect className="sel-outline" {...xywh(pad(toBox(bounds(selected)), 3))} />}
      </svg>

      {p.annots.map((a) => {
        if (a.kind === "note") {
          const [x, y] = toView(a.point);
          const size = NOTE_SIZE * scale;
          return (
            <button
              key={a.id}
              data-annot-id={a.id}
              className={`note-icon${a.id === p.selectedId ? " selected" : ""}`}
              style={{ left: x, top: y, width: size, height: size, background: a.color }}
              onPointerDown={(e) => startDrag(e, a)}
              title={a.contents || "Nota"}
            >
              <MessageSquareText size={size * 0.65} strokeWidth={2} />
            </button>
          );
        }
        if (a.kind === "text") {
          const b = toBox(a.rect);
          const style = textStyle(a, scale);
          if (a.id === p.editingId)
            return (
              <TextEditor
                key={a.id}
                box={b}
                style={style}
                initial={a.text}
                onDone={(text) => {
                  p.onEdit(null);
                  if (text === null || text === a.text) return;
                  if (!text.trim()) return p.onDelete(a.id);
                  p.onBegin();
                  p.onChange(a.id, { text, rect: measureText(text, a.fontSize, [a.rect[0], a.rect[3]]) });
                }}
              />
            );
          return (
            <div
              key={a.id}
              data-annot-id={a.id}
              className={`text-annot${a.id === p.selectedId ? " selected" : ""}`}
              style={{ left: b.left, top: b.top, minWidth: b.width, ...style }}
              onPointerDown={(e) => startDrag(e, a)}
              onDoubleClick={() => p.onEdit(a.id)}
            >
              {a.text}
            </div>
          );
        }
        return null;
      })}

      {draftText && (
        <TextEditor
          key={draftText.join()}
          box={{ left: toView(draftText)[0], top: toView(draftText)[1], width: 0, height: 0 }}
          style={{
            fontSize: p.style.fontSize * scale,
            color: p.style.colors.text,
            fontFamily: TEXT_FONT,
            lineHeight: TEXT_LINE_HEIGHT,
          }}
          initial=""
          onDone={(t) => commitDraftText(t ?? "")}
        />
      )}

      {selected && !(selected.kind === "text" && selected.id === p.editingId) && (
        <AnnotCard
          annot={selected}
          getAnchor={() => {
            const r = rootRef.current!.getBoundingClientRect();
            const b = toBox(bounds(selected));
            return new DOMRect(r.left + b.left, r.top + b.top, b.width, b.height);
          }}
          getBounds={() =>
            (rootRef.current!.closest(".viewer-container") ?? document.body).getBoundingClientRect()
          }
          autoFocus={selected.id === p.editingId}
          onBegin={p.onBegin}
          onChange={(patch) => p.onChange(selected.id, patch)}
          onDelete={() => p.onDelete(selected.id)}
          onClose={() => {
            p.onEdit(null);
            p.onSelect(null);
          }}
        />
      )}
    </div>
  );

  /** Selecciona y permite arrastrar notas, textos y dibujos con la herramienta de selección. */
  function startDrag(e: RPointerEvent, a: Annot) {
    if (p.tool !== "select" || e.button !== 0) return;
    e.stopPropagation();
    p.onSelect(a.id);
    const start = toPdf(e);
    const target = e.currentTarget as Element;
    target.setPointerCapture(e.pointerId);
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      const pt = toPdf(ev);
      const dx = pt[0] - start[0];
      const dy = pt[1] - start[1];
      if (!moved && Math.hypot(dx, dy) * scale < 3) return;
      if (!moved) p.onBegin();
      moved = true;
      p.onChange(a.id, translate(a, dx, dy));
    };
    const onUp = () => {
      target.removeEventListener("pointermove", onMove as EventListener);
      target.removeEventListener("pointerup", onUp);
    };
    target.addEventListener("pointermove", onMove as EventListener);
    target.addEventListener("pointerup", onUp);
  }
}

function translate(a: Annot, dx: number, dy: number): Partial<Annot> {
  switch (a.kind) {
    case "note":
      return { point: [a.point[0] + dx, a.point[1] + dy] };
    case "text":
      return { rect: [a.rect[0] + dx, a.rect[1] + dy, a.rect[2] + dx, a.rect[3] + dy] };
    case "ink":
      return { strokes: a.strokes.map((s) => s.map(([x, y]) => [x + dx, y + dy] as Point)) };
    default:
      return {};
  }
}

function TextEditor({
  box,
  style,
  initial,
  onDone,
}: {
  box: Box;
  style: React.CSSProperties;
  initial: string;
  onDone(text: string | null): void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  const [value, setValue] = useState(initial);
  useEffect(() => {
    const t = ref.current!;
    t.focus();
    t.setSelectionRange(t.value.length, t.value.length);
  }, []);
  const finish = (text: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(text);
  };
  const lines = value.split("\n");
  return (
    <textarea
      ref={ref}
      className="text-editor"
      value={value}
      placeholder="Escribe…"
      spellCheck={false}
      style={{
        left: box.left,
        top: box.top,
        ...style,
        width: `calc(${Math.max(4, ...lines.map((l) => l.length + 1))}ch + 12px)`,
        height: `calc(${lines.length * TEXT_LINE_HEIGHT}em + 6px)`,
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        // Esc o Ctrl+Enter terminan la edición conservando lo escrito.
        if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) finish(value);
      }}
    />
  );
}

function textStyle(a: TextAnnot, scale: number): React.CSSProperties {
  return {
    fontSize: a.fontSize * scale,
    color: a.color,
    fontFamily: TEXT_FONT,
    lineHeight: TEXT_LINE_HEIGHT,
  };
}

const round = (n: number) => Math.round(n * 100) / 100;
const xywh = (b: Box) => ({ x: b.left, y: b.top, width: b.width, height: b.height });
const pad = (b: Box, n: number): Box => ({
  left: b.left - n,
  top: b.top - n,
  width: b.width + 2 * n,
  height: b.height + 2 * n,
});
const pathD = (pts: Point[]) =>
  pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
