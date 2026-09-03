import { Plug } from "lucide-react";
import type { JSX } from "react";
import { serverIconFor } from "../lib/serverIcons.js";

// A filled globe rather than Lucide's stroked one: the marks beside it are
// solid badges, and a hairline circle reads as a lighter class of thing. The
// grid lines are holes rather than painted strokes, so the row background
// shows through and the mark stays right on any surface.
const WEB_GLOBE =
  "M2 12a10 10 0 1 0 20 0 10 10 0 1 0-20 0Z" +
  "M2.1 11.05h19.8v1.9H2.1Z" +
  "M12 2.1a5 9.9 0 1 0 0 19.8 5 9.9 0 1 0 0-19.8Z" +
  "M12 4a3.1 7.9 0 1 0 0 15.8 3.1 7.9 0 1 0 0-15.8Z";

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
        <svg
          className="tool-call-row-server-icon"
          viewBox="0 0 24 24"
          width={12}
          height={12}
          role="img"
          aria-label="Web"
        >
          <path fill="currentColor" fillRule="evenodd" d={WEB_GLOBE} />
        </svg>
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
