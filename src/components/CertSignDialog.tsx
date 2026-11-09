import { useCallback, useEffect, useState } from "react";
import { CreditCard, FileBadge, RefreshCw, X } from "lucide-react";
import { listCertificates, type CertInfo } from "../lib/platform";

interface Props {
  onSign(cert: CertInfo, visible: boolean): void;
  onClose(): void;
}

const LAST_CERT = "pdfiiuum.cert";
const VISIBLE = "pdfiiuum.certVisible";

function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* sin almacenamiento: solo no se recuerda */
  }
}

const fmtDate = (ms: number) => new Date(ms).toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "numeric" });

/** Elige el certificado de Windows con el que firmar y si la firma se ve en la página. */
export default function CertSignDialog({ onSign, onClose }: Props) {
  const [certs, setCerts] = useState<CertInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [visible, setVisible] = useState(load(VISIBLE) !== "0");

  const refresh = useCallback(async () => {
    setCerts(null);
    setError(null);
    try {
      const list = await listCertificates();
      setCerts(list);
      const now = Date.now();
      const usable = list.filter((c) => c.validTo > now && c.validFrom <= now);
      // El último que se usó, o el primero de firma que siga vigente.
      setChosen((cur) => {
        const keep = cur ?? load(LAST_CERT);
        return usable.find((c) => c.id === keep)?.id ?? usable[0]?.id ?? null;
      });
    } catch (e) {
      setCerts([]);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

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

  const cert = certs?.find((c) => c.id === chosen) ?? null;
  const sign = () => {
    if (!cert) return;
    store(LAST_CERT, cert.id);
    store(VISIBLE, visible ? "1" : "0");
    onSign(cert, visible);
  };
  const now = Date.now();

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="dialog" role="dialog" aria-labelledby="cert-title" style={{ width: "min(520px, 100%)" }}>
        <header className="dialog-head">
          <FileBadge size={18} />
          <h2 id="cert-title">Firmar con certificado</h2>
          <button className="mini-btn" title="Cerrar (Esc)" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <p className="dialog-intro">
          Firma digital con tu certificado (FNMT, DNIe…), válida ante la Administración. El PDF firmado se guarda
          como un archivo nuevo.
        </p>

        <div className="cert-list" role="radiogroup" aria-label="Certificados">
          {certs === null && <p className="cert-empty">Buscando certificados…</p>}
          {certs?.length === 0 && (
            <div className="cert-empty">
              {error ? (
                <p className="dialog-error">{error}</p>
              ) : (
                <>
                  <p>No hay ningún certificado para firmar en Windows.</p>
                  <ul>
                    <li>Con el DNIe o una tarjeta: métela en el lector y pulsa «Buscar otra vez».</li>
                    <li>Con el certificado de la FNMT en un archivo (.p12 o .pfx): ábrelo con doble clic para instalarlo.</li>
                  </ul>
                </>
              )}
            </div>
          )}
          {certs?.map((c) => {
            const expired = c.validTo <= now;
            const early = c.validFrom > now;
            return (
              <button
                key={c.id}
                role="radio"
                aria-checked={c.id === chosen}
                className={`cert-item${c.id === chosen ? " active" : ""}`}
                disabled={expired || early}
                onClick={() => setChosen(c.id)}
                onDoubleClick={() => c.id === chosen && sign()}
              >
                <span className="cert-name">{c.name}</span>
                <span className="cert-meta">
                  {c.issuer} ·{" "}
                  {expired ? (
                    <em className="cert-expired">caducó el {fmtDate(c.validTo)}</em>
                  ) : early ? (
                    <em className="cert-expired">válido desde el {fmtDate(c.validFrom)}</em>
                  ) : (
                    `válido hasta el ${fmtDate(c.validTo)}`
                  )}
                </span>
                <span className="cert-tags">
                  {c.signing && <span className="cert-tag">Firma</span>}
                  {c.card && (
                    <span className="cert-tag">
                      <CreditCard size={11} /> Tarjeta
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>

        <div className="cert-options">
          <label className="check">
            <input type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} />
            Mostrar la firma en la página (eliges dónde)
          </label>
          <button className="btn" onClick={refresh} disabled={certs === null} title="Volver a leer los certificados de Windows">
            <RefreshCw size={14} /> Buscar otra vez
          </button>
        </div>
        <p className="dialog-note">
          Si el certificado tiene PIN o contraseña, Windows te la pedirá al firmar. Después de firmar, puedes seguir
          anotando: los cambios se guardan detrás de la firma sin invalidarla.
        </p>
        <footer className="dialog-foot">
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className="btn primary" disabled={!cert} onClick={sign}>
            {visible ? "Colocar la firma" : "Firmar"}
          </button>
        </footer>
      </section>
    </div>
  );
}
