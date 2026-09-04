import type { JSX } from "react";
import { EMBLEM_PATHS, type EmblemHue, type EmblemShape } from "../lib/agentEmblems.js";

/**
 * A subagent's emblem: the shape its codename owns, in that codename's hue.
 *
 * The bevel is three passes over the same path — the rim dropped 0.75 below the
 * face, the face in place, and a light sheet scaled about the centre and nudged
 * up-left. That is deliberately not a gradient: one emblem shows up in the
 * launch row, the dock tab, the pane masthead and the workspace card at the same
 * time, and a `<defs>` gradient carries an id every one of those copies would
 * have to share. Geometry rides SVG attributes, colour rides
 * `styles/agent-emblems.css`.
 *
 * Decorative on purpose: the codename beside it is the accessible name, so the
 * mark carries no label of its own. Status never touches the hue — a failed
 * agent keeps its shape and greys, with a rose corner dot for the state.
 */
export function AgentEmblem({
  shape,
  hue,
  size = 14,
  status
}: {
  shape: EmblemShape;
  hue: EmblemHue;
  size?: number;
  status?: "done" | "error";
}): JSX.Element {
  const { d, evenOdd } = EMBLEM_PATHS[shape];
  const fillRule = evenOdd ? "evenodd" : undefined;
  return (
    <svg
      className="agent-emblem"
      data-shape={shape}
      data-hue={hue}
      data-status={status}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <path className="agent-emblem-rim" fillRule={fillRule} transform="translate(0 0.75)" d={d} />
      <path className="agent-emblem-face" fillRule={fillRule} d={d} />
      <path
        className="agent-emblem-light"
        fillRule={fillRule}
        transform="translate(1.85 1.85) scale(0.7)"
        d={d}
      />
      {status === "error" ? (
        <circle className="agent-emblem-fault" cx="12.6" cy="12.6" r="2.4" />
      ) : null}
    </svg>
  );
}
