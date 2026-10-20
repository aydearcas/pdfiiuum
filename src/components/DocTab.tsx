import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { Copy } from "lucide-react";
import Thumbnails from "./Thumbnails";
import SearchBar from "./SearchBar";
import SelectionMenu, { type MenuItem } from "./SelectionMenu";
import Viewer, { type FindStatus, type ViewState, type ViewerHandle } from "./Viewer";
import { closePdf, loadPdf, type PDFDocument } from "../lib/pdf";
import CommentsPanel, { sortItems, type PanelItem } from "./CommentsPanel";
import { bounds, newId, pdfDate, toNative, type Annot, type MarkupKind } from "../lib/annotations";
import { readSavedAnnots, type SavedAnnot } from "../lib/savedAnnots";
import type { TextSelection } from "../lib/selection";
import type { Tool, ToolStyle } from "../lib/tools";
import { useAnnotations } from "../lib/useAnnotations";
import { baseName, getUserName, isTauri, saveAnnotated, savePdf } from "../lib/platform";

/** Documento con el que se crea una pestaña. */
export interface TabInit {
  pdf: PDFDocument;
  /** Bytes del archivo tal como está en disco (base para guardar con PDFium). */
  bytes: Uint8Array;
  name: string;
  path: string | null;
  /** Anotaciones pendientes traídas de otra ventana. */
  annots?: Annot[];
  view?: ViewState;
}

/** Lo que la barra superior y la ventana necesitan saber de la pestaña. */
export interface TabStatus {
  name: string;
  path: string | null;
  dirty: boolean;
  saving: boolean;
  canUndo: boolean;
  canRedo: boolean;
  page: number;
  pageCount: number;
  scale: number;
}

/** Estado que viaja con una pestaña al sacarla a otra ventana. */
export interface TabSnapshot {
  path: string | null;
  name: string;
  annots: Annot[];
  view?: ViewState;
}

export interface DocTabHandle {
  save(saveAs: boolean): Promise<void>;
  undo(): void;
  redo(): void;
  zoomIn(): void;
  zoomOut(): void;
  setScale(v: string | number): void;
  goToPage(n: number): void;
  rotate(): void;
  toggleSearch(open?: boolean): void;
  deleteSelected(): boolean;
  escape(): void;
  snapshot(): TabSnapshot;
}

interface Props {
  id: string;
  init: TabInit;
  active: boolean;
  tool: Tool;
  toolStyle: ToolStyle;
  sidebarOpen: boolean;
  commentsOpen: boolean;
  onToggleComments(): void;
  ref?: Ref<DocTabHandle>;
  setTool(t: Tool): void;
  setToolStyle(fn: (s: ToolStyle) => ToolStyle): void;
  notify(text: string, error?: boolean): void;
  copyText(text: string, message: string): void;
  onStatus(id: string, status: TabStatus): void;
}

