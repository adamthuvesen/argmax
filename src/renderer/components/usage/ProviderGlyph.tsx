import type { JSX } from "react";
import type { ProviderId } from "../../../shared/types.js";

/**
 * A per-provider mark for the Usage page's rows and tables. Nothing else in
 * the app draws providers as pictures — the sidebar and the pickers name them
 * in words — so these are Argmax's own shorthand rather than vendor logos:
 * one stroke weight, one 16px box, drawn in `currentColor` so the row's ink
 * decides how loud they are. Identity is carried by the coloured dot and the
 * name beside them; the glyph is the third, redundant channel.
 */
const PATHS: Record<ProviderId, JSX.Element> = {
  // Claude — a radiating burst, for the model that fans out.
  claude: (
    <>
      <path d="M8 2.4v11.2" />
      <path d="M3.15 5.2l9.7 5.6" />
      <path d="M3.15 10.8l9.7-5.6" />
    </>
  ),
  // Codex — a closed hexagon: the compiled, sealed one.
  codex: <path d="M8 2.6l4.7 2.7v5.4L8 13.4l-4.7-2.7V5.3z" />,
  // Cursor — a pointer.
  cursor: <path d="M4 2.6l7.6 5.1-3.3.8-1.4 3.2z" />,
  // OpenCode — a terminal prompt.
  opencode: (
    <>
      <path d="M3.4 4.6L6.6 8l-3.2 3.4" />
      <path d="M8.4 11.6h4.2" />
    </>
  ),
  // Grok — a slanted cross.
  grok: (
    <>
      <path d="M3.6 3.2l8.8 9.6" />
      <path d="M12.4 3.2l-8.8 9.6" />
    </>
  )
};

export function ProviderGlyph({ provider }: { provider: ProviderId }): JSX.Element {
  return (
    <svg
      className="usage-provider-glyph"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[provider]}
    </svg>
  );
}
