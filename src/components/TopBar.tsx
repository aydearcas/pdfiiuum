import { useEffect, useState } from "react";
import {
  ChevronDown,
  FolderOpen,
  Maximize,
  MoveHorizontal,
  PanelLeft,
  Puzzle,
  Redo2,
  RotateCw,
  Save,
  SaveAll,
  Search,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import IconButton from "./IconButton";
import { isTauri } from "../lib/platform";

interface Props {
  fileName: string | null;
  dirty: boolean;
  saving: boolean;
  hasDoc: boolean;
  canUndo: boolean;
  canRedo: boolean;
  page: number;
  pageCount: number;
  scale: number;
  sidebarOpen: boolean;
  onOpen(): void;
  onSave(): void;
  onSaveAs(): void;
  onUndo(): void;
  onRedo(): void;
  onToggleSidebar(): void;
  onPage(page: number): void;
  onZoomIn(): void;
  onZoomOut(): void;
  onScale(value: string | number): void;
  onRotate(): void;
  onSearch(): void;
  onBrowserExtension(): void;
}

const PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

export default function TopBar(p: Props) {
  const [pageInput, setPageInput] = useState(String(p.page));
  const [zoomOpen, setZoomOpen] = useState(false);
  useEffect(() => setPageInput(String(p.page)), [p.page]);

  useEffect(() => {
    if (!zoomOpen) return;
    const close = () => setZoomOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [zoomOpen]);

  const commitPage = () => {
    const n = parseInt(pageInput, 10);
    if (n >= 1 && n <= p.pageCount) p.onPage(n);
    else setPageInput(String(p.page));
  };

  return (
    <header className="topbar">
      <div className="topbar-group">
        <IconButton
          icon={PanelLeft}
          label={p.sidebarOpen ? "Ocultar panel lateral" : "Mostrar panel lateral"}
          active={p.sidebarOpen}
          disabled={!p.hasDoc}
          onClick={p.onToggleSidebar}
        />
        <span className="divider" />
        <IconButton icon={FolderOpen} label="Abrir (Ctrl+O)" onClick={p.onOpen} />
        <IconButton
          icon={Save}
          label={p.saving ? "Guardando…" : "Guardar (Ctrl+S)"}
          disabled={!p.hasDoc || p.saving}
          badge={p.dirty ? "•" : undefined}
          onClick={p.onSave}
        />
        <IconButton icon={SaveAll} label="Guardar como (Ctrl+Mayús+S)" disabled={!p.hasDoc || p.saving} onClick={p.onSaveAs} />
        <span className="divider" />
        <IconButton icon={Undo2} label="Deshacer (Ctrl+Z)" disabled={!p.canUndo} onClick={p.onUndo} />
        <IconButton icon={Redo2} label="Rehacer (Ctrl+Y)" disabled={!p.canRedo} onClick={p.onRedo} />
        {p.fileName && (
          <span className="filename" title={p.fileName}>
            {p.fileName}
            {p.dirty && <em> · sin guardar</em>}
          </span>
        )}
      </div>

      {p.hasDoc && (
        <div className="topbar-group center">
          <div className="pager">
            <input
              value={pageInput}
              onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ""))}
              onBlur={commitPage}
              onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
              aria-label="Página actual"
            />
            <span>/ {p.pageCount}</span>
          </div>
          <span className="divider" />
          <IconButton icon={ZoomOut} label="Alejar (Ctrl+-)" onClick={p.onZoomOut} />
          <div className="zoom">
            <button
              className="zoom-btn"
              onClick={(e) => {
                e.stopPropagation();
                setZoomOpen((v) => !v);
              }}
            >
              {Math.round(p.scale * 100)}%
              <ChevronDown size={14} />
            </button>
            {zoomOpen && (
              <div className="menu">
                <button onClick={() => p.onScale("page-width")}>
                  <MoveHorizontal size={16} /> Ajustar al ancho
                </button>
                <button onClick={() => p.onScale("page-fit")}>
                  <Maximize size={16} /> Página completa
                </button>
                <div className="menu-sep" />
                {PRESETS.map((z) => (
                  <button key={z} onClick={() => p.onScale(z)}>
                    {z * 100}%
                  </button>
                ))}
              </div>
            )}
          </div>
          <IconButton icon={ZoomIn} label="Acercar (Ctrl++)" onClick={p.onZoomIn} />
          <span className="divider" />
          <IconButton icon={MoveHorizontal} label="Ajustar al ancho" onClick={() => p.onScale("page-width")} />
          <IconButton icon={RotateCw} label="Girar vista" onClick={p.onRotate} />
        </div>
      )}

      <div className="topbar-group right">
        {isTauri && (
          <IconButton icon={Puzzle} label="Extensión para el navegador" onClick={p.onBrowserExtension} />
        )}
        <IconButton icon={Search} label="Buscar (Ctrl+F)" disabled={!p.hasDoc} onClick={p.onSearch} />
      </div>
    </header>
  );
}
