import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { Copy } from "lucide-react";
import LeftPanel, { type LeftView } from "./LeftPanel";
import { loadOutline, type OutlineNode } from "../lib/outline";
import SearchBar from "./SearchBar";
import SelectionMenu, { type MenuItem } from "./SelectionMenu";
import Viewer, { type FindStatus, type ViewState, type ViewerHandle } from "./Viewer";
import { closePdf, type PDFDocument } from "../lib/pdf";
import CommentsPanel, { sortItems, type PanelItem } from "./CommentsPanel";
import { bounds, diffAnnots, newId, pdfDate, toNative, type Annot, type MarkupKind } from "../lib/annotations";
import { openDocument } from "../lib/document";
import type { TextSelection } from "../lib/selection";
import { isEditTool, type Tool, type ToolStyle } from "../lib/tools";
import type { TextRun } from "../lib/edit";
import { useAnnotations } from "../lib/useAnnotations";
import { baseName, editText, getUserName, isTauri, saveAnnotated, savePdf, textRuns } from "../lib/platform";

/** Documento con el que se crea una pestaña. */
export interface TabInit {
  pdf: PDFDocument;
  /** Bytes del archivo tal como está en disco (base para guardar con PDFium). */
  bytes: Uint8Array;
  name: string;
  path: string | null;
  /** Anotaciones que ya tiene el PDF en disco (editables). */
  baseline: Annot[];
  /** Estado de las anotaciones traído de otra ventana (incluye cambios sin guardar). */
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
  /** Hay texto corregido sin guardar (no viaja con la pestaña). */
  edited?: boolean;
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
  leftCollapsed: boolean;
  onToggleLeftCollapsed(): void;
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
  const history = useAnnotations(p.init.annots ?? p.init.baseline);
  const { annots } = history;
  // Cambios respecto a lo guardado en el PDF (nuevas, modificadas o borradas).
  const changes = useMemo(() => diffAnnots(doc.baseline, annots), [doc.baseline, annots]);
  // Modo edición: el PDF tal como está en disco y los PDF anteriores para deshacer.
  const diskBytes = useRef(p.init.bytes);
  const [edits, setEdits] = useState<{ past: Uint8Array[]; future: Uint8Array[] }>({ past: [], future: [] });
  const editBusy = useRef(false);
  const edited = doc.bytes !== diskBytes.current;
  const dirty = changes.dirty || edited;
  const editMode = isEditTool(tool);
  const viewer = useRef<ViewerHandle>(null);
  const [author, setAuthor] = useState("");
  const docRef = useRef(doc);

  useEffect(() => {
    getUserName().then(setAuthor);
  }, []);

  // Marcadores: la primera vez se abre la vista de marcadores si el PDF tiene índice.
  const [outline, setOutline] = useState<OutlineNode[]>([]);
  const [outlineLoading, setOutlineLoading] = useState(true);
  const [leftView, setLeftView] = useState<LeftView | null>(null);
  useEffect(() => {
    let cancelled = false;
    setOutlineLoading(true);
    loadOutline(doc.pdf)
      .catch(() => [])
      .then((nodes) => {
        if (cancelled) return;
        setOutline(nodes);
        setOutlineLoading(false);
        setLeftView((v) => v ?? (nodes.length ? "outline" : "thumbs"));
      });
    return () => {
      cancelled = true;
    };
  }, [doc.pdf]);

  docRef.current = doc;
  const annotsRef = useRef(annots);
  annotsRef.current = annots;
  const changesRef = useRef(changes);
  changesRef.current = changes;

