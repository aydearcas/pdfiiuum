import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { Trash2 } from "lucide-react";
import type { PageViewport } from "pdfjs-dist";
import { EDIT_FONTS, caretAt, cssFont, textWidth, type PageContent, type PageEdit, type TextRun } from "../lib/edit";
import { TEXT_LINE_HEIGHT, hexToRgb, normalize, type Point, type Rect } from "../lib/annotations";
import type { EditTool, ToolStyle } from "../lib/tools";

interface Props {
  page: number;
  viewport: PageViewport;
  tool: Exclude<EditTool, "pages">;
  style: ToolStyle;
  getContent(page: number): Promise<PageContent>;
  /** Aplica el cambio; resuelve a false si no se pudo. */
  onEdit(page: number, edit: PageEdit): Promise<boolean>;
}

type Box = { left: number; top: number; width: number; height: number };

/**
 * Modo edición sobre una página: corregir texto, añadir texto, mover/redimensionar/borrar
 * imágenes y tapar zonas. Los cambios se aplican al PDF con PDFium (Rust) y la página se
 * vuelve a mostrar desde el PDF resultante.
 */
export default function EditLayer(p: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [content, setContent] = useState<PageContent | null>(null);
  const vp = p.viewport;
  const scale = vp.scale;

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    p.getContent(p.page)
      .catch(() => ({ runs: [], images: [] }))
      .then((c) => !cancelled && setContent(c));
    return () => {
      cancelled = true;
    };
  }, [p.getContent, p.page]);

  const toBox = (r: Rect): Box => {
    const a = vp.convertToViewportPoint(r[0], r[1]) as Point;
    const b = vp.convertToViewportPoint(r[2], r[3]) as Point;
    return {
      left: Math.min(a[0], b[0]),
      top: Math.min(a[1], b[1]),
      width: Math.abs(a[0] - b[0]),
      height: Math.abs(a[1] - b[1]),
    };
  };
  const toPdf = (x: number, y: number) => vp.convertToPdfPoint(x, y) as Point;
  const boxToRect = (b: Box): Rect => {
    const [x1, y1] = toPdf(b.left, b.top + b.height);
    const [x2, y2] = toPdf(b.left + b.width, b.top);
    return normalize([x1, y1, x2, y2]);
  };
  /** Punto del puntero relativo a la página, en px. */
  const local = (e: { clientX: number; clientY: number }): Point => {
    const r = rootRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const edit = (change: PageEdit) => p.onEdit(p.page, change);

  return (
    <div ref={rootRef} className={`edit-layer edit-${p.tool}${content ? "" : " loading"}`}>
      {content && p.tool === "edittext" && <TextRuns runs={content.runs} toBox={toBox} scale={scale} edit={edit} />}
      {content && p.tool === "objects" && <Images images={content.images} toBox={toBox} boxToRect={boxToRect} local={local} edit={edit} />}
      {p.tool === "addtext" && <AddText style={p.style} scale={scale} local={local} toPdf={toPdf} edit={edit} />}
      {p.tool === "cover" && <Cover local={local} boxToRect={boxToRect} edit={edit} />}
    </div>
  );
}

type Edit = (change: PageEdit) => Promise<boolean>;

/* ---------- Corregir texto ---------- */

function TextRuns({ runs, toBox, scale, edit }: { runs: TextRun[]; toBox(r: Rect): Box; scale: number; edit: Edit }) {
  const [editing, setEditing] = useState<{ index: number; caret: number } | null>(null);
  return (
    <>
      {runs.map((run, i) => {
        const box = toBox(run.rect);
        if (editing?.index === i)
          return (
            <RunEditor
              key={i}
              run={run}
              box={box}
              scale={scale}
              caret={editing.caret}
              onDone={async (text) => {
                if (text === null || text === run.text) return setEditing(null);
                if (!(await edit({ op: "text", objects: run.objects, text }))) setEditing(null);
              }}
            />
          );
        return (
          <div
            key={i}
            className="edit-run"
            style={{ left: box.left - 2, top: box.top - 2, width: box.width + 4, height: box.height + 4 }}
            title="Clic para corregir este texto"
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              const font = cssFont(run, run.size * scale);
              const x = e.clientX - e.currentTarget.getBoundingClientRect().left - 2;
              setEditing({ index: i, caret: caretAt(run.text, font, x) });
            }}
          />
        );
      })}
    </>
  );
}

