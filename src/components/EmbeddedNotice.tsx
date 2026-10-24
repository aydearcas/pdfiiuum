import { ExternalLink } from "lucide-react";

/** Lo único que muestra el visor cuando otra página lo incrusta: un enlace para abrirlo en su pestaña. */
export default function EmbeddedNotice() {
  return (
    <div className="empty">
      <img src={`${import.meta.env.BASE_URL}icon.png`} alt="" className="empty-logo" />
      <h1>pdfiiuum</h1>
      <p>Este PDF está incrustado en otra página.</p>
      <a className="primary" href={location.href} target="_blank" rel="noopener noreferrer">
        <ExternalLink size={18} strokeWidth={1.75} /> Abrir en una pestaña
      </a>
    </div>
  );
}
