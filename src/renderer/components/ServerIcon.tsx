import { Plug } from "lucide-react";
import { useId, type JSX } from "react";
import { serverIconFor } from "../lib/serverIcons.js";

// A filled globe rather than Lucide's stroked one: the marks beside it are
// solid badges, and a hairline circle reads as a lighter class of thing. The
// grid is masked out of the disc rather than painted, so the row background
// shows through and the mark is right on any surface. The two latitudes are
// what make it a globe: with only the meridian and the equator, a filled disc
// reads as a theta.
const GLOBE_GRID = [
  "M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20",
  "M2.6 12h18.8",
  "M4.5 7.4h15",
  "M4.5 16.6h15"
];

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
  const maskId = useId();
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
          <mask id={maskId}>
            <rect width="24" height="24" fill="white" />
            <g fill="none" stroke="black" strokeWidth="2.4" strokeLinecap="round">
              {GLOBE_GRID.map((d) => (
                <path key={d} d={d} />
              ))}
            </g>
          </mask>
          <circle cx="12" cy="12" r="10" fill="currentColor" mask={`url(#${maskId})`} />
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
