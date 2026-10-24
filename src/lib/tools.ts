import type { AnnotKind, MarkupKind } from "./annotations";

/** Herramientas del modo edición (cambian el contenido del PDF; solo en escritorio). */
export type EditTool = "edittext";
export type Tool = "select" | "hand" | AnnotKind | EditTool;

export const isEditTool = (t: Tool): t is EditTool => t === "edittext";

export const MARKUP_TOOLS: MarkupKind[] = ["highlight", "underline", "strikeout"];

export const isMarkupTool = (t: Tool): t is MarkupKind => (MARKUP_TOOLS as Tool[]).includes(t);

export interface ToolStyle {
  colors: Record<AnnotKind, string>;
  fontSize: number;
  inkWidth: number;
  /** El lápiz digital dibuja con cualquier herramienta (como en OneNote). */
  penDraws: boolean;
}

export const DEFAULT_STYLE: ToolStyle = {
  colors: {
    highlight: "#ffd400",
    underline: "#13a35a",
    strikeout: "#e2231a",
    note: "#ffd400",
    text: "#111111",
    ink: "#e2231a",
  },
  fontSize: 14,
  inkWidth: 2,
  penDraws: true,
};