  // Al cambiar de PDF (guardar, corregir texto, deshacer) se libera el anterior cuando
  // el visor y las miniaturas ya muestran el nuevo.
  const shownPdf = useRef(doc.pdf);
  useEffect(() => {
    const prev = shownPdf.current;
    shownPdf.current = doc.pdf;
    if (prev !== doc.pdf) closePdf(prev);
  }, [doc.pdf]);

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
      canUndo: editMode ? edits.past.length > 0 : history.canUndo,
      canRedo: editMode ? edits.future.length > 0 : history.canRedo,
      page,
      pageCount: doc.pdf.numPages,
      scale,
    });
  }, [id, onStatus, doc, dirty, saving, history.canUndo, history.canRedo, page, scale, editMode, edits]);

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
      const { remove, add, dirty: hasChanges } = changesRef.current;
      setSaving(true);
      try {
        if (!hasChanges) {
          // Sin cambios en anotaciones: el archivo tal cual, con el texto corregido si lo hay
          // (pdf.js muestra una copia sin las anotaciones).
          const target = await savePdf(d.bytes, d.name, d.path, saveAs || !isTauri);
          if (!target) return;
          if (isTauri) {
            diskBytes.current = d.bytes;
            setDoc({ ...d, name: baseName(target), path: target });
            setEdits({ past: [], future: [] });
          }
          notify(isTauri ? `Guardado: ${baseName(target)}` : "Descarga iniciada");
          return;
        }
        const result = await saveAnnotated(d.bytes, { remove, add: add.map(toNative) }, d.name, d.path, saveAs);
        if (!result) return;
        diskBytes.current = result.bytes;
        setEdits({ past: [], future: [] });
        // Recarga lo guardado: sus anotaciones vuelven a ser la base editable.
        const view = viewer.current?.viewState();
        const reopened = await openDocument(result.bytes);
        setDoc({ ...reopened, bytes: result.bytes, name: baseName(result.path), path: result.path, view });
        history.reset(reopened.baseline);
        clearSelection();
        const n = add.length + remove.filter((o) => !add.some((a) => a.origin?.[0] === o[0] && a.origin?.[1] === o[1])).length;
        notify(`Guardado (${n} cambio${n === 1 ? "" : "s"} en anotaciones): ${baseName(result.path)}`);
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

  // ---------- Modo edición ----------

  /** Muestra otro PDF (corregido, o el anterior al deshacer) conservando la vista y las anotaciones. */
  const showBytes = useCallback(async (bytes: Uint8Array) => {
    const d = docRef.current;
    const view = viewer.current?.viewState();
    const reopened = await openDocument(bytes);
    setDoc({ ...d, ...reopened, bytes, view });
  }, []);

  // Tramos de cada página, leídos una vez por versión del PDF.
  const runsCache = useMemo(() => new Map<number, Promise<TextRun[]>>(), [doc.bytes]);
  const getRuns = useCallback(
    (n: number) => {
      let runs = runsCache.get(n);
      if (!runs) {
        runs = textRuns(doc.bytes, n);
        runsCache.set(n, runs);
      }
      return runs;
    },
    [runsCache, doc.bytes],
  );

  const editRun = useCallback(
    async (n: number, run: TextRun, text: string) => {
      if (editBusy.current) return false;
      editBusy.current = true;
      const before = docRef.current.bytes;
      try {
        const result = await editText(before, n, run.objects, text);
        await showBytes(result.bytes);
        setEdits((s) => ({ past: [...s.past, before].slice(-50), future: [] }));
        if (result.notice) notify(result.notice);
        return true;
      } catch (e) {
        notify(`No se pudo corregir el texto: ${e instanceof Error ? e.message : e}`, true);
        return false;
      } finally {
        editBusy.current = false;
      }
    },
    [showBytes, notify],
  );

  const undoEdit = useCallback(
    async (redo: boolean) => {
      const from = redo ? edits.future : edits.past;
      if (editBusy.current || !from.length) return;
      editBusy.current = true;
      const current = docRef.current.bytes;
      const target = redo ? from[0] : from[from.length - 1];
      try {
        await showBytes(target);
        setEdits((s) =>
          redo
            ? { past: [...s.past, current], future: s.future.slice(1) }
            : { past: s.past.slice(0, -1), future: [current, ...s.future] },
        );
      } finally {
        editBusy.current = false;
      }
    },
    [edits, showBytes],
  );

  useImperativeHandle(
    p.ref,
    () => ({
      save,
      // En el modo edición, deshacer se refiere a las correcciones del texto.
      undo: editMode ? () => void undoEdit(false) : history.undo,
      redo: editMode ? () => void undoEdit(true) : history.redo,
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
        edited: docRef.current.bytes !== diskBytes.current,
      }),
    }),
    [save, history.undo, history.redo, selectedId, onDelete, clearSelection, editMode, undoEdit],
  );

  // Panel lateral: notas y marcas en orden de lectura; «Sin guardar» las nuevas o cambiadas.
  const panelItems = sortItems(
    annots.flatMap<PanelItem>((a) =>
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
              pending: changes.changedIds.has(a.id),
            },
          ]
        : [],
    ),
  );

  const pickItem = (it: PanelItem) => {
    viewer.current?.scrollTo(it.page, it.rect[0], it.rect[3]);
    setTool("select");
    setSelectedId(it.key);
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
        <LeftPanel
          doc={doc.pdf}
          outline={outline}
          outlineLoading={outlineLoading}
          view={leftView ?? "thumbs"}
          collapsed={p.leftCollapsed}
          currentPage={page}
          onView={setLeftView}
          onToggleCollapsed={p.onToggleLeftCollapsed}
          onGoToPage={(n) => viewer.current?.goToPage(n)}
          onGoToDest={(d) => viewer.current?.goToDest(d)}
        />
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
          getRuns={getRuns}
          onEditRun={editRun}
        />
        {active && editMode && (
          <div className="edit-hint">
            Haz clic en un texto para corregirlo · Intro aplica · Esc cancela · Ctrl+Z deshace
          </div>
        )}
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
        loading={false}
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
