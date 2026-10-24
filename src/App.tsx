import { useCallback, useEffect, useRef, useState } from "react";
import { FolderOpen } from "lucide-react";
import TabBar from "./components/TabBar";
import TopBar from "./components/TopBar";
import ToolRail from "./components/ToolRail";
import ExtensionDialog from "./components/ExtensionDialog";
import DocTab, { type DocTabHandle, type TabInit, type TabSnapshot, type TabStatus } from "./components/DocTab";
import { openDocument } from "./lib/document";
import { DEFAULT_STYLE, type Tool, type ToolStyle } from "./lib/tools";
import {
  baseName,
  confirmDiscard,
  fromBrowserFile,
  getStartupFile,
  guardClose,
  isTauri,
  onFileDrop,
  onOpenFiles,
  pickPdf,
  readPath,
  setWindowTitle,
  takeWindowPayload,
  dropTab,
  onAttachTab,
  closeWindowNow,
  type OpenedFile,
} from "./lib/platform";

const APP_NAME = "pdfiiuum";

interface Tab {
  id: string;
  init: TabInit;
}

const TOOL_KEYS: Record<string, Tool> = {
  v: "select",
  h: "hand",
  n: "note",
  r: "highlight",
  u: "underline",
  k: "strikeout",
  t: "text",
  d: "ink",
  // Modo edición: solo en la app de escritorio (necesita PDFium).
  ...(isTauri ? { e: "edittext" as const } : {}),
};

const COMMENTS_PREF = "pdfiiuum.commentsOpen";
const LEFT_OPEN_PREF = "pdfiiuum.leftPanelOpen";
const LEFT_COLLAPSED_PREF = "pdfiiuum.leftPanelCollapsed";
const PEN_DRAWS_PREF = "pdfiiuum.penDraws";

/** Preferencias de este equipo; sin almacenamiento disponible se usa el valor por defecto. */
function readPref(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

function writePref(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    /* sin almacenamiento: solo dura esta sesión */
  }
}

let tabSeq = 0;
const newTabId = () => `t${Date.now().toString(36)}${(tabSeq++).toString(36)}`;

