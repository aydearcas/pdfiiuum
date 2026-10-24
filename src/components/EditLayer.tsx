import { useEffect, useRef, useState } from "react";
import type { PageViewport } from "pdfjs-dist";
import { caretAt, cssFont, textWidth, type TextRun } from "../lib/edit";
import type { Point } from "../lib/annotations";

interface Props {
  page: number;
  viewport: PageViewport;
  getRuns(page: number): Promise<TextRun[]>;
  /** Aplica la corrección; resuelve a false si no se pudo. */
  onEdit(page: number, run: TextRun, text: string): Promise<boolean>;
}

type Box = { left: number; top: number; width: number; height: number };

/** Modo «Corregir texto»: marca los tramos de texto de la página y permite reescribirlos. */
export default function EditLayer(p: Props) {
  const [runs, setRuns] = useState<TextRun[] | null>(null);
  const [editing, setEditing] = useState<{ index: number; caret: number } | null>(null);
  const vp = p.viewport;
  const scale = vp.scale;

  useEffect(() => {
    let cancelled = false;
    setRuns(null);
    setEditing(null);
    p.getRuns(p.page)
      .catch(() => [])
      .then((r) => !cancelled && setRuns(r));
    return () => {
      cancelled = true;
    };
  }, [p.getRuns, p.page]);

  const toBox = ([x1, y1, x2, y2]: TextRun["rect"]): Box => {
    const a = vp.convertToViewportPoint(x1, y1) as Point;
    const b = vp.convertToViewportPoint(x2, y2) as Point;
    return {
      left: Math.min(a[0], b[0]),
      top: Math.min(a[1], b[1]),
      width: Math.abs(a[0] - b[0]),
      height: Math.abs(a[1] - b[1]),
    };
  };

  return (
    <div className={`edit-layer${runs ? "" : " loading"}`}>
      {runs?.map((run, i) => {
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
                if (!(await p.onEdit(p.page, run, text))) setEditing(null);
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
    </div>
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
  const px = run.size * scale;
  const font = cssFont(run, px);

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
