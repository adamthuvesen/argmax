import type { Root, RootContent } from "mdast";
import type { VFile } from "vfile";

export const VISUALIZATION_START = "\uE200visualize\uE202";
const VISUALIZATION_END = "\uE201";

export type VisualizationReference = { path: string; mode?: "wide"; title?: string };

export function parseVisualizationReference(source: string): VisualizationReference {
  const value: unknown = JSON.parse(source);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Visualization reference must be an object.");
  }
  const reference = value as Record<string, unknown>;
  if (Object.keys(reference).some((key) => !["path", "mode", "title"].includes(key))) {
    throw new Error("Visualization reference contains an unknown field.");
  }
  if (typeof reference.path !== "string" || !/^(?:\/|[A-Za-z]:[\\/])/.test(reference.path) ||
      !/\.html?$/i.test(reference.path) || Array.from(reference.path).some((character) => character.charCodeAt(0) < 32)) {
    throw new Error("Visualization path must name an absolute HTML file.");
  }
  if (reference.mode !== undefined && reference.mode !== "wide") {
    throw new Error("Visualization mode must be wide or omitted.");
  }
  if (reference.title !== undefined && (typeof reference.title !== "string" || reference.title.length > 250)) {
    throw new Error("Visualization title must be text of at most 250 characters.");
  }
  return { path: reference.path, mode: reference.mode, title: reference.title };
}

// Use source offsets so Markdown punctuation inside a file path stays literal.
// Code nodes are never visited as paragraphs, so documented markers stay code.
export function remarkVisualizationReferences(): (tree: Root, file: VFile) => void {
  return (tree, file) => {
    const source = String(file.value);
    function visit(node: Root | RootContent): void {
      if (node.type === "paragraph") {
        const text = source.slice(node.position?.start.offset, node.position?.end.offset).trim();
        if (!text.startsWith(VISUALIZATION_START)) return;
        const properties: Record<string, string> = { "data-visualization": "pending" };
        if (text.endsWith(VISUALIZATION_END)) {
          try {
            const reference = parseVisualizationReference(text.slice(VISUALIZATION_START.length, -1));
            properties["data-visualization"] = "ready";
            properties["data-path"] = reference.path;
            if (reference.mode) properties["data-mode"] = reference.mode;
            if (reference.title) properties["data-title"] = reference.title;
          } catch (error) {
            properties["data-visualization"] = "error";
            properties["data-error"] = error instanceof SyntaxError
              ? "Visualization reference contains invalid JSON."
              : error instanceof Error ? error.message : "Invalid visualization reference.";
          }
        }
        node.children = [];
        node.data = { hName: "div", hProperties: properties };
        return;
      }
      if ("children" in node) {
        for (const child of node.children) visit(child);
      }
    }
    visit(tree);
  };
}
