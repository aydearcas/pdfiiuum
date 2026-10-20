import { useLayoutEffect, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { createPortal } from "react-dom";
import { FileText, Plus, X } from "lucide-react";

export interface TabItem {
  id: string;
  name: string;
  dirty: boolean;
  /** Se está cerrando (se encoge antes de desaparecer). */
  closing?: boolean;
}

interface Props {
  tabs: TabItem[];
  activeId: string | null;
  canTearOff: boolean;
  onActivate(id: string): void;
  onClose(id: string): void;
  onNew(): void;
  onMove(id: string, toIndex: number): void;
  /** Pestaña soltada fuera de la barra: a otra ventana o a una nueva. */
  onTearOff(id: string): void;
}

/** Distancia vertical (px) fuera de la barra a partir de la cual la pestaña se separa. */
const TEAR_DISTANCE = 50;
const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const SETTLE_MS = 200;

interface Drag {
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  /** Distancia del puntero al borde izquierdo de la pestaña al cogerla. */
  grabX: number;
  from: number;
  to: number;
  width: number;
  moved: boolean;
  detached: boolean;
}

export default function TabBar({ tabs, activeId, canTearOff, onActivate, onClose, onNew, onMove, onTearOff }: Props) {
  const stripRef = useRef<HTMLDivElement>(null);
  const els = useRef(new Map<string, HTMLDivElement>());
  const drag = useRef<Drag | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [detached, setDetached] = useState(false);
  const [ghost, setGhost] = useState<{ x: number; y: number; name: string; preview: string | null } | null>(null);

  // FLIP: posiciones visuales justo antes de reordenar, para animar desde ahí.
  const before = useRef<Map<string, number> | null>(null);
  const knownIds = useRef<Set<string> | null>(null);

  useLayoutEffect(() => {
    const first = before.current;
    before.current = null;
    for (const t of tabs) {
      const el = els.current.get(t.id);
      if (!el) continue;
      // Pestaña nueva: crece desde cero (no en la primera carga).
      if (knownIds.current && !knownIds.current.has(t.id)) {
        el.animate(
          [
            { maxWidth: "0px", opacity: 0, transform: "translateY(6px)" },
            { maxWidth: "220px", opacity: 1, transform: "none" },
          ],
          { duration: 220, easing: EASE },
        );
      }
      // Pestaña que ha cambiado de sitio: se desliza desde donde se veía.
      const old = first?.get(t.id);
      if (old !== undefined) {
        const now = el.getBoundingClientRect().left;
        if (Math.abs(old - now) > 0.5) {
          el.style.transition = "none";
          el.style.transform = `translateX(${old - now}px)`;
          el.getBoundingClientRect();
          el.style.transition = `transform ${SETTLE_MS}ms ${EASE}`;
          el.style.transform = "";
        }
      }
    }
    knownIds.current = new Set(tabs.map((t) => t.id));
  }, [tabs]);

  const order = () => tabs.filter((t) => !t.closing);

  const onPointerDown = (e: RPointerEvent, id: string) => {
    if ((e.target as HTMLElement).closest(".tab-close")) return;
    if (e.button === 1) {
      e.preventDefault();
      onClose(id);
      return;
    }
    if (e.button !== 0) return;
    onActivate(id);
    const el = els.current.get(id)!;
    const rect = el.getBoundingClientRect();
    drag.current = {
      id,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      grabX: e.clientX - rect.left,
      from: order().findIndex((t) => t.id === id),
      to: -1,
      width: rect.width,
      moved: false,
      detached: false,
    };
    el.setPointerCapture(e.pointerId);
  };

  const isOutside = (e: RPointerEvent) => {
    const r = stripRef.current!.getBoundingClientRect();
    return (
      e.clientY < r.top - TEAR_DISTANCE ||
      e.clientY > r.bottom + TEAR_DISTANCE ||
      e.clientX < 0 ||
      e.clientX > window.innerWidth
    );
  };

  /** Coloca la pestaña arrastrada bajo el puntero y aparta a las demás. */
  const layoutDrag = (d: Drag, clientX: number) => {
    const list = order();
    const strip = stripRef.current!.getBoundingClientRect();
    const draggedEl = els.current.get(d.id)!;
    const home = draggedEl.offsetLeft;
    const maxLeft = Math.max(0, (els.current.get(list[list.length - 1].id)?.offsetLeft ?? 0));
    const left = Math.min(Math.max(clientX - strip.left - d.grabX, 0), maxLeft);
    draggedEl.style.transition = "none";
    draggedEl.style.transform = `translateX(${left - home}px)`;

    // Hueco de destino: el que contiene el centro de la pestaña arrastrada.
    const center = left + d.width / 2;
    let to = d.from;
    list.forEach((t, i) => {
      if (t.id === d.id) return;
      const el = els.current.get(t.id)!;
      const mid = el.offsetLeft + el.offsetWidth / 2;
      if (i > d.from && center > mid) to = Math.max(to, i);
      if (i < d.from && center < mid) to = Math.min(to, i);
    });
    d.to = to;
    const shift = d.width + 2;
    list.forEach((t, i) => {
      if (t.id === d.id) return;
      const el = els.current.get(t.id)!;
      let dx = 0;
      if (d.from < to && i > d.from && i <= to) dx = -shift;
      if (d.from > to && i >= to && i < d.from) dx = shift;
      el.style.transition = `transform ${SETTLE_MS}ms ${EASE}`;
      el.style.transform = dx ? `translateX(${dx}px)` : "";
    });
  };

  const resetShifts = (except?: string) => {
    for (const [id, el] of els.current) {
      if (id === except) continue;
      el.style.transition = `transform ${SETTLE_MS}ms ${EASE}`;
      el.style.transform = "";
    }
  };

  const onPointerMove = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 5) return;
    if (!d.moved) {
      d.moved = true;
      setDragId(d.id);
    }

    const out = canTearOff && isOutside(e);
    if (out !== d.detached) {
      d.detached = out;
      setDetached(out);
      if (out) {
        resetShifts();
        d.to = d.from;
      }
    }
    if (out) {
      setGhost((g) => ({
        x: e.clientX,
        y: e.clientY,
        name: tabs.find((t) => t.id === d.id)?.name ?? "",
        preview: g?.preview ?? snapshotPage(),
      }));
      return;
    }
    setGhost(null);
    layoutDrag(d, e.clientX);
  };

  const onPointerUp = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    drag.current = null;
    setDragId(null);
    setDetached(false);
    setGhost(null);
    if (!d.moved) return;

    if (d.detached) {
      resetShifts();
      onTearOff(d.id);
      return;
    }
    const list = order();
    if (d.to >= 0 && d.to !== d.from) {
      // Guardar dónde se ve cada pestaña y reordenar: el efecto FLIP hace el resto.
      before.current = new Map(list.map((t) => [t.id, els.current.get(t.id)!.getBoundingClientRect().left]));
      for (const el of els.current.values()) {
        el.style.transition = "none";
        el.style.transform = "";
      }
      onMove(d.id, d.to);
    } else {
      resetShifts();
    }
  };

  return (
    <div className="tabbar">
      <div className="tabs" ref={stripRef} role="tablist">
        {tabs.map((t) => (
          <div
            key={t.id}
            ref={(el) => {
              if (el) els.current.set(t.id, el);
              else els.current.delete(t.id);
            }}
            role="tab"
            aria-selected={t.id === activeId}
            className={[
              "tab",
              t.id === activeId && "active",
              t.id === dragId && "dragging",
              t.id === dragId && detached && "detached",
              t.closing && "closing",
            ]
              .filter(Boolean)
              .join(" ")}
            title={t.name}
            onPointerDown={(e) => onPointerDown(e, t.id)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onAuxClick={(e) => e.button === 1 && e.preventDefault()}
          >
            <FileText size={14} strokeWidth={1.75} className="tab-icon" />
            <span className="tab-name">{t.name}</span>
            {t.dirty && <span className="tab-dirty" title="Sin guardar" />}
            <button
              className="tab-close"
              aria-label={`Cerrar ${t.name}`}
              title="Cerrar (Ctrl+W)"
              onClick={(e) => {
                e.stopPropagation();
                onClose(t.id);
              }}
            >
              <X size={13} />
            </button>
          </div>
        ))}
        <button className="tab-new" aria-label="Abrir PDF" title="Abrir PDF (Ctrl+O)" onClick={onNew}>
          <Plus size={16} />
        </button>
      </div>
      {ghost &&
        createPortal(
          <div className="tab-ghost" style={{ left: ghost.x - 36, top: ghost.y - 14 }}>
            <div className="tab-ghost-bar">
              <FileText size={13} strokeWidth={1.75} />
              <span>{ghost.name}</span>
            </div>
            <div className="tab-ghost-body">
              {ghost.preview ? <img src={ghost.preview} alt="" /> : <FileText size={34} strokeWidth={1.25} />}
            </div>
            <div className="tab-ghost-hint">
              {tabs.length > 1 ? "Suelta para abrir en una ventana nueva" : "Suéltala sobre otra ventana de pdfiiuum"}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

/** Miniatura de la página visible de la pestaña activa, para la vista previa al arrastrar. */
function snapshotPage(): string | null {
  try {
    const source =
      document.querySelector<HTMLCanvasElement>(".doc-tab.active .thumb.active canvas") ??
      document.querySelector<HTMLCanvasElement>(".doc-tab.active .page canvas");
    if (!source || !source.width) return null;
    const w = 220;
    const h = Math.round((source.height / source.width) * w);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    c.getContext("2d")!.drawImage(source, 0, 0, w, h);
    return c.toDataURL("image/png");
  } catch {
    return null;
  }
}
