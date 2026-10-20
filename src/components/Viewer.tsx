import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { createPortal } from "react-dom";
// Debe ir antes que pdf_viewer.mjs: registra globalThis.pdfjsLib.
import "../lib/pdf";
import {
  EventBus,
  PDFFindController,
  PDFLinkService,
  PDFViewer,
} from "pdfjs-dist/web/pdf_viewer.mjs";
import { IMAGE_RESOURCES, type PDFDocument } from "../lib/pdf";
import { contains, type Annot, type MarkupKind, type Point } from "../lib/annotations";
import { readSelection, type TextSelection } from "../lib/selection";
import { isMarkupTool, type Tool, type ToolStyle } from "../lib/tools";
import AnnotationLayer, { type LayerCallbacks } from "./AnnotationLayer";

export interface FindStatus {
  current: number;
  total: number;
  notFound: boolean;
}

export interface ViewState {
  page: number;
  scale: string | number;
  scrollTop?: number;
}

export interface ViewerHandle {
  zoomIn(): void;
  zoomOut(): void;
  setScale(value: string | number): void;
  goToPage(page: number): void;
  rotate(): void;
  find(query: string, opts?: { again?: boolean; previous?: boolean }): void;
  clearFind(): void;
  /** Va al destino de un marcador del PDF. */
  goToDest(dest: string | unknown[]): void;
  /** Lleva a la vista el punto (x, y en coordenadas PDF) de una página, sin cambiar el zoom. */
  scrollTo(page: number, x: number, y: number): void;
  /** Vuelve a leer la selección de texto actual. */
  readSelection(): TextSelection | null;
  viewState(): ViewState;
}

interface Props extends LayerCallbacks {
  doc: PDFDocument;
  tool: Tool;
  style: ToolStyle;
  annots: Annot[];
  selectedId: string | null;
  editingId: string | null;
  initialView?: ViewState;
  ref?: Ref<ViewerHandle>;
  onPageChange(page: number): void;
  onScaleChange(scale: number): void;
  onFindStatus(status: FindStatus | null): void;
  /** Selección de texto con la herramienta de selección (null al deshacerla). */
  onTextSelection(sel: TextSelection | null): void;
  /** Selección hecha con una herramienta de resaltar/subrayar/tachar. */
  onMarkup(kind: MarkupKind, sel: TextSelection): void;
  /** Clic derecho sobre una anotación pendiente. */
  onAnnotMenu(id: string, at: DOMRect): void;
}

const MIN_SCALE = 0.1;
const MAX_SCALE = 10;

