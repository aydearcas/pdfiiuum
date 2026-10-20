import { Highlighter, MessageSquareText, PanelRightClose, PanelRightOpen, Strikethrough, Underline } from "lucide-react";
import { KIND_LABEL, formatPdfDate, type AnnotKind, type Rect } from "../lib/annotations";

export interface PanelItem {
  key: string;
  page: number;
  kind: AnnotKind;
  color: string;
  author: string;
  date: string;
  quote: string;
  contents: string;
  rect: Rect;
  /** Anotación aún sin guardar (se puede seleccionar y editar). */
  pending: boolean;
}

interface Props {
  open: boolean;
  items: PanelItem[];
  loading: boolean;
  selectedKey: string | null;
  onToggle(): void;
  onPick(item: PanelItem): void;
}

const ICONS: Partial<Record<AnnotKind, typeof Highlighter>> = {
  note: MessageSquareText,
  highlight: Highlighter,
  underline: Underline,
  strikeout: Strikethrough,
};

/** Orden de lectura: página, de arriba abajo y de izquierda a derecha. */
export function sortItems(items: PanelItem[]): PanelItem[] {
  return [...items].sort((a, b) => a.page - b.page || b.rect[3] - a.rect[3] || a.rect[0] - b.rect[0]);
}

export default function CommentsPanel({ open, items, loading, selectedKey, onToggle, onPick }: Props) {
  if (!open) {
    return (
      <aside className="comments-panel collapsed">
        <button className="icon-btn" aria-label="Mostrar comentarios" data-tip="Comentarios" onClick={onToggle}>
          <PanelRightOpen size={18} strokeWidth={1.75} />
        </button>
        {items.length > 0 && <span className="comments-count">{items.length}</span>}
      </aside>
    );
  }

  let lastPage = 0;
  return (
    <aside className="comments-panel">
      <header className="comments-head">
        <MessageSquareText size={16} strokeWidth={1.75} />
        <span>Comentarios</span>
        <span className="comments-count">{items.length}</span>
        <span className="spacer" />
        <button className="mini-btn" title="Ocultar panel" onClick={onToggle}>
          <PanelRightClose size={16} />
        </button>
      </header>
      <div className="comments-list">
        {items.length === 0 && (
          <p className="comments-empty">
            {loading ? "Buscando comentarios…" : "No hay comentarios ni resaltados en este documento."}
          </p>
        )}
        {items.map((it) => {
          const Icon = ICONS[it.kind] ?? MessageSquareText;
          const pageHeader = it.page !== lastPage ? <h4 className="comments-page">Página {it.page}</h4> : null;
          lastPage = it.page;
          return (
            <div key={it.key}>
              {pageHeader}
              <button
                className={`comment-item${it.key === selectedKey ? " selected" : ""}`}
                style={{ borderLeftColor: it.color }}
                onClick={() => onPick(it)}
              >
                <div className="comment-meta">
                  <Icon size={14} strokeWidth={1.75} style={{ color: it.color }} />
                  <span className="comment-author">{it.author || "Sin autor"}</span>
                  <span className="comment-date">{formatPdfDate(it.date)}</span>
                </div>
                {it.quote && <blockquote>{it.quote}</blockquote>}
                {it.contents ? (
                  <p className="comment-text">{it.contents}</p>
                ) : (
                  !it.quote && <p className="comment-text muted">{KIND_LABEL[it.kind]} sin texto</p>
                )}
                {it.pending && <span className="comment-pending">Sin guardar</span>}
              </button>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
