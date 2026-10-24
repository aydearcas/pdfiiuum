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
import {
  ERASER_BUTTONS,
  GROUP_GAP,
  GROUP_MS,
  distToInk,
  finishStroke,
  lastInk,
  markPenSeen,
  penSeen,
  smoothPathD,
  strokeAt,
} from "../lib/ink";
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
  const draftRef = useRef<SVGPathElement>(null);
  const cursorRef = useRef<SVGCircleElement>(null);
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

  // Los listeners de dibujo viven fuera de React: ven siempre las props más recientes.
  const latest = useRef(p);
  latest.current = p;
  useInk(rootRef, draftRef, cursorRef, latest);

  const onPointerDown = (e: RPointerEvent) => {
    // Fuera de las herramientas de creación la capa no recibe clics (pointer-events: none).
    // El dibujo lo atiende useInk antes de que el evento llegue aquí.
    if (e.button !== 0 || !creating || p.tool === "ink") return;
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
    }
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
                <path d={smoothPathD(s.map(toView))} className="ink" stroke={a.color} strokeWidth={a.width * scale} />
                <path
                  d={smoothPathD(s.map(toView))}
                  className="ink-hit"
                  strokeWidth={Math.max(12, a.width * scale + 8)}
                  onPointerDown={(e) => startDrag(e, a)}
                />
              </g>
            ));
          return null;
        })}
        {/* Trazo en curso y cursor del lápiz: useInk los actualiza directamente. */}
        <path ref={draftRef} className="ink" />
        <circle ref={cursorRef} className="pen-cursor" />
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

const xywh = (b: Box) => ({ x: b.left, y: b.top, width: b.width, height: b.height });
const pad = (b: Box, n: number): Box => ({
  left: b.left - n,
  top: b.top - n,
  width: b.width + 2 * n,
  height: b.height + 2 * n,
});

/** Radio de la goma en pantalla (px). */
const ERASER_PX = 7;

/**
 * Dibujo a mano alzada sobre una página, con ratón, dedo o lápiz.
 * El lápiz dibuja con cualquier herramienta (si `penDraws`), borra con la goma o el botón
 * lateral y, mientras está cerca de la pantalla, impide que el dedo o la palma desplacen.
 * Escucha en el div de la página (fase de captura) para recibir el lápiz aunque la capa
 * no reciba clics con las herramientas de selección.
 */
