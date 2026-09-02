import { Plug } from "lucide-react";
import type { CSSProperties, JSX } from "react";
import { serverIconFor } from "../lib/serverIcons.js";

type BrandStyle = CSSProperties & { "--brand"?: string };

/**
 * Leading mark on an MCP tool row: the server's brand mark, tinted a step
 * toward the row's grey so hue carries the signal without shouting, or a plug
 * for a server no mark is wired up for. The server's name stays in the row
 * text, so the mark is a recognition aid rather than the only label.
 */
export function ServerIcon({ server }: { server: string }): JSX.Element {
  const icon = serverIconFor(server);
  if (!icon) {
    return <Plug size={12} className="tool-call-row-server-icon" aria-hidden="true" />;
  }
  return (
    <svg
      className="tool-call-row-server-icon"
      viewBox="0 0 24 24"
      width={12}
      height={12}
      role="img"
      aria-label={icon.title}
      style={icon.hex ? ({ "--brand": `#${icon.hex}` } as BrandStyle) : undefined}
    >
      <path d={icon.path} />
    </svg>
  );
}
