import type { AnnotKind, MarkupKind } from "./annotations";

export type Tool = "select" | "hand" | AnnotKind;

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
