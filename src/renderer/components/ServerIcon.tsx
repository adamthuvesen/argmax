import { Globe, Plug } from "lucide-react";
import type { JSX } from "react";
import { serverIconFor } from "../lib/serverIcons.js";

/**
 * Leading mark on a tool row: the server's brand mark in its own colours, a
 * globe for anything that reaches the web, or a plug for an MCP server no mark
 * is wired up for. Rows that are none of those get nothing. The row text names
 * the server and the action, so the mark is a recognition aid rather than the
 * only label.
 */
export function ServerIcon({
  server,
  web = false
}: {
  server: string | null;
  web?: boolean;
}): JSX.Element | null {
  const icon = server ? serverIconFor(server) : null;
  if (!icon) {
    // A brand mark still wins for a browser server that has one. Otherwise the
    // web gets a globe rather than the plug: the built-in search and fetch
    // carry no server at all, and a plug would say "some MCP server" about a
    // row that is plainly a web request.
    // Labelled, not hidden, like the brand marks: it is the only thing on a
    // browser-MCP row that says "the web" when the server name does not.
    if (web)
      return (
        <Globe size={12} className="tool-call-row-server-icon" role="img" aria-label="Web" />
      );
    if (!server) return null;
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
