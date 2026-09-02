import { Plug } from "lucide-react";
import type { JSX } from "react";
import { serverIconFor } from "../lib/serverIcons.js";

/**
 * Leading mark on an MCP tool row: the server's brand mark in its own
 * colours, or a plug for a server no mark is wired up for. The server's name
 * stays in the row text, so the mark is a recognition aid rather than the
 * only label.
 */
export function ServerIcon({ server }: { server: string }): JSX.Element {
  const icon = serverIconFor(server);
  if (!icon) {
    return <Plug size={12} className="tool-call-row-server-icon" aria-hidden="true" />;
  }
  return (
    <svg
      className="tool-call-row-server-icon"
      viewBox={icon.viewBox}
      width={12}
      height={12}
      role="img"
      aria-label={icon.title}
      shapeRendering={icon.title === "Argmax" ? "crispEdges" : undefined}
    >
      {/* A style fill, not the attribute: the mascot's layers are theme tokens,
          and a presentation attribute cannot hold a var(). */}
      {icon.layers.map((layer, index) => (
        <path key={index} d={layer.path} style={{ fill: layer.fill ?? "currentColor" }} />
      ))}
    </svg>
  );
}
