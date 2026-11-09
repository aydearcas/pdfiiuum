import { useEffect, useRef, useState } from "react";
import { Printer, X } from "lucide-react";
import { parsePageRange } from "../lib/print";

export interface PrintOptions {
  /** Páginas desde 1. */
  pages: number[];
  /** Imprimir también las anotaciones (resaltados, notas, dibujos y textos). */
  annotations: boolean;
}

interface Props {
  page: number;
  pageCount: number;
  /** Prepara las páginas y abre el diálogo de impresión del sistema. */
  onPrint(opts: PrintOptions, onProgress: (done: number, total: number) => void, signal: AbortSignal): Promise<void>;
  onClose(): void;
}

type Which = "all" | "current" | "range";

/** Qué imprimir; la impresora, las copias y el papel se eligen después, en el diálogo del sistema. */
export default function PrintDialog({ page, pageCount, onPrint, onClose }: Props) {
  const [which, setWhich] = useState<Which>("all");
  const [range, setRange] = useState(`1-${pageCount}`);
  const [annotations, setAnnotations] = useState(true);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const rangeInput = useRef<HTMLInputElement>(null);

  const pages =
    which === "all"
      ? Array.from({ length: pageCount }, (_, i) => i + 1)
      : which === "current"
        ? [page]
        : parsePageRange(range, pageCount);

  const close = () => {
    abort.current?.abort();
    onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const start = async () => {
    if (!pages?.length || progress) return;
    const ctrl = new AbortController();
    abort.current = ctrl;
    setProgress({ done: 0, total: pages.length });
    try {
      await onPrint({ pages, annotations }, (done, total) => setProgress({ done, total }), ctrl.signal);
    } finally {
      abort.current = null;
      if (!ctrl.signal.aborted) onClose();
    }
  };

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <section className="dialog" role="dialog" aria-labelledby="print-title" style={{ width: "min(400px, 100%)" }}>
        <header className="dialog-head">
          <Printer size={18} />
          <h2 id="print-title">Imprimir</h2>
          <button className="mini-btn" title="Cerrar (Esc)" onClick={close}>
            <X size={16} />
          </button>
        </header>
        <form
          className="print-options"
          onSubmit={(e) => {
            e.preventDefault();
            start();
          }}
        >
          <fieldset disabled={!!progress}>
            <legend>Páginas</legend>
            <label>
              <input type="radio" name="which" checked={which === "all"} onChange={() => setWhich("all")} />
              Todas ({pageCount})
            </label>
            <label>
              <input type="radio" name="which" checked={which === "current"} onChange={() => setWhich("current")} />
              Página actual ({page})
            </label>
            <label>
              <input
                type="radio"
                name="which"
                checked={which === "range"}
                onChange={() => {
                  setWhich("range");
                  requestAnimationFrame(() => rangeInput.current?.select());
                }}
              />
              Páginas
              <input
                ref={rangeInput}
                className={`print-range${which === "range" && !pages ? " invalid" : ""}`}
                value={range}
                placeholder="1-3, 5, 8-"
                aria-label="Páginas que se imprimen"
                title="Por ejemplo: 1-3, 5, 8- (de la 8 al final)"
                onFocus={() => setWhich("range")}
                onChange={(e) => setRange(e.target.value)}
              />
            </label>
          </fieldset>
          <fieldset disabled={!!progress}>
            <legend>Contenido</legend>
            <label>
              <input type="checkbox" checked={annotations} onChange={(e) => setAnnotations(e.target.checked)} />
              Imprimir las anotaciones (resaltados, notas, dibujos y textos)
            </label>
          </fieldset>
          <p className="dialog-note" style={{ margin: 0 }}>
            La impresora, las copias, la orientación y el papel se eligen en el siguiente paso.
          </p>
          {progress && (
            <div>
              <span className="dialog-note">
                Preparando página {Math.min(progress.done + 1, progress.total)} de {progress.total}…
              </span>
              <div className="print-progress">
                <div style={{ width: `${(progress.done / progress.total) * 100}%` }} />
              </div>
            </div>
          )}
          <footer className="dialog-foot">
            <button type="button" className="btn" onClick={close}>
              Cancelar
            </button>
            <button type="submit" className="btn primary" disabled={!pages?.length || !!progress}>
              <Printer size={14} /> Imprimir{pages && pages.length !== pageCount ? ` ${pages.length} pág.` : ""}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
