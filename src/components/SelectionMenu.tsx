import { useLayoutEffect, useRef, useState } from "react";
import { Copy, Highlighter, MessageSquarePlus, Strikethrough, Underline } from "lucide-react";
import { HIGHLIGHT_COLORS, type MarkupKind } from "../lib/annotations";

export interface MenuItem {
  label: string;
  icon: typeof Copy;
  action(): void;
}

interface Props {
  /** Punto o caja en pantalla junto a la que se abre el menú. */
  anchor: DOMRect;
  /** Acciones de anotación (solo con texto seleccionado). */
  markup?: {
    highlightColor: string;
    onMarkup(kind: MarkupKind, opts?: { color?: string; withComment?: boolean }): void;
  };
  items: MenuItem[];
  onClose(): void;
}

/** Menú flotante: al seleccionar texto, con clic derecho o sobre una anotación. */
export default function SelectionMenu({ anchor, markup, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: -9999, top: -9999 });

  useLayoutEffect(() => {
    const el = ref.current!;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = anchor.left + anchor.width / 2 - w / 2;
    let top = anchor.bottom + 10;
    if (top + h > window.innerHeight - 8) top = anchor.top - h - 10;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    setPos({ left, top: Math.max(8, top) });
  }, [anchor]);

  // Se cierra al hacer clic fuera, con Esc o al desplazar.
  useLayoutEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const icon = (Icon: typeof Copy, label: string, action: () => void) => (
    <button className="icon-btn" aria-label={label} data-tip={label} onClick={action}>
      <Icon size={18} strokeWidth={1.75} />
    </button>
  );

  return (
    <div
      ref={ref}
      className="selection-menu"
      style={pos}
      onMouseDown={(e) => e.preventDefault()}
      onMouseUp={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {markup && (
        <>
          <div className="selection-icons">
            {icon(MessageSquarePlus, "Comentar", () => markup.onMarkup("highlight", { withComment: true }))}
            {icon(Highlighter, "Resaltar", () => markup.onMarkup("highlight"))}
            {icon(Underline, "Subrayar", () => markup.onMarkup("underline"))}
            {icon(Strikethrough, "Tachar", () => markup.onMarkup("strikeout"))}
          </div>
          <div className="selection-colors">
            {HIGHLIGHT_COLORS.map((c) => (
              <button
                key={c}
                className={`swatch small${markup.highlightColor === c ? " active" : ""}`}
                style={{ background: c }}
                aria-label={`Resaltar en ${c}`}
                title="Resaltar con este color"
                onClick={() => markup.onMarkup("highlight", { color: c })}
              />
            ))}
          </div>
          {items.length > 0 && <div className="menu-sep" />}
        </>
      )}
      {items.map((it) => (
        <button key={it.label} className="menu-item" onClick={it.action}>
          <it.icon size={16} strokeWidth={1.75} /> {it.label}
        </button>
      ))}
    </div>
  );
}
