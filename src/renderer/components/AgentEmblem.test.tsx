import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EMBLEM_PATHS } from "../lib/agentEmblems.js";
import { AgentEmblem } from "./AgentEmblem.js";

describe("AgentEmblem", () => {
  it("bevels one path in three passes rather than a gradient", () => {
    // Ids are the reason: the same emblem shows in four places on one page, and
    // duplicated <defs> ids would leave those copies fighting over one gradient.
    render(<AgentEmblem shape="quad" hue="amber" />);
    const paths = screen.getAllByTestId("agent-emblem-pass");
    expect(paths.map((path) => path.getAttribute("class"))).toEqual([
      "agent-emblem-rim",
      "agent-emblem-face",
      "agent-emblem-light",
    ]);
    for (const path of paths) expect(path.getAttribute("d")).toBe(EMBLEM_PATHS.quad.d);
    expect(paths[0].getAttribute("transform")).toBe("translate(0 0.75)");
    expect(paths[2].getAttribute("transform")).toBe("translate(1.85 1.85) scale(0.7)");
    const markup = screen.getByTestId("agent-emblem").outerHTML;
    expect(markup).not.toMatch(/<(defs|linearGradient|radialGradient|clipPath)\b/);
    expect(markup).not.toMatch(/\sid=/);
    expect(markup).not.toMatch(/\sstyle=/);
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
