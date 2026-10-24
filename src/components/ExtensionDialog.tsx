import { useEffect, useState } from "react";
import { Copy, FolderOpen, Puzzle, X } from "lucide-react";
import { extensionInfo, openBrowserExtensions, openExtensionFolder, type ExtensionInfo } from "../lib/platform";

interface Props {
  onClose(): void;
  notify(text: string, error?: boolean): void;
  copyText(text: string, message: string): void;
}

/**
 * Guía para instalar la extensión «Abrir en pdfiiuum». Chrome, Edge y Brave no dejan que un
 * programa instale extensiones de fuera de su tienda: hay que cargarla a mano, y aquí se
 * abren la página de extensiones y la carpeta para que sean dos clics.
 */
export default function ExtensionDialog({ onClose, notify, copyText }: Props) {
  const [info, setInfo] = useState<ExtensionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    extensionInfo()
      .then(setInfo)
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const run = (action: Promise<void>) => action.catch((e) => notify(String(e), true));

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="dialog" role="dialog" aria-labelledby="ext-title">
        <header className="dialog-head">
          <Puzzle size={18} />
          <h2 id="ext-title">Extensión para el navegador</h2>
          <button className="mini-btn" title="Cerrar (Esc)" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <p className="dialog-intro">
          Añade a Chrome, Edge o Brave el botón <strong>Abrir en pdfiiuum</strong>: el PDF que estés viendo (o el de
          un enlace) se guarda en Descargas y se abre aquí. Los navegadores no dejan instalarla automáticamente; son
          tres pasos y solo hay que hacerlos una vez.
        </p>
        {error && <p className="dialog-error">{error}</p>}
        <ol className="dialog-steps">
          <li>
            <span>Abre la página de extensiones del navegador.</span>
            <div className="dialog-actions">
              {info?.browsers.map((b) => (
                <button key={b.id} className="btn" onClick={() => run(openBrowserExtensions(b.id))}>
                  Abrir en {b.name}
                </button>
              ))}
              {info && !info.browsers.length && (
                <span className="dialog-note">
                  No se ha encontrado Chrome, Edge ni Brave. Escribe <code>chrome://extensions</code> en la barra de
                  direcciones.
                </span>
              )}
            </div>
          </li>
          <li>
            <span>
              Activa <strong>Modo de desarrollador</strong> (en Chrome, arriba a la derecha; en Edge, en el menú de la
              izquierda).
            </span>
          </li>
          <li>
            <span>
              Pulsa <strong>Cargar descomprimida</strong> y elige esta carpeta (puedes pegar la ruta en la barra del
              cuadro de diálogo, o arrastrar la carpeta a la página de extensiones):
            </span>
            {info && (
              <>
                <code className="dialog-path">{info.folder}</code>
                <div className="dialog-actions">
                  <button className="btn" onClick={() => copyText(info.folder, "Ruta copiada")}>
                    <Copy size={14} /> Copiar ruta
                  </button>
                  <button className="btn" onClick={() => run(openExtensionFolder())}>
                    <FolderOpen size={14} /> Abrir carpeta
                  </button>
                </div>
              </>
            )}
          </li>
        </ol>
        <p className="dialog-note">
          Para abrir también PDF de tu equipo, entra en <strong>Detalles</strong> de la extensión y activa{" "}
          <strong>Permitir el acceso a las URL de archivo</strong>.
        </p>
        <footer className="dialog-foot">
          <button className="btn primary" onClick={onClose}>
            Hecho
          </button>
        </footer>
      </section>
    </div>
  );
}