function useInk(
  rootRef: React.RefObject<HTMLDivElement | null>,
  draftRef: React.RefObject<SVGPathElement | null>,
  cursorRef: React.RefObject<SVGCircleElement | null>,
  latest: { readonly current: Props },
) {
  useEffect(() => {
    const root = rootRef.current!;
    const page = root.closest<HTMLElement>(".page");
    if (!page) return;
    const draft = draftRef.current!;
    const cursor = cursorRef.current!;

    let stroke: { pointer: number; erase: boolean; pts: Point[]; start: number } | null = null;
    // Trazos que la goma ya ha quitado en este gesto (las props aún no se han actualizado).
    let erased = new Map<string, Point[][] | null>();
    let frame = 0;

    const toPdf = (e: { clientX: number; clientY: number }, box: DOMRect): Point =>
      latest.current.viewport.convertToPdfPoint(e.clientX - box.left, e.clientY - box.top) as Point;
    const toView = ([x, y]: Point) => latest.current.viewport.convertToViewportPoint(x, y) as Point;
    const penDraws = () => latest.current.style.penDraws || latest.current.tool === "ink";

    const modeFor = (e: PointerEvent): "draw" | "erase" | null => {
      const q = latest.current;
      const target = e.target as Element;
      if (target.closest(".text-editor")) return null;
      if (e.pointerType === "pen") {
        markPenSeen();
        if (e.buttons & 32) return "erase";
        if (!penDraws()) return null;
        if (e.buttons & ERASER_BUTTONS) return "erase";
        // Un toque con el lápiz sobre una anotación la selecciona, como con el ratón.
        if (q.tool === "select" && target.closest("[data-annot-id]")) return null;
        return e.button === 0 ? "draw" : null;
      }
      if (q.tool !== "ink" || e.button !== 0) return null;
      if (e.pointerType === "touch" && penSeen()) return null;
      return "draw";
    };

    const showCursor = (e: PointerEvent, erase: boolean) => {
      const box = root.getBoundingClientRect();
      const s = latest.current.style;
      const r = erase ? ERASER_PX : Math.max(1.5, (s.inkWidth * latest.current.viewport.scale) / 2);
      cursor.setAttribute("cx", String(e.clientX - box.left));
      cursor.setAttribute("cy", String(e.clientY - box.top));
      cursor.setAttribute("r", String(r));
      cursor.style.fill = erase ? "none" : s.colors.ink;
      cursor.classList.toggle("erase", erase);
      cursor.style.display = "block";
      page.classList.add("no-cursor");
    };
    const hideCursor = () => {
      cursor.style.display = "none";
      page.classList.remove("no-cursor");
    };

    const render = () => {
      frame = 0;
      if (stroke && !stroke.erase) draft.setAttribute("d", smoothPathD(stroke.pts.map(toView)));
    };

    const eraseAt = (pt: Point) => {
      const q = latest.current;
      const tol = ERASER_PX / q.viewport.scale;
      for (const a of [...q.annots].reverse()) {
        if (a.kind !== "ink") continue;
        const strokes = erased.has(a.id) ? erased.get(a.id) : a.strokes;
        if (!strokes) continue;
        const i = strokeAt({ ...a, strokes }, pt, tol);
        if (i < 0) continue;
        const rest = strokes.filter((_, j) => j !== i);
        erased.set(a.id, rest.length ? rest : null);
        if (rest.length) {
          q.onBegin();
          q.onChange(a.id, { strokes: rest });
        } else q.onDelete(a.id);
        return;
      }
    };

    const onDown = (e: PointerEvent) => {
      const mode = modeFor(e);
      if (!mode) return;
      e.preventDefault();
      e.stopPropagation();
      const active = document.activeElement as HTMLElement | null;
      if (active?.classList.contains("text-editor")) active.blur();
      try {
        page.setPointerCapture(e.pointerId);
      } catch {
        /* el puntero ya no está activo: se dibuja igual mientras siga sobre la página */
      }
      const pt = toPdf(e, root.getBoundingClientRect());
      stroke = { pointer: e.pointerId, erase: mode === "erase", pts: [pt], start: Date.now() };
      if (mode === "erase") {
        erased = new Map();
        eraseAt(pt);
      } else {
        const s = latest.current.style;
        draft.style.stroke = s.colors.ink;
        draft.style.strokeWidth = String(s.inkWidth * latest.current.viewport.scale);
        render();
      }
      if (e.pointerType === "pen") showCursor(e, mode === "erase");
      else hideCursor();
    };

    const onMove = (e: PointerEvent) => {
      if (e.pointerType === "pen") {
        markPenSeen();
        page.classList.add("pen-near");
      } else if (e.pointerType === "mouse") page.classList.remove("pen-near");
      if (stroke && e.pointerId === stroke.pointer) {
        const box = root.getBoundingClientRect();
        const scale = latest.current.viewport.scale;
        // El lápiz manda más muestras de las que llegan por fotograma: se usan todas.
        const samples = e.getCoalescedEvents?.() ?? [];
        for (const ev of samples.length ? samples : [e]) {
          const pt = toPdf(ev, box);
          if (stroke.erase) eraseAt(pt);
          else {
            const last = stroke.pts[stroke.pts.length - 1];
            if (Math.hypot(pt[0] - last[0], pt[1] - last[1]) * scale >= 0.75) stroke.pts.push(pt);
          }
        }
        if (!frame) frame = requestAnimationFrame(render);
        if (e.pointerType === "pen") showCursor(e, stroke.erase);
        return;
      }
      // Lápiz cerca de la pantalla sin tocarla: vista previa del trazo o de la goma.
      if (e.pointerType === "pen" && e.buttons & 32) showCursor(e, true);
      else if (e.pointerType === "pen" && !e.buttons && penDraws()) showCursor(e, false);
      else hideCursor();
    };

    const onUp = (e: PointerEvent) => {
      if (!stroke || e.pointerId !== stroke.pointer) return;
      const done = stroke;
      stroke = null;
      cancelAnimationFrame(frame);
      frame = 0;
      draft.removeAttribute("d");
      if (e.pointerType !== "pen") hideCursor();
      if (done.erase) return;
      const q = latest.current;
      // Un toque sin moverse solo deja un punto con el lápiz (los puntos de la i).
      if (done.pts.length < 2 && e.pointerType !== "pen") return;
      const pts = finishStroke(done.pts, 0.35 / q.viewport.scale);
      // Trazos seguidos y cercanos van a la misma anotación: una palabra se mueve o borra entera.
      const prev =
        lastInk.page === q.page && done.start - lastInk.at < GROUP_MS
          ? q.annots.find((a) => a.id === lastInk.id)
          : undefined;
      lastInk.page = q.page;
      lastInk.at = Date.now();
      if (
        prev?.kind === "ink" &&
        prev.color === q.style.colors.ink &&
        prev.width === q.style.inkWidth &&
        distToInk(prev, pts[0]) < GROUP_GAP
      ) {
        q.onBegin();
        q.onChange(prev.id, { strokes: [...prev.strokes, pts] });
        return;
      }
      lastInk.id = newId();
      q.onCreate({
        id: lastInk.id,
        kind: "ink",
        page: q.page,
        color: q.style.colors.ink,
        width: q.style.inkWidth,
        strokes: [pts],
        date: pdfDate(),
      });
    };

    const onLeave = (e: PointerEvent) => {
      if (e.pointerType !== "pen" || stroke) return;
      page.classList.remove("pen-near");
      hideCursor();
    };
    // Mientras se dibuja no se selecciona el texto de debajo.
    const onSelectStart = (e: Event) => {
      if (stroke) e.preventDefault();
    };

    page.addEventListener("pointerdown", onDown, true);
    page.addEventListener("pointermove", onMove);
    page.addEventListener("pointerup", onUp);
    page.addEventListener("pointercancel", onUp);
    page.addEventListener("pointerleave", onLeave);
    document.addEventListener("selectstart", onSelectStart);
    return () => {
      cancelAnimationFrame(frame);
      page.removeEventListener("pointerdown", onDown, true);
      page.removeEventListener("pointermove", onMove);
      page.removeEventListener("pointerup", onUp);
      page.removeEventListener("pointercancel", onUp);
      page.removeEventListener("pointerleave", onLeave);
      document.removeEventListener("selectstart", onSelectStart);
      page.classList.remove("pen-near", "no-cursor");
    };
  }, [rootRef, draftRef, cursorRef, latest]);
}