export default function DocTab(p: Props) {
  const { id, active, tool, toolStyle, setTool, setToolStyle, notify, copyText, onStatus } = p;
  const [doc, setDoc] = useState<TabInit>(p.init);
  const [page, setPage] = useState(p.init.view?.page ?? 1);
  const [scale, setScale] = useState(1);
  const [searchOpen, setSearchOpen] = useState(false);
  const [findStatus, setFindStatus] = useState<FindStatus | null>(null);
  const [textSel, setTextSel] = useState<TextSelection | null>(null);
  const [annotMenu, setAnnotMenu] = useState<{ id: string; anchor: DOMRect } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const history = useAnnotations(p.init.annots);
  const { annots } = history;
  const dirty = annots.length > 0;
  const viewer = useRef<ViewerHandle>(null);
  const [author, setAuthor] = useState("");
  const [saved, setSaved] = useState<SavedAnnot[]>([]);
  const [loadingSaved, setLoadingSaved] = useState(true);
  const docRef = useRef(doc);

  useEffect(() => {
    getUserName().then(setAuthor);
  }, []);

  // Comentarios ya guardados en el PDF (se vuelven a leer al guardar, porque cambia el documento).
  useEffect(() => {
    let cancelled = false;
    setLoadingSaved(true);
    readSavedAnnots(doc.pdf, () => cancelled)
      .then((list) => !cancelled && setSaved(list))
      .catch(() => !cancelled && setSaved([]))
      .finally(() => !cancelled && setLoadingSaved(false));
    return () => {
      cancelled = true;
    };
  }, [doc.pdf]);
  docRef.current = doc;
  const annotsRef = useRef(annots);
  annotsRef.current = annots;

  // Libera el PDF al cerrar la pestaña. Se aplaza un instante porque en desarrollo
  // React desmonta y vuelve a montar cada componente una vez (StrictMode).
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const pdf = docRef.current.pdf;
      setTimeout(() => {
        if (!mounted.current) closePdf(pdf);
      }, 0);
    };
  }, []);

  useEffect(() => {
    onStatus(id, {
      name: doc.name,
      path: doc.path,
      dirty,
      saving,
      canUndo: history.canUndo,
      canRedo: history.canRedo,
      page,
      pageCount: doc.pdf.numPages,
      scale,
    });
  }, [id, onStatus, doc, dirty, saving, history.canUndo, history.canRedo, page, scale]);

  const clearSelection = useCallback(() => {
    setSelectedId(null);
    setEditingId(null);
    setTextSel(null);
    setAnnotMenu(null);
  }, []);

  // Una pestaña en segundo plano no deja menús ni tarjetas abiertos.
  useEffect(() => {
    if (!active) clearSelection();
  }, [active, clearSelection]);

  // Al cambiar de herramienta se cierran selección y menús.
  useEffect(() => {
    setTextSel(null);
    if (tool !== "select") {
      setSelectedId(null);
      setEditingId(null);
    }
  }, [tool]);

  const save = useCallback(
    async (saveAs: boolean) => {
      const d = docRef.current;
      if (saving) return;
      // Cierra cualquier editor de texto abierto para que su contenido entre en el guardado.
      (document.activeElement as HTMLElement | null)?.blur();
      await new Promise((r) => setTimeout(r, 0));
      const pending = annotsRef.current;
      setSaving(true);
      try {
        if (pending.length === 0) {
          const bytes = await d.pdf.saveDocument();
          const target = await savePdf(bytes, d.name, d.path, saveAs || !isTauri);
          if (!target) return;
          if (isTauri && target !== d.path) setDoc({ ...d, name: baseName(target), path: target });
          notify(isTauri ? `Guardado: ${baseName(target)}` : "Descarga iniciada");
          return;
        }
        const result = await saveAnnotated(d.bytes, pending.map(toNative), d.name, d.path, saveAs);
        if (!result) return;
        // Recarga el PDF guardado: las anotaciones pasan a formar parte del documento.
        const view = viewer.current?.viewState();
        const pdf = await loadPdf(result.bytes);
        closePdf(d.pdf);
        setDoc({ pdf, bytes: result.bytes, name: baseName(result.path), path: result.path, view });
        history.reset();
        clearSelection();
        notify(`Guardado con ${pending.length} anotación${pending.length === 1 ? "" : "es"}: ${baseName(result.path)}`);
      } catch (e) {
        notify(`Error al guardar: ${e instanceof Error ? e.message : e}`, true);
      } finally {
        setSaving(false);
      }
    },
    [notify, saving, history.reset, clearSelection],
  );

  // Crear resaltados/subrayados/tachados a partir de la selección de texto.
  const createMarkup = useCallback(
    (kind: MarkupKind, sel: TextSelection, opts: { color?: string; withComment?: boolean } = {}) => {
      const { color = toolStyle.colors[kind], withComment = false } = opts;
      // El color elegido pasa a ser el predeterminado de esa herramienta.
      if (color !== toolStyle.colors[kind]) setToolStyle((s) => ({ ...s, colors: { ...s.colors, [kind]: color } }));
      const date = pdfDate();
      const created: Annot[] = sel.pages.map(({ page, rects }) => ({
        id: newId(),
        kind,
        page,
        rects,
        quote: sel.text.trim(),
        color,
        contents: "",
        date,
        author,
      }));
      history.add(created);
      window.getSelection()?.removeAllRanges();
      setTextSel(null);
      if (withComment && created.length) {
        setSelectedId(created[0].id);
        setEditingId(created[0].id);
      }
    },
    [history.add, toolStyle, setToolStyle, author],
  );

  const onCreate = useCallback(
    (created: Annot) => {
      const a = { ...created, author };
      history.add(a);
      if (a.kind === "note") {
        setSelectedId(a.id);
        setEditingId(a.id);
        setTool("select");
      } else if (a.kind === "text") {
        setSelectedId(a.id);
        setTool("select");
      }
    },
    [history.add, setTool, author],
  );

  const onDelete = useCallback(
    (annotId: string) => {
      history.remove(annotId);
      setSelectedId((s) => (s === annotId ? null : s));
      setEditingId((s) => (s === annotId ? null : s));
    },
    [history.remove],
  );

  useImperativeHandle(
    p.ref,
    () => ({
      save,
      undo: history.undo,
      redo: history.redo,
      zoomIn: () => viewer.current?.zoomIn(),
      zoomOut: () => viewer.current?.zoomOut(),
      setScale: (v) => viewer.current?.setScale(v),
      goToPage: (n) => viewer.current?.goToPage(n),
      rotate: () => viewer.current?.rotate(),
      toggleSearch: (open) => setSearchOpen((v) => open ?? !v),
      deleteSelected: () => {
        if (!selectedId) return false;
        onDelete(selectedId);
        return true;
      },
      escape: clearSelection,
      snapshot: () => ({
        path: docRef.current.path,
        name: docRef.current.name,
        annots: annotsRef.current,
        view: viewer.current?.viewState(),
      }),
    }),
    [save, history.undo, history.redo, selectedId, onDelete, clearSelection],
  );

  // Panel lateral: notas y marcas, guardadas y pendientes, en orden de lectura.
  const panelItems = sortItems([
    ...saved.map<PanelItem>((s) => ({ ...s, key: `saved-${s.id}`, pending: false })),
    ...annots.flatMap<PanelItem>((a) =>
      a.kind === "note" || "rects" in a
        ? [
            {
              key: a.id,
              page: a.page,
              kind: a.kind,
              color: a.color,
              author: a.author || author,
              date: a.date,
              quote: "quote" in a ? a.quote : "",
              contents: a.contents ?? "",
              rect: bounds(a),
              pending: true,
            },
          ]
        : [],
    ),
  ]);

  const pickItem = (it: PanelItem) => {
    viewer.current?.scrollTo(it.page, it.rect[0], it.rect[3]);
    if (it.pending) {
      setTool("select");
      setSelectedId(it.key);
    } else setSelectedId(null);
  };

  const closeTextMenu = useCallback(() => setTextSel(null), []);
  const closeAnnotMenu = useCallback(() => setAnnotMenu(null), []);

  const menuAnnot = annotMenu ? annots.find((a) => a.id === annotMenu.id) : undefined;
  const annotMenuItems: MenuItem[] = [];
  if (menuAnnot) {
    const copy = (label: string, text: string, message: string) =>
      text &&
      annotMenuItems.push({
        label,
        icon: Copy,
        action: () => {
          copyText(text, message);
          setAnnotMenu(null);
        },
      });
    if (menuAnnot.kind === "highlight") copy("Copiar texto resaltado", menuAnnot.quote, "Texto copiado");
    else if ("quote" in menuAnnot) copy("Copiar texto", menuAnnot.quote, "Texto copiado");
    else if (menuAnnot.kind === "text") copy("Copiar texto", menuAnnot.text, "Texto copiado");
    if (menuAnnot.contents) copy("Copiar comentario", menuAnnot.contents, "Comentario copiado");
  }

  return (
    <div className={`doc-tab${active ? " active" : ""}`} aria-hidden={!active}>
      {p.sidebarOpen && (
        <Thumbnails doc={doc.pdf} currentPage={page} onSelect={(n) => viewer.current?.goToPage(n)} />
      )}
      <main className="stage">
        <Viewer
          ref={viewer}
          doc={doc.pdf}
          initialView={doc.view}
          tool={tool}
          style={toolStyle}
          annots={annots}
          selectedId={selectedId}
          editingId={editingId}
          onPageChange={setPage}
          onScaleChange={setScale}
          onFindStatus={setFindStatus}
          onTextSelection={setTextSel}
          onMarkup={createMarkup}
          onAnnotMenu={(annotId, anchor) => {
            setTextSel(null);
            setAnnotMenu({ id: annotId, anchor });
          }}
          onCreate={onCreate}
          onSelect={(annotId) => {
            setSelectedId(annotId);
            if (annotId !== editingId) setEditingId(null);
          }}
          onBegin={history.begin}
          onChange={history.change}
          onDelete={onDelete}
          onEdit={setEditingId}
        />
        {searchOpen && (
          <SearchBar
            status={findStatus}
            onFind={(q, o) => viewer.current?.find(q, o)}
            onClose={() => {
              setSearchOpen(false);
              viewer.current?.clearFind();
            }}
          />
        )}
      </main>
      <CommentsPanel
        open={p.commentsOpen}
        items={panelItems}
        loading={loadingSaved}
        selectedKey={selectedId}
        onToggle={p.onToggleComments}
        onPick={pickItem}
      />
      {active && textSel && tool === "select" && (
        <SelectionMenu
          anchor={textSel.anchor}
          markup={{
            highlightColor: toolStyle.colors.highlight,
            onMarkup: (kind, opts) => createMarkup(kind, textSel, opts),
          }}
          items={[
            {
              label: "Copiar texto",
              icon: Copy,
              action: () => {
                copyText(textSel.text, "Texto copiado");
                window.getSelection()?.removeAllRanges();
                setTextSel(null);
              },
            },
          ]}
          onClose={closeTextMenu}
        />
      )}
      {active && annotMenu && annotMenuItems.length > 0 && (
        <SelectionMenu anchor={annotMenu.anchor} items={annotMenuItems} onClose={closeAnnotMenu} />
      )}
    </div>
  );
}
