import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { Signature as SignatureIcon, Undo2, X } from "lucide-react";
import type { Point } from "../lib/annotations";
import { finishStroke, smoothPathD } from "../lib/ink";
import { SIGNATURE_COLORS, makeSignature, type Signature } from "../lib/signature";

interface Props {
  /** Firma guardada, para empezar con su color. */
  current: Signature | null;
  onSave(s: Signature): void;
  onClose(): void;
}

/** Tamaño del recuadro en píxeles (se escala con CSS si no cabe). */
const PAD_W = 520;
const PAD_H = 200;
const LINE = 3;

/** Recuadro para dibujar la firma con el ratón, el dedo o el lápiz. */
export default function SignatureDialog({ current, onSave, onClose }: Props) {
  const [strokes, setStrokes] = useState<Point[][]>([]);
  const [color, setColor] = useState(current?.color ?? SIGNATURE_COLORS[0].color);
  const svgRef = useRef<SVGSVGElement>(null);
  const draftRef = useRef<SVGPathElement>(null);
  const live = useRef<{ pointer: number; pts: Point[] } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.stopPropagation();
        setStrokes((s) => s.slice(0, -1));
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  /** Punto en píxeles del recuadro aunque CSS lo muestre más pequeño. */
  const toPad = (e: { clientX: number; clientY: number }): Point => {
    const r = svgRef.current!.getBoundingClientRect();
    return [((e.clientX - r.left) * PAD_W) / r.width, ((e.clientY - r.top) * PAD_H) / r.height];
  };

  const onDown = (e: RPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 || live.current) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* el puntero ya no está activo: se dibuja igual mientras siga sobre el recuadro */
    }
    live.current = { pointer: e.pointerId, pts: [toPad(e)] };
    draftRef.current!.setAttribute("d", smoothPathD(live.current.pts));
  };

  const onMove = (e: RPointerEvent<SVGSVGElement>) => {
    const s = live.current;
    if (!s || e.pointerId !== s.pointer) return;
    const samples = e.nativeEvent.getCoalescedEvents?.() ?? [];
    for (const ev of samples.length ? samples : [e]) {
      const pt = toPad(ev);
      const last = s.pts[s.pts.length - 1];
      if (Math.hypot(pt[0] - last[0], pt[1] - last[1]) >= 0.75) s.pts.push(pt);
    }
    draftRef.current!.setAttribute("d", smoothPathD(s.pts));
  };

  const onUp = (e: RPointerEvent<SVGSVGElement>) => {
    const s = live.current;
    if (!s || e.pointerId !== s.pointer) return;
    live.current = null;
    draftRef.current!.removeAttribute("d");
    if (e.type === "pointercancel") return;
    const pts = finishStroke(s.pts, 0.35);
    setStrokes((all) => [...all, pts]);
  };

  const save = () => {
    const sig = makeSignature(strokes, LINE, color);
    if (sig) onSave(sig);
  };

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="dialog" role="dialog" aria-labelledby="sign-title" style={{ width: "min(580px, 100%)" }}>
        <header className="dialog-head">
          <SignatureIcon size={18} />
          <h2 id="sign-title">Tu firma</h2>
          <button className="mini-btn" title="Cerrar (Esc)" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <p className="dialog-intro">
          Firma dentro del recuadro con el ratón, el dedo o el lápiz. Se guarda en este equipo para colocarla en
          cualquier PDF.
        </p>
        <div className="sign-pad">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${PAD_W} ${PAD_H}`}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            aria-label="Recuadro para firmar"
          >
            <line className="sign-baseline" x1={30} x2={PAD_W - 30} y1={PAD_H * 0.72} y2={PAD_H * 0.72} />
            {strokes.map((s, i) => (
              <path key={i} className="ink" d={smoothPathD(s)} stroke={color} strokeWidth={LINE} />
            ))}
            <path ref={draftRef} className="ink" stroke={color} strokeWidth={LINE} />
          </svg>
          {!strokes.length && <span className="sign-hint">Firma aquí</span>}
        </div>
        <div className="sign-tools">
          <span>Color</span>
          {SIGNATURE_COLORS.map((c) => (
            <button
              key={c.color}
              className={`swatch${color === c.color ? " active" : ""}`}
              style={{ background: c.color }}
              aria-label={c.label}
              title={c.label}
              onClick={() => setColor(c.color)}
            />
          ))}
          <span className="sign-spacer" />
          <button className="btn" disabled={!strokes.length} onClick={() => setStrokes((s) => s.slice(0, -1))} title="Deshacer el último trazo (Ctrl+Z)">
            <Undo2 size={14} /> Deshacer
          </button>
          <button className="btn" disabled={!strokes.length} onClick={() => setStrokes([])}>
            Borrar
          </button>
        </div>
        <footer className="dialog-foot">
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className="btn primary" disabled={!strokes.length} onClick={save}>
            Guardar firma
          </button>
        </footer>
      </section>
    </div>
  );
}
