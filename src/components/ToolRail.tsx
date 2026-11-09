import { useEffect, useState } from "react";
import {
  Eraser,
  Files,
  Hand,
  Highlighter,
  ImagePlus,
  Images,
  LetterText,
  MessageSquarePlus,
  MousePointer2,
  PenLine,
  Signature as SignatureIcon,
  Strikethrough,
  TextCursorInput,
  Type,
  Underline,
} from "lucide-react";
import IconButton from "./IconButton";
import { FONT_SIZES, INK_WIDTHS, paletteFor, type AnnotKind } from "../lib/annotations";
import { hasPdfium } from "../lib/platform";
import { EDIT_FONTS } from "../lib/edit";
import { isEditTool, type EditTool, type Tool, type ToolStyle } from "../lib/tools";
import { setSignature, useSignature } from "../lib/signature";
import { smoothPathD } from "../lib/ink";

interface Props {
  tool: Tool;
  style: ToolStyle;
  disabled: boolean;
  onTool(tool: Tool): void;
  onStyle(style: ToolStyle): void;
  onInsertImage(): void;
  /** Elige la herramienta Firmar (o pide dibujar la firma si aún no hay ninguna). */
  onSign(): void;
  /** Dibujar otra firma. */
  onEditSignature(): void;
}

const ANNOT_TOOLS: { tool: AnnotKind; icon: typeof Hand; label: string }[] = [
  { tool: "note", icon: MessageSquarePlus, label: "Comentario (N)" },
  { tool: "highlight", icon: Highlighter, label: "Resaltar (R)" },
  { tool: "underline", icon: Underline, label: "Subrayar (U)" },
  { tool: "strikeout", icon: Strikethrough, label: "Tachar (K)" },
  { tool: "text", icon: Type, label: "Insertar texto (T)" },
  { tool: "ink", icon: PenLine, label: "Dibujar (D)" },
];

const EDIT_TOOLS: { tool: EditTool; icon: typeof Hand; label: string }[] = [
  { tool: "edittext", icon: TextCursorInput, label: "Corregir texto del PDF (E)" },
  { tool: "addtext", icon: LetterText, label: "Añadir texto al PDF" },
  { tool: "objects", icon: Images, label: "Mover, cambiar tamaño o borrar imágenes" },
  { tool: "cover", icon: Eraser, label: "Tapar una zona" },
  { tool: "pages", icon: Files, label: "Organizar páginas" },
];

