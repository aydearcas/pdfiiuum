import { useEffect, useMemo, useRef, useState } from "react";
import { Bookmark, ChevronRight, ExternalLink, LayoutGrid, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import Thumbnails from "./Thumbnails";
import type { PDFDocument } from "../lib/pdf";
import { ancestorsOf, currentNode, type OutlineNode } from "../lib/outline";

export type LeftView = "thumbs" | "outline";

interface Props {
  doc: PDFDocument;
  outline: OutlineNode[];
  outlineLoading: boolean;
  view: LeftView;
  collapsed: boolean;
  currentPage: number;
  onView(view: LeftView): void;
  onToggleCollapsed(): void;
  onGoToPage(page: number): void;
  onGoToDest(dest: string | unknown[]): void;
}

/** Panel izquierdo: miniaturas o marcadores. Se recoge en una franja con sus dos iconos. */
export default function LeftPanel(p: Props) {
  if (p.collapsed) {
    return (
      <aside className="left-panel collapsed">
        <button className="icon-btn" aria-label="Desplegar panel" data-tip="Desplegar panel" onClick={p.onToggleCollapsed}>
          <PanelLeftOpen size={18} strokeWidth={1.75} />
        </button>
        <span className="divider horizontal" />
        <button
          className="icon-btn"
          aria-label="Miniaturas"
          data-tip="Miniaturas"
          onClick={() => {
            p.onView("thumbs");
            p.onToggleCollapsed();
          }}
        >
          <LayoutGrid size={18} strokeWidth={1.75} />
        </button>
        <button
          className="icon-btn"
          aria-label="Marcadores"
          data-tip={p.outline.length ? "Marcadores" : "Marcadores (este PDF no tiene)"}
          onClick={() => {
            p.onView("outline");
            p.onToggleCollapsed();
          }}
        >
          <Bookmark size={18} strokeWidth={1.75} />
        </button>
      </aside>
    );
  }

  return (
    <aside className="left-panel">
      <header className="left-head">
        <div className="segmented" role="tablist">
          <button
            role="tab"
            aria-selected={p.view === "thumbs"}
            className={p.view === "thumbs" ? "on" : ""}
            onClick={() => p.onView("thumbs")}
          >
            <LayoutGrid size={14} strokeWidth={1.75} /> Miniaturas
          </button>
          <button
            role="tab"
            aria-selected={p.view === "outline"}
            className={p.view === "outline" ? "on" : ""}
            onClick={() => p.onView("outline")}
          >
            <Bookmark size={14} strokeWidth={1.75} /> Marcadores
          </button>
        </div>
        <button className="mini-btn" title="Recoger panel" onClick={p.onToggleCollapsed}>
          <PanelLeftClose size={16} />
        </button>
      </header>
      {p.view === "thumbs" ? (
        <Thumbnails doc={p.doc} currentPage={p.currentPage} onSelect={p.onGoToPage} />
      ) : (
        <OutlineTree
          nodes={p.outline}
          loading={p.outlineLoading}
          currentPage={p.currentPage}
          onGoToDest={p.onGoToDest}
        />
      )}
    </aside>
  );
}

function OutlineTree({
  nodes,
  loading,
  currentPage,
  onGoToDest,
}: {
  nodes: OutlineNode[];
  loading: boolean;
  currentPage: number;
  onGoToDest(dest: string | unknown[]): void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  // El marcador pulsado se mantiene resaltado mientras no te alejes más de una página:
  // si apunta abajo en una página, el visor puede dar como «actual» la siguiente.
  const [picked, setPicked] = useState<OutlineNode | null>(null);
  const current = useMemo(() => {
    if (picked?.page != null && Math.abs(picked.page - currentPage) <= 1) return picked.id;
    return currentNode(nodes, currentPage);
  }, [nodes, currentPage, picked]);

  // Al cargar: abiertos los que el PDF marca como abiertos.
  useEffect(() => {
    const initial = new Set<string>();
    const walk = (list: OutlineNode[]) =>
      list.forEach((n) => {
        if (n.open) initial.add(n.id);
        walk(n.children);
      });
    walk(nodes);
    setOpen(initial);
  }, [nodes]);

  // Al avanzar por el documento se despliega y se muestra la sección actual.
  useEffect(() => {
    if (!current) return;
    const path = ancestorsOf(nodes, current);
    if (path.some((id) => !open.has(id))) setOpen((o) => new Set([...o, ...path]));
    requestAnimationFrame(() =>
      listRef.current?.querySelector(`[data-node="${current}"]`)?.scrollIntoView({ block: "nearest" }),
    );
    // Solo al cambiar la sección actual: desplegar a mano no debe volver a hacer scroll.
  }, [current]);

  if (!nodes.length) {
    return (
      <p className="outline-empty">
        {loading ? "Leyendo marcadores…" : "Este documento no tiene marcadores (índice)."}
      </p>
    );
  }

  const toggle = (id: string) =>
    setOpen((o) => {
      const next = new Set(o);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const render = (list: OutlineNode[], depth: number) =>
    list.map((n) => {
      const hasChildren = n.children.length > 0;
      const isOpen = open.has(n.id);
      return (
        <div key={n.id} role="treeitem" aria-expanded={hasChildren ? isOpen : undefined}>
          <div
            data-node={n.id}
            className={`outline-row${n.id === current ? " current" : ""}`}
            style={{ paddingLeft: 6 + depth * 14 }}
            title={n.title}
            onClick={() => {
              setPicked(n);
              if (n.dest) onGoToDest(n.dest);
              else if (n.url) window.open(n.url, "_blank", "noopener");
            }}
          >
            {hasChildren ? (
              <button
                className={`outline-chevron${isOpen ? " open" : ""}`}
                aria-label={isOpen ? "Contraer" : "Desplegar"}
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(n.id);
                }}
              >
                <ChevronRight size={13} />
              </button>
            ) : (
              <span className="outline-chevron" />
            )}
            <span
              className="outline-title"
              style={{ fontWeight: n.bold ? 700 : undefined, fontStyle: n.italic ? "italic" : undefined }}
            >
              {n.title}
            </span>
            {n.url && !n.dest ? (
              <ExternalLink size={12} className="outline-page" />
            ) : (
              n.page != null && <span className="outline-page">{n.page}</span>
            )}
          </div>
          {hasChildren && isOpen && <div role="group">{render(n.children, depth + 1)}</div>}
        </div>
      );
    });

  return (
    <div className="outline" role="tree" ref={listRef}>
      {render(nodes, 0)}
    </div>
  );
}