function RunEditor({
  run,
  box,
  scale,
  caret,
  onDone,
}: {
  run: TextRun;
  box: Box;
  scale: number;
  caret: number;
  onDone(text: string | null): void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const [value, setValue] = useState(run.text);
  const [applying, setApplying] = useState(false);
  const font = cssFont(run, run.size * scale);

  useEffect(() => {
    const input = ref.current!;
    input.focus();
    input.setSelectionRange(caret, caret);
  }, [caret]);

  const finish = (text: string | null) => {
    if (done.current) return;
    done.current = true;
    if (text !== null && text !== run.text) setApplying(true);
    onDone(text);
  };

  const [r, g, b] = run.color;
  return (
    <input
      ref={ref}
      className={`run-editor${applying ? " applying" : ""}`}
      value={value}
      readOnly={applying}
      spellCheck={false}
      style={{
        left: box.left - 3,
        top: box.top - 3,
        height: box.height + 6,
        width: Math.max(box.width, textWidth(value, font)) + 10,
        font,
        color: `rgb(${r}, ${g}, ${b})`,
      }}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(value)}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(value);
        else if (e.key === "Escape") finish(null);
      }}
    />
  );
}

/* ---------- Añadir texto ---------- */

function AddText({
  style,
  scale,
  local,
  toPdf,
  edit,
}: {
  style: ToolStyle;
  scale: number;
  local(e: { clientX: number; clientY: number }): Point;
  toPdf(x: number, y: number): Point;
  edit: Edit;
}) {
  const [at, setAt] = useState<Point | null>(null);
  const [value, setValue] = useState("");
  const [applying, setApplying] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  const px = style.fontSize * scale;
  const family = EDIT_FONTS.find((f) => f.font === style.editFont)!.css;

  useEffect(() => {
    if (at) ref.current?.focus();
  }, [at]);

  const finish = async (commit: boolean) => {
    if (!at || done.current) return;
    done.current = true;
    const text = value.replace(/\s+$/, "");
    if (commit && text.trim()) {
      setApplying(true);
      const [x, y] = toPdf(at[0], at[1]);
      const ok = await edit({
        op: "addText",
        x,
        y,
        text,
        size: style.fontSize,
        color: hexToRgb(style.colors.text),
        font: style.editFont,
      });
      if (ok) return;
    }
    setAt(null);
    setValue("");
    setApplying(false);
  };

  const lines = value.split("\n");
  return (
    <div
      className="edit-surface"
      onPointerDown={(e) => {
        if (e.button !== 0 || at) return;
        e.preventDefault();
        done.current = false;
        // El clic marca la esquina superior izquierda; el texto queda centrado en la línea.
        const [x, y] = local(e);
        setAt([x, y - (px * TEXT_LINE_HEIGHT) / 2]);
      }}
    >
      {at && (
        <textarea
          ref={ref}
          className={`new-text-editor${applying ? " applying" : ""}`}
          value={value}
          readOnly={applying}
          placeholder="Escribe…"
          spellCheck={false}
          style={{
            left: at[0],
            top: at[1],
            fontSize: px,
            fontFamily: family,
            lineHeight: TEXT_LINE_HEIGHT,
            color: style.colors.text,
            width: `calc(${Math.max(4, ...lines.map((l) => l.length + 1))}ch + 4px)`,
            height: `calc(${lines.length * TEXT_LINE_HEIGHT}em + 2px)`,
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => finish(true)}
          onKeyDown={(e) => {
            e.stopPropagation();
            // Intro hace salto de línea; Ctrl+Intro o Esc terminan (Esc sin añadir).
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) finish(true);
            else if (e.key === "Escape") finish(false);
          }}
        />
      )}
    </div>
  );
}

/* ---------- Imágenes: mover, cambiar tamaño y borrar ---------- */