export default function Viewer(props: Props) {
  const { doc, tool, ref } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<PDFViewer | null>(null);
  const busRef = useRef<EventBus | null>(null);
  const linkRef = useRef<PDFLinkService | null>(null);
  const hosts = useRef(new Map<number, HTMLDivElement>());
  const [layoutTick, setLayoutTick] = useState(0);
  const toolRef = useRef(tool);
  toolRef.current = tool;

  // Props en una ref para que los listeners de montaje vean siempre lo último.
  const cbs = useRef(props);
  cbs.current = props;

  useEffect(() => {
    const container = containerRef.current!;
    const eventBus = new EventBus();
    const linkService = new PDFLinkService({ eventBus });
    const findController = new PDFFindController({ eventBus, linkService });
    const viewer = new PDFViewer({
      container,
      eventBus,
      linkService,
      findController,
      removePageBorders: true,
      imageResourcesPath: IMAGE_RESOURCES,
    });
    linkService.setViewer(viewer);
    viewerRef.current = viewer;
    linkRef.current = linkService;    busRef.current = eventBus;

    eventBus.on("pagesinit", () => {
      const init = cbs.current.initialView;
      if (init) {
        viewer.currentScaleValue = String(init.scale);
        if (init.scrollTop != null) container.scrollTop = init.scrollTop;
        else viewer.currentPageNumber = init.page;
      } else viewer.currentScaleValue = "page-width";
      setLayoutTick((t) => t + 1);
    });
    eventBus.on("pagechanging", (e: { pageNumber: number }) => cbs.current.onPageChange(e.pageNumber));
    eventBus.on("scalechanging", (e: { scale: number }) => {
      cbs.current.onScaleChange(e.scale);
      setLayoutTick((t) => t + 1);
    });
    const relayout = () => setLayoutTick((t) => t + 1);
    eventBus.on("pagerender", relayout);
    eventBus.on("pagerendered", relayout);
    eventBus.on("rotationchanging", relayout);

    const onFind = (e: { state?: number; matchesCount: { current: number; total: number } }) => {
      cbs.current.onFindStatus({
        current: e.matchesCount.current,
        total: e.matchesCount.total,
        notFound: e.state === 1,
      });
    };
    eventBus.on("updatefindmatchescount", onFind);
    eventBus.on("updatefindcontrolstate", onFind);

    viewer.setDocument(doc);
    linkService.setDocument(doc);
    findController.setDocument(doc);

    // Ctrl + rueda = zoom centrado en el cursor.
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const factor = Math.exp(-e.deltaY / 400);
      const next = viewer.currentScale * factor;
      if (next < MIN_SCALE || next > MAX_SCALE) return;
      viewer.updateScale({ scaleFactor: factor, origin: [e.clientX, e.clientY] });
    };
    container.addEventListener("wheel", onWheel, { passive: false });

    // Herramienta mano: arrastrar para desplazarse.
    let drag: { x: number; y: number; left: number; top: number } | null = null;
    let downAt: { x: number; y: number } | null = null;
    const onDown = (e: MouseEvent) => {
      downAt = { x: e.clientX, y: e.clientY };
      if (toolRef.current !== "hand" || e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, left: container.scrollLeft, top: container.scrollTop };
      container.classList.add("grabbing");
      e.preventDefault();
    };
    const onMove = (e: MouseEvent) => {
      if (!drag) return;
      container.scrollLeft = drag.left - (e.clientX - drag.x);
      container.scrollTop = drag.top - (e.clientY - drag.y);
    };
    const onUp = (e: MouseEvent) => {
      if (drag) {
        drag = null;
        container.classList.remove("grabbing");
        return;
      }
      if (!container.contains(e.target as Node) || e.button !== 0) return;
      const t = toolRef.current;
      const sel = readSelection(viewer);
      if (sel && isMarkupTool(t)) {
        cbs.current.onMarkup(t, sel);
        window.getSelection()?.removeAllRanges();
      } else if (sel && t === "select") {
        cbs.current.onTextSelection(sel);
      } else if (t === "select" && downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 4) {
        hitTest(e);
      }
    };
    // Anotación bajo el puntero: notas/textos/dibujos por su elemento, resaltados por geometría.
    const annotAt = (e: MouseEvent): string | null => {
      const target = e.target as HTMLElement;
      const own = target.closest<HTMLElement>("[data-annot-id]");
      if (own) return own.dataset.annotId!;
      const pageDiv = target.closest<HTMLElement>(".page");
      const page = Number(pageDiv?.dataset.pageNumber);
      if (!pageDiv || !page) return null;
      const box = pageDiv.getBoundingClientRect();
      const pt = viewer
        .getPageView(page - 1)
        .viewport.convertToPdfPoint(e.clientX - box.left, e.clientY - box.top) as Point;
      const hit = [...cbs.current.annots]
        .reverse()
        .find((a) => a.page === page && "rects" in a && a.rects.some((r) => contains(r, pt, 1)));
      return hit?.id ?? null;
    };
    // Un clic simple selecciona el resaltado/subrayado/tachado que haya debajo.
    const hitTest = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest(".note-icon, .text-annot, .text-editor")) return;
      cbs.current.onSelect(annotAt(e));
    };
    // Clic derecho: nuestro menú en lugar del del navegador.
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      if (toolRef.current !== "select") return;
      const at = new DOMRect(e.clientX, e.clientY, 0, 0);
      const sel = readSelection(viewer);
      if (sel) return cbs.current.onTextSelection({ ...sel, anchor: at });
      // Solo sobre la anotación ya seleccionada con clic izquierdo.
      const id = annotAt(e);
      if (id && id === cbs.current.selectedId) cbs.current.onAnnotMenu(id, at);
    };
    const onSelectionChange = () => {
      if (window.getSelection()?.isCollapsed) cbs.current.onTextSelection(null);
    };
    container.addEventListener("mousedown", onDown);
    container.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.addEventListener("selectionchange", onSelectionChange);

    return () => {
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("mousedown", onDown);
      container.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.removeEventListener("selectionchange", onSelectionChange);
      // setDocument(null) detiene el renderizado; luego vaciamos las páginas.
      viewer.setDocument(null as never);
      viewer.viewer!.replaceChildren();
      hosts.current.clear();
      viewerRef.current = null;
      busRef.current = null;
    };
  }, [doc]);

  // pdf.js vacía el div de cada página al cambiar el zoom: volvemos a colocar nuestras capas.
  const viewer = viewerRef.current;
  const pageViews: { page: number; host: HTMLDivElement }[] = [];
  if (viewer && viewer.pagesCount) {
    for (let i = 0; i < viewer.pagesCount; i++) {
      const view = viewer.getPageView(i);
      if (!view?.div) continue;
      let host = hosts.current.get(i + 1);
      if (!host) {
        host = document.createElement("div");
        host.className = "annot-host";
        hosts.current.set(i + 1, host);
      }
      if (host.parentElement !== view.div) view.div.append(host);
      pageViews.push({ page: i + 1, host });
    }
  }

  useImperativeHandle(
    ref,
    () => ({
      zoomIn: () => viewerRef.current?.increaseScale(),
      zoomOut: () => viewerRef.current?.decreaseScale(),
      setScale: (value) => {
        const v = viewerRef.current;
        if (!v) return;
        if (typeof value === "number") v.currentScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
        else v.currentScaleValue = value;
      },
      goToPage: (page) => {
        const v = viewerRef.current;
        if (v && page >= 1 && page <= v.pagesCount) v.currentPageNumber = page;
      },
      rotate: () => {
        const v = viewerRef.current;
        if (v) v.pagesRotation = (v.pagesRotation + 90) % 360;
      },
      find: (query, opts = {}) => {
        busRef.current?.dispatch("find", {
          source: null,
          type: opts.again ? "again" : "",
          query,
          caseSensitive: false,
          entireWord: false,
          highlightAll: true,
          findPrevious: !!opts.previous,
          matchDiacritics: false,
        });
      },
      clearFind: () => {
        busRef.current?.dispatch("findbarclose", { source: null });
        cbs.current.onFindStatus(null);
      },
      goToDest: (dest) => {
        linkRef.current?.goToDestination(dest as string | unknown[]);
      },
      scrollTo: (page, x, y) => {
        viewerRef.current?.scrollPageIntoView({
          pageNumber: page,
          destArray: [null, { name: "XYZ" }, Math.max(0, x - 40), y + 60, null],
          allowNegativeOffset: true,
        });
      },
      readSelection: () => (viewerRef.current ? readSelection(viewerRef.current) : null),
      viewState: () => {
        const v = viewerRef.current;
        return {
          page: v?.currentPageNumber ?? 1,
          scale: v?.currentScaleValue ?? "page-width",
          scrollTop: containerRef.current?.scrollTop,
        };
      },
    }),
    [],
  );

  return (
    <div
      ref={containerRef}
      className={`viewer-container tool-${tool}`}
      tabIndex={-1}
      data-layout={layoutTick}
    >
      <div className="pdfViewer" />
      {viewer &&
        pageViews.map(({ page, host }) =>
          createPortal(
            <AnnotationLayer
              page={page}
              viewport={viewer.getPageView(page - 1).viewport}
              annots={props.annots.filter((a) => a.page === page)}
              selectedId={props.selectedId}
              editingId={props.editingId}
              tool={tool}
              style={props.style}
              onCreate={props.onCreate}
              onSelect={props.onSelect}
              onBegin={props.onBegin}
              onChange={props.onChange}
              onDelete={props.onDelete}
              onEdit={props.onEdit}
            />,
            host,
            String(page),
          ),
        )}
    </div>
  );
}