export default function ToolRail(p: Props) {
  const { tool, style, disabled, onTool, onStyle, onInsertImage } = p;
  const [optionsOpen, setOptionsOpen] = useState(false);
  const signature = useSignature();
  // El texto añadido al PDF usa el color y el tamaño de la herramienta de texto.
  const annotTool =
    tool === "addtext" ? "text" : tool !== "select" && tool !== "hand" && tool !== "sign" && !isEditTool(tool) ? tool : null;

  useEffect(() => {
    if (!optionsOpen) return;
    const close = () => setOptionsOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [optionsOpen]);

  useEffect(() => setOptionsOpen(false), [tool]);

  return (
    <nav className="toolrail">
      <IconButton icon={MousePointer2} label="Seleccionar (V)" active={tool === "select"} onClick={() => onTool("select")} />
      <IconButton icon={Hand} label="Mano (H)" active={tool === "hand"} onClick={() => onTool("hand")} />
      <span className="divider horizontal" />
      {ANNOT_TOOLS.map((t) => (
        <IconButton
          key={t.tool}
          icon={t.icon}
          label={t.label}
          active={tool === t.tool}
          disabled={disabled}
          onClick={() => onTool(tool === t.tool ? "select" : t.tool)}
        />
      ))}
      <IconButton icon={SignatureIcon} label="Firmar (F)" active={tool === "sign"} disabled={disabled} onClick={p.onSign} />

      {/* Modo edición: cambia el contenido del PDF, no son anotaciones. */}
      {hasPdfium && (
        <div className="tool-group inverted" aria-label="Edición del PDF">
          {EDIT_TOOLS.map((t) => (
            <IconButton
              key={t.tool}
              icon={t.icon}
              label={t.label}
              active={tool === t.tool}
              disabled={disabled}
              onClick={() => onTool(tool === t.tool ? "select" : t.tool)}
            />
          ))}
          <IconButton icon={ImagePlus} label="Insertar imagen en la página" disabled={disabled} onClick={onInsertImage} />
        </div>
      )}

      {tool === "sign" && signature && (
        <div className="tool-options-anchor">
          <span className="divider horizontal" />
          <button
            className="color-btn"
            aria-label="Firma guardada"
            data-tip="Firma guardada"
            onClick={(e) => {
              e.stopPropagation();
              setOptionsOpen((v) => !v);
            }}
          >
            <span style={{ background: signature.color }} />
          </button>
          {optionsOpen && (
            <div className="tool-options sign-options" onClick={(e) => e.stopPropagation()}>
              {/* smoothPathD redondea a décimas: la firma (de alto 1) se dibuja a escala 100. */}
              <svg className="sign-preview" viewBox={`-10 -10 ${signature.aspect * 100 + 20} 120`} aria-label="Tu firma">
                {signature.strokes.map((s, i) => (
                  <path
                    key={i}
                    className="ink"
                    d={smoothPathD(s.map(([x, y]) => [x * 100, y * 100]))}
                    stroke={signature.color}
                    strokeWidth={signature.width * 100}
                  />
                ))}
              </svg>
              <span className="option-hint">Haz clic en la página para colocarla</span>
              <div className="option-row">
                <button className="chip" onClick={p.onEditSignature}>
                  Dibujar otra
                </button>
                <button
                  className="chip"
                  onClick={() => {
                    setSignature(null);
                    onTool("select");
                  }}
                >
                  Olvidar firma
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {annotTool && (
        <div className="tool-options-anchor">
          <span className="divider horizontal" />
          <button
            className="color-btn"
            aria-label="Color y estilo"
            data-tip="Color y estilo"
            onClick={(e) => {
              e.stopPropagation();
              setOptionsOpen((v) => !v);
            }}
          >
            <span style={{ background: style.colors[annotTool] }} />
          </button>
          {optionsOpen && (
            <div className="tool-options" onClick={(e) => e.stopPropagation()}>
              <div className="swatches">
                {paletteFor(annotTool).map((c) => (
                  <button
                    key={c}
                    className={`swatch${style.colors[annotTool] === c ? " active" : ""}`}
                    style={{ background: c }}
                    aria-label={c}
                    onClick={() => onStyle({ ...style, colors: { ...style.colors, [annotTool]: c } })}
                  />
                ))}
              </div>
              {annotTool === "text" && (
                <div className="option-row">
                  <span>Tamaño</span>
                  {FONT_SIZES.map((s) => (
                    <button
                      key={s}
                      className={`chip${style.fontSize === s ? " active" : ""}`}
                      onClick={() => onStyle({ ...style, fontSize: s })}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
              {annotTool === "ink" && (
                <div className="option-row">
                  <span>Grosor</span>
                  {INK_WIDTHS.map((w) => (
                    <button
                      key={w}
                      className={`chip${style.inkWidth === w ? " active" : ""}`}
                      onClick={() => onStyle({ ...style, inkWidth: w })}
                    >
                      <span className="stroke-sample" style={{ height: Math.max(1, w) }} />
                    </button>
                  ))}
                </div>
              )}
              {tool === "addtext" && (
                <div className="option-row">
                  <span>Tipografía</span>
                  {EDIT_FONTS.map((f) => (
                    <button
                      key={f.font}
                      className={`chip${style.editFont === f.font ? " active" : ""}`}
                      style={{ fontFamily: f.css }}
                      onClick={() => onStyle({ ...style, editFont: f.font })}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              )}
              {annotTool === "ink" && (
                <label className="option-check" title="Con el lápiz digital se dibuja aunque esté elegida otra herramienta">
                  <input
                    type="checkbox"
                    checked={style.penDraws}
                    onChange={(e) => onStyle({ ...style, penDraws: e.target.checked })}
                  />
                  El lápiz dibuja siempre
                </label>
              )}
            </div>
          )}
        </div>
      )}
    </nav>
  );
}