function Images({
  images,
  toBox,
  boxToRect,
  local,
  edit,
}: {
  images: PageContent["images"];
  toBox(r: Rect): Box;
  boxToRect(b: Box): Rect;
  local(e: { clientX: number; clientY: number }): Point;
  edit: Edit;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const [preview, setPreview] = useState<{ index: number; box: Box } | null>(null);
  const [applying, setApplying] = useState(false);

  const remove = async (index: number) => {
    setApplying(true);
    if (!(await edit({ op: "delete", indices: [index] }))) setApplying(false);
  };

  // Supr borra la imagen seleccionada.
  useEffect(() => {
    if (selected === null) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest?.("input, textarea")) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        e.stopImmediatePropagation();
        remove(selected);
      } else if (e.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  /** Arrastrar la imagen (mover) o su esquina (cambiar tamaño sin deformarla). */
  const drag = (e: RPointerEvent, index: number, start: Box, resize: boolean) => {
    if (e.button !== 0 || applying) return;
    e.preventDefault();
    e.stopPropagation();
    setSelected(index);
    const target = e.currentTarget as Element;
    target.setPointerCapture(e.pointerId);
    const [sx, sy] = local(e);
    let box = start;
    const onMove = (ev: PointerEvent) => {
      const [x, y] = local(ev);
      const dx = x - sx;
      const dy = y - sy;
      if (resize) {
        const k = Math.max(10 / start.width, (start.width + Math.max(dx, (dy * start.width) / start.height)) / start.width);
        box = { ...start, width: start.width * k, height: start.height * k };
      } else box = { ...start, left: start.left + dx, top: start.top + dy };
      setPreview({ index, box });
    };
    const onUp = async () => {
      target.removeEventListener("pointermove", onMove as EventListener);
      target.removeEventListener("pointerup", onUp);
      const moved = Math.abs(box.left - start.left) + Math.abs(box.top - start.top) + Math.abs(box.width - start.width) > 1;
      if (!moved) return setPreview(null);
      setApplying(true);
      if (!(await edit({ op: "move", index, rect: boxToRect(box) }))) {
        setApplying(false);
        setPreview(null);
      }
    };
    target.addEventListener("pointermove", onMove as EventListener);
    target.addEventListener("pointerup", onUp);
  };

  return (
    <div className="edit-surface" onPointerDown={() => setSelected(null)}>
      {images.map((img) => {
        const box = preview?.index === img.index ? preview.box : toBox(img.rect);
        const isSel = selected === img.index;
        return (
          <div
            key={img.index}
            className={`edit-image${isSel ? " selected" : ""}${applying && isSel ? " applying" : ""}`}
            style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
            title="Arrastra para mover · esquina para cambiar el tamaño · Supr para borrar"
            onPointerDown={(e) => drag(e, img.index, toBox(img.rect), false)}
          >
            {isSel && (
              <>
                <span className="edit-handle" onPointerDown={(e) => drag(e, img.index, toBox(img.rect), true)} />
                <button
                  className="edit-delete"
                  title="Borrar imagen (Supr)"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => remove(img.index)}
                >
                  <Trash2 size={14} />
                </button>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ---------- Tapar zona ---------- */

function Cover({
  local,
  boxToRect,
  edit,
}: {
  local(e: { clientX: number; clientY: number }): Point;
  boxToRect(b: Box): Rect;
  edit: Edit;
}) {
  const [box, setBox] = useState<Box | null>(null);
  const [applying, setApplying] = useState(false);
  return (
    <div
      className="edit-surface"
      onPointerDown={(e) => {
        if (e.button !== 0 || applying) return;
        e.preventDefault();
        const target = e.currentTarget;
        target.setPointerCapture(e.pointerId);
        const [sx, sy] = local(e);
        let current: Box = { left: sx, top: sy, width: 0, height: 0 };
        setBox(current);
        const onMove = (ev: PointerEvent) => {
          const [x, y] = local(ev);
          current = { left: Math.min(x, sx), top: Math.min(y, sy), width: Math.abs(x - sx), height: Math.abs(y - sy) };
          setBox(current);
        };
        const onUp = async () => {
          target.removeEventListener("pointermove", onMove);
          target.removeEventListener("pointerup", onUp);
          if (current.width < 3 || current.height < 3) return setBox(null);
          setApplying(true);
          await edit({ op: "cover", rect: boxToRect(current) });
          setApplying(false);
          setBox(null);
        };
        target.addEventListener("pointermove", onMove);
        target.addEventListener("pointerup", onUp);
      }}
    >
      {box && <div className={`cover-preview${applying ? " applying" : ""}`} style={{ ...box }} />}
    </div>
  );
}