const samePath = (a: string | null, b: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export default function App() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [closing, setClosing] = useState<Set<string>>(new Set());
  const [statuses, setStatuses] = useState<Record<string, TabStatus>>({});
  const [tool, setTool] = useState<Tool>("select");
  const [extensionOpen, setExtensionOpen] = useState(false);
  const closeExtension = useCallback(() => setExtensionOpen(false), []);
  const [toolStyle, setToolStyle] = useState<ToolStyle>(() => ({
    ...DEFAULT_STYLE,
    penDraws: readPref(PEN_DRAWS_PREF, DEFAULT_STYLE.penDraws),
  }));
  useEffect(() => writePref(PEN_DRAWS_PREF, toolStyle.penDraws), [toolStyle.penDraws]);
  const [sidebarOpen, setSidebarOpen] = useState(() => readPref(LEFT_OPEN_PREF, true));
  const [leftCollapsed, setLeftCollapsed] = useState(() => readPref(LEFT_COLLAPSED_PREF, false));
  // «Organizar páginas» trabaja sobre las miniaturas: el panel izquierdo tiene que verse.
  useEffect(() => {
    if (tool !== "pages") return;
    setSidebarOpen(true);
    setLeftCollapsed(false);
  }, [tool]);
  const [commentsOpen, setCommentsOpen] = useState(() => readPref(COMMENTS_PREF, true));
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const handles = useRef(new Map<string, DocTabHandle>());
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const statusesRef = useRef(statuses);
  statusesRef.current = statuses;
  const activeRef = useRef(activeId);
  activeRef.current = activeId;

  const active = activeId ? handles.current.get(activeId) : undefined;
  const status = activeId ? statuses[activeId] : undefined;

  const notify = useCallback((text: string, error = false) => {
    setToast({ text, error });
    setTimeout(() => setToast((t) => (t?.text === text ? null : t)), 4000);
  }, []);

  const copyText = useCallback(
    async (text: string, message: string) => {
      try {
        await navigator.clipboard.writeText(text);
        notify(message);
      } catch {
        notify("No se pudo copiar al portapapeles", true);
      }
    },
    [notify],
  );

  const onStatus = useCallback((id: string, s: TabStatus) => {
    setStatuses((all) => ({ ...all, [id]: s }));
  }, []);

  /** Abre un documento en una pestaña nueva (o activa la que ya lo tiene abierto). */
  const openFile = useCallback(
    async (file: OpenedFile, extra?: Pick<TabInit, "annots" | "view">) => {
      const existing = file.path
        ? tabsRef.current.find((t) => samePath(statusesRef.current[t.id]?.path ?? t.init.path, file.path))
        : undefined;
      if (existing && !extra) {
        setActiveId(existing.id);
        return;
      }
      try {
        // Las anotaciones que ya tiene el PDF pasan a la capa editable.
        const { pdf, baseline } = await openDocument(file.bytes);
        const id = newTabId();
        setTabs((all) => [
          ...all,
          { id, init: { pdf, baseline, bytes: file.bytes, name: file.name, path: file.path, ...extra } },
        ]);
        setActiveId(id);
      } catch (e) {
        notify(`No se pudo abrir «${file.name}»: ${e instanceof Error ? e.message : e}`, true);
      }
    },
    [notify],
  );

  const openPath = useCallback(
    async (path: string, extra?: Pick<TabInit, "annots" | "view">) => {
      try {
        await openFile(await readPath(path), extra);
      } catch (e) {
        notify(`No se pudo leer ${baseName(path)}: ${e}`, true);
      }
    },
    [openFile, notify],
  );

  const handleOpen = useCallback(async () => {
    try {
      const f = await pickPdf();
      if (f) await openFile(f);
    } catch (e) {
      notify(String(e), true);
    }
  }, [openFile, notify]);

  /** Quita la pestaña y activa la vecina. */
  const removeTab = useCallback((id: string) => {
    const list = tabsRef.current;
    const i = list.findIndex((t) => t.id === id);
    if (i < 0) return;
    const rest = list.filter((t) => t.id !== id);
    setTabs(rest);
    setStatuses(({ [id]: _, ...others }) => others);
    handles.current.delete(id);
    if (activeRef.current === id) setActiveId(rest[Math.min(i, rest.length - 1)]?.id ?? null);
  }, []);

  const closeTab = useCallback(
    async (id: string) => {
      const s = statusesRef.current[id];
      if (s?.dirty) {
        setActiveId(id);
        if (!(await confirmDiscard(`«${s.name}» tiene anotaciones sin guardar. ¿Cerrar la pestaña y descartarlas?`))) return;
      }
      // La pestaña se encoge y después desaparece.
      setClosing((c) => new Set(c).add(id));
      setTimeout(() => {
        removeTab(id);
        setClosing((c) => {
          const next = new Set(c);
          next.delete(id);
          return next;
        });
      }, 170);
    },
    [removeTab],
  );

  const moveTab = useCallback((id: string, to: number) => {
    setTabs((all) => {
      const from = all.findIndex((t) => t.id === id);
      if (from < 0 || from === to) return all;
      const next = [...all];
      const [tab] = next.splice(from, 1);
      next.splice(to, 0, tab);
      return next;
    });
  }, []);

  /** Pestaña soltada fuera: pasa a otra ventana o a una nueva; si era la única, esta ventana se cierra. */
  const tearOffTab = useCallback(
    async (id: string) => {
      const snap = handles.current.get(id)?.snapshot();
      if (!snap?.path) return;
      if (snap.edited) {
        notify("Guarda el PDF antes de moverlo a otra ventana: el texto corregido aún no está en el archivo", true);
        return;
      }
      const sole = tabsRef.current.length === 1;
      try {
        const result = await dropTab(snap, sole);
        if (result === "none") return;
        removeTab(id);
        if (sole) await closeWindowNow();
      } catch (e) {
        notify(`No se pudo mover la pestaña: ${e}`, true);
      }
    },
    [notify, removeTab],
  );

  // Arranque: estado traído de otra ventana o PDF del doble clic; archivos soltados
  // y los que envía otra ejecución; aviso al cerrar con cambios sin guardar.
  useEffect(() => {
    (async () => {
      const payload = await takeWindowPayload<TabSnapshot>();
      if (payload?.path) await openPath(payload.path, { annots: payload.annots, view: payload.view });
      else {
        const p = await getStartupFile();
        if (p) await openPath(p);
      }
    })();
    // Los listeners se registran de forma asíncrona: si el efecto se limpia antes de que
    // terminen (React lo monta dos veces en desarrollo), se quitan en cuanto llegan.
    let disposed = false;
    const unlisten: (() => void)[] = [];
    const keep = (p: Promise<() => void>) =>
      p.then((u) => {
        if (disposed) u();
        else unlisten.push(u);
      });
    const openAll = async (paths: string[]) => {
      for (const p of paths) await openPath(p);
    };
    keep(onFileDrop(openAll));
    keep(onOpenFiles(openAll));
    keep(
      onAttachTab<TabSnapshot>((snap) => {
        if (snap.path) openPath(snap.path, { annots: snap.annots, view: snap.view });
      }),
    );
    keep(guardClose(() => Object.values(statusesRef.current).some((s) => s.dirty)));
    return () => {
      disposed = true;
      unlisten.forEach((u) => u());
    };
  }, [openPath]);

  useEffect(() => {
    setWindowTitle(status ? `${status.dirty ? "● " : ""}${status.name} — ${APP_NAME}` : APP_NAME);
  }, [status?.name, status?.dirty]);

  // Menús propios: sin el menú contextual del navegador (Guardar como, Actualizar…)
  // salvo en campos de texto, donde sirve para cortar/pegar.
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("input, textarea")) e.preventDefault();
    };
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, []);

  // Atajos de teclado (actúan sobre la pestaña activa).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const typing = !!(e.target as HTMLElement).closest("input, textarea, [contenteditable]");
      const k = e.key.toLowerCase();
      const tab = activeRef.current ? handles.current.get(activeRef.current) : undefined;
      const go = (fn: () => void) => {
        e.preventDefault();
        fn();
      };
      if (mod && k === "o") go(handleOpen);
      else if (mod && k === "w" && activeRef.current) go(() => closeTab(activeRef.current!));
      else if (mod && k === "tab" && tabsRef.current.length > 1)
        go(() => {
          const list = tabsRef.current;
          const i = list.findIndex((t) => t.id === activeRef.current);
          setActiveId(list[(i + (e.shiftKey ? -1 : 1) + list.length) % list.length].id);
        });
      else if (!tab) return;
      else if (mod && k === "s") go(() => tab.save(e.shiftKey));
      else if (mod && k === "f") go(() => tab.toggleSearch(true));
      else if (mod && (k === "+" || k === "=")) go(tab.zoomIn);
      else if (mod && k === "-") go(tab.zoomOut);
      else if (mod && k === "0") go(() => tab.setScale("page-width"));
      else if (typing) return;
      else if (mod && k === "z") go(e.shiftKey ? tab.redo : tab.undo);
      else if (mod && k === "y") go(tab.redo);
      else if (k === "delete" || k === "backspace") {
        if (tab.deleteSelected()) e.preventDefault();
      } else if (k === "escape") {
        tab.escape();
        setTool("select");
      } else if (!mod && !e.altKey && TOOL_KEYS[k]) setTool(TOOL_KEYS[k]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleOpen, closeTab]);

  // Arrastrar y soltar en modo navegador (en escritorio lo gestiona Tauri).
  const dropProps = isTauri
    ? {}
    : {
        onDragOver: (e: React.DragEvent) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setDragOver(true);
        },
        onDragLeave: () => setDragOver(false),
        onDrop: async (e: React.DragEvent) => {
          e.preventDefault();
          setDragOver(false);
          for (const f of [...e.dataTransfer.files].filter((f) => /\.pdf$/i.test(f.name)))
            await openFile(await fromBrowserFile(f));
        },
      };

  const updateToolStyle = useCallback((fn: (s: ToolStyle) => ToolStyle) => setToolStyle(fn), []);
  const toggleSidebar = useCallback(
    () =>
      setSidebarOpen((v) => {
        writePref(LEFT_OPEN_PREF, !v);
        return !v;
      }),
    [],
  );
  const toggleLeftCollapsed = useCallback(
    () =>
      setLeftCollapsed((v) => {
        writePref(LEFT_COLLAPSED_PREF, !v);
        return !v;
      }),
    [],
  );
  const toggleComments = useCallback(
    () =>
      setCommentsOpen((v) => {
        writePref(COMMENTS_PREF, !v);
        return !v;
      }),
    [],
  );

  return (
    <div className="app" {...dropProps}>
      {tabs.length > 0 && (
        <TabBar
          tabs={tabs.map((t) => ({
            id: t.id,
            name: statuses[t.id]?.name ?? t.init.name,
            dirty: !!statuses[t.id]?.dirty,
            closing: closing.has(t.id),
          }))}
          activeId={activeId}
          canTearOff={isTauri}
          onActivate={setActiveId}
          onClose={closeTab}
          onNew={handleOpen}
          onMove={moveTab}
          onTearOff={tearOffTab}
        />
      )}
      <TopBar
        fileName={null}
        dirty={!!status?.dirty}
        saving={!!status?.saving}
        hasDoc={!!status}
        canUndo={!!status?.canUndo}
        canRedo={!!status?.canRedo}
        page={status?.page ?? 1}
        pageCount={status?.pageCount ?? 0}
        scale={status?.scale ?? 1}
        sidebarOpen={sidebarOpen}
        onOpen={handleOpen}
        onSave={() => active?.save(false)}
        onSaveAs={() => active?.save(true)}
        onUndo={() => active?.undo()}
        onRedo={() => active?.redo()}
        onToggleSidebar={toggleSidebar}
        onPage={(n) => active?.goToPage(n)}
        onZoomIn={() => active?.zoomIn()}
        onZoomOut={() => active?.zoomOut()}
        onScale={(v) => active?.setScale(v)}
        onRotate={() => active?.rotate()}
        onSearch={() => active?.toggleSearch()}
        onBrowserExtension={() => setExtensionOpen(true)}
      />
      {extensionOpen && <ExtensionDialog onClose={closeExtension} notify={notify} copyText={copyText} />}
      <div className="body">
        <ToolRail
          tool={tool}
          style={toolStyle}
          disabled={!status}
          onTool={setTool}
          onStyle={setToolStyle}
          onInsertImage={() => activeId && handles.current.get(activeId)?.insertImage()}
        />
        <div className="docs">
          {tabs.map((t) => (
            <DocTab
              key={t.id}
              id={t.id}
              init={t.init}
              active={t.id === activeId}
              tool={tool}
              toolStyle={toolStyle}
              sidebarOpen={sidebarOpen}
              leftCollapsed={leftCollapsed}
              onToggleLeftCollapsed={toggleLeftCollapsed}
              commentsOpen={commentsOpen}
              onToggleComments={toggleComments}
              ref={(h) => {
                if (h) handles.current.set(t.id, h);
              }}
              setTool={setTool}
              setToolStyle={updateToolStyle}
              notify={notify}
              copyText={copyText}
              onStatus={onStatus}
            />
          ))}
          {tabs.length === 0 && (
            <div className="empty">
              <img src="/icon.png" alt="" className="empty-logo" />
              <h1>{APP_NAME}</h1>
              <p>Abre un documento para empezar</p>
              <button className="primary" onClick={handleOpen}>
                <FolderOpen size={18} strokeWidth={1.75} /> Abrir PDF
              </button>
              <p className="hint">o arrástralo aquí · Ctrl+O</p>
            </div>
          )}
          {dragOver && <div className="drop-overlay">Suelta el PDF para abrirlo</div>}
        </div>
      </div>
      {toast && <div className={`toast${toast.error ? " error" : ""}`}>{toast.text}</div>}
    </div>
  );
}
