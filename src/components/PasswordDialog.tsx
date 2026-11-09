import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff, LockKeyhole, X } from "lucide-react";

interface Props {
  name?: string;
  /** La contraseña anterior no era correcta. */
  retry: boolean;
  onDone(password: string | null): void;
}

/** Pide la contraseña de un PDF cifrado. Solo se recuerda mientras la app está abierta. */
export default function PasswordDialog({ name, retry, onDone }: Props) {
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onDone(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onDone]);

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onDone(null)}>
      <section className="dialog" role="dialog" aria-labelledby="pw-title" style={{ width: "min(400px, 100%)" }}>
        <header className="dialog-head">
          <LockKeyhole size={18} />
          <h2 id="pw-title">PDF protegido</h2>
          <button className="mini-btn" title="Cancelar (Esc)" onClick={() => onDone(null)}>
            <X size={16} />
          </button>
        </header>
        <form
          className="password-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (password) onDone(password);
          }}
        >
          <p className="dialog-intro">
            {name ? (
              <>
                «<strong>{name}</strong>» está protegido con contraseña.
              </>
            ) : (
              "Este PDF está protegido con contraseña."
            )}{" "}
            Escríbela para abrirlo.
          </p>
          <div className="password-field">
            <input
              ref={input}
              type={visible ? "text" : "password"}
              value={password}
              autoComplete="off"
              spellCheck={false}
              aria-label="Contraseña"
              aria-invalid={retry}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button
              type="button"
              className="mini-btn"
              title={visible ? "Ocultar" : "Mostrar"}
              onClick={() => {
                setVisible((v) => !v);
                input.current?.focus();
              }}
            >
              {visible ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
          {retry && <p className="dialog-error">La contraseña no es correcta. Prueba otra vez.</p>}
          <p className="dialog-note">
            Al guardar, el PDF sigue protegido con la misma contraseña. pdfiiuum la recuerda solo mientras está
            abierto.
          </p>
          <footer className="dialog-foot">
            <button type="button" className="btn" onClick={() => onDone(null)}>
              Cancelar
            </button>
            <button type="submit" className="btn primary" disabled={!password}>
              Abrir
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
