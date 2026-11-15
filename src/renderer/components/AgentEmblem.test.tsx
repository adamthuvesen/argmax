import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EMBLEM_PATHS } from "../lib/agentEmblems.js";
import { AgentEmblem } from "./AgentEmblem.js";

describe("AgentEmblem", () => {
  it("bevels one path in three passes rather than a gradient", () => {
    // Ids are the reason: the same emblem shows in four places on one page, and
    // duplicated <defs> ids would leave those copies fighting over one gradient.
    render(<AgentEmblem shape="quad" hue="amber" />);
    const emblem = screen.getByTestId("agent-emblem");
    // oxlint-disable-next-line argmax/no-node-access -- SVG paths have no role; every path in the emblem must be counted, including any added without a test id
    const paths = [...emblem.querySelectorAll("path")];
    expect(paths.map((path) => path.getAttribute("class"))).toEqual([
      "agent-emblem-rim",
      "agent-emblem-face",
      "agent-emblem-light",
    ]);
    for (const path of paths) expect(path.getAttribute("d")).toBe(EMBLEM_PATHS.quad.d);
    expect(paths[0].getAttribute("transform")).toBe("translate(0 0.75)");
    expect(paths[2].getAttribute("transform")).toBe("translate(1.85 1.85) scale(0.7)");
    // oxlint-disable-next-line argmax/no-node-access -- proving the SVG holds no defs, ids, or inline styles needs a descendant query; none of these has a role
    expect(emblem.querySelector("defs, linearGradient, radialGradient, clipPath")).toBeNull();
    // oxlint-disable-next-line argmax/no-node-access -- see above: any descendant with an id would collide across the page's copies
    expect(emblem.querySelector("[id]")).toBeNull();
    // oxlint-disable-next-line argmax/no-node-access -- see above: inline styles would bypass the stylesheet
    expect(emblem.querySelector("[style]")).toBeNull();
  });

  it("carries the fill rule onto all three passes of a shape with a hole", () => {
    render(<AgentEmblem shape="orbit" hue="blue" />);
    for (const path of screen.getAllByTestId("agent-emblem-pass")) {
      expect(path.getAttribute("fill-rule")).toBe("evenodd");
    }
  });

  it("leaves the fill rule off a shape drawn from overlapping subpaths", () => {
    render(<AgentEmblem shape="shell" hue="red" />);
    for (const path of screen.getAllByTestId("agent-emblem-pass")) {
      expect(path.getAttribute("fill-rule")).toBeNull();
    }
  });

  it("greys a failed agent and moves the state to a corner dot, never to the hue", () => {
    render(<AgentEmblem shape="gem" hue="violet" status="error" />);
    const svg = screen.getByTestId("agent-emblem");
    expect(svg).toHaveAttribute("data-status", "error");
    // Still that agent's shape and hue — only the paint changes, in CSS.
    expect(svg).toHaveAttribute("data-hue", "violet");
    expect(screen.getByTestId("agent-emblem-fault")).toHaveClass("agent-emblem-fault");
  });

  it("shows no fault dot once an agent has landed", () => {
    render(<AgentEmblem shape="gem" hue="violet" status="done" />);
    expect(screen.queryByTestId("agent-emblem-fault")).toBeNull();
  });
});
