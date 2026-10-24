import { useEffect, useState } from "react";
import {
  AppWindow,
  ChevronDown,
  FolderOpen,
  Globe,
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
import { isExtension, isTauri } from "../lib/platform";

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
  onOpenInApp(): void;
  onBrowserViewer(): void;
}

const PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
/** Zoom que se puede escribir, en %, como en el visor (Ctrl + rueda). */
const MIN_ZOOM = 10;
const MAX_ZOOM = 1000;

export default function TopBar(p: Props) {
  const [pageInput, setPageInput] = useState(String(p.page));
  const [zoomOpen, setZoomOpen] = useState(false);
  const [zoomInput, setZoomInput] = useState(String(Math.round(p.scale * 100)));
  useEffect(() => setPageInput(String(p.page)), [p.page]);
  useEffect(() => setZoomInput(String(Math.round(p.scale * 100))), [p.scale]);

  useEffect(() => {
    if (!zoomOpen) return;
    const close = () => setZoomOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [zoomOpen]);

  /** «150», «150 %» o «87,5»: se limita al intervalo admitido; lo que no es un número se descarta. */
  const commitZoom = () => {
    const n = parseFloat(zoomInput.replace(",", ".").replace(/[^\d.]/g, ""));
    if (Number.isFinite(n) && n > 0) {
      const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, n));
      p.onScale(z / 100);
      setZoomInput(String(Math.round(z)));
    } else setZoomInput(String(Math.round(p.scale * 100)));
  };

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
            <div className="zoom-box">
              <input
                className="zoom-input"
                value={zoomInput}
                inputMode="decimal"
                aria-label="Zoom (%)"
                title={`Escribe el zoom (de ${MIN_ZOOM} a ${MAX_ZOOM} %) y pulsa Intro`}
                onChange={(e) => setZoomInput(e.target.value)}
                onFocus={(e) => e.currentTarget.select()}
                onBlur={commitZoom}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  else if (e.key === "Escape") {
                    setZoomInput(String(Math.round(p.scale * 100)));
                    // El valor se restaura antes de que el blur lo confirme.
                    requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
                  }
                }}
              />
              <span className="zoom-pct">%</span>
              <button
                className="zoom-btn"
                aria-label="Opciones de zoom"
                onClick={(e) => {
                  e.stopPropagation();
                  setZoomOpen((v) => !v);
                }}
              >
                <ChevronDown size={14} />
              </button>
            </div>
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
        {isExtension && (
          <>
            <IconButton icon={Globe} label="Ver con el visor del navegador" onClick={p.onBrowserViewer} />
            <IconButton icon={AppWindow} label="Abrir en la app de pdfiiuum" disabled={!p.hasDoc} onClick={p.onOpenInApp} />
          </>
        )}
        <IconButton icon={Search} label="Buscar (Ctrl+F)" disabled={!p.hasDoc} onClick={p.onSearch} />
      </div>
    </header>
  );
}
