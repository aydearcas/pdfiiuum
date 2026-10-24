import { useEffect, useState } from "react";
import {
  Eraser,
  Hand,
  Highlighter,
  ImagePlus,
  Images,
  LetterText,
  MessageSquarePlus,
  MousePointer2,
  PenLine,
  Strikethrough,
  TextCursorInput,
  Type,
  Underline,
} from "lucide-react";
import IconButton from "./IconButton";
import { FONT_SIZES, INK_WIDTHS, paletteFor, type AnnotKind } from "../lib/annotations";
import { isTauri } from "../lib/platform";
import { EDIT_FONTS } from "../lib/edit";
import { isEditTool, type EditTool, type Tool, type ToolStyle } from "../lib/tools";

interface Props {
  tool: Tool;
  style: ToolStyle;
  disabled: boolean;
  onTool(tool: Tool): void;
  onStyle(style: ToolStyle): void;
  onInsertImage(): void;
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
];

export default function ToolRail({ tool, style, disabled, onTool, onStyle, onInsertImage }: Props) {
  const [optionsOpen, setOptionsOpen] = useState(false);
  // El texto añadido al PDF usa el color y el tamaño de la herramienta de texto.
  const annotTool = tool === "addtext" ? "text" : tool !== "select" && tool !== "hand" && !isEditTool(tool) ? tool : null;

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

      {/* Modo edición: cambia el contenido del PDF, no son anotaciones. */}
      {isTauri && (
        <>
          <span className="divider horizontal" />
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
        </>
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
