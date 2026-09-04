import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EMBLEM_PATHS } from "../lib/agentEmblems.js";
import { AgentEmblem } from "./AgentEmblem.js";

describe("AgentEmblem", () => {
  it("names its shape and hue on the mark and stays out of the accessibility tree", () => {
    const { container } = render(<AgentEmblem shape="trefoil" hue="teal" size={18} />);
    const svg = container.querySelector(".agent-emblem");
    expect(svg?.getAttribute("data-shape")).toBe("trefoil");
    expect(svg?.getAttribute("data-hue")).toBe("teal");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("width")).toBe("18");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 16 16");
  });

  it("bevels one path in three passes rather than a gradient", () => {
    // Ids are the reason: the same emblem shows in four places on one page, and
    // duplicated <defs> ids would leave those copies fighting over one gradient.
    const { container } = render(<AgentEmblem shape="quad" hue="amber" />);
    const paths = [...container.querySelectorAll("path")];
    expect(paths.map((path) => path.getAttribute("class"))).toEqual([
      "agent-emblem-rim",
      "agent-emblem-face",
      "agent-emblem-light"
    ]);
    for (const path of paths) expect(path.getAttribute("d")).toBe(EMBLEM_PATHS.quad.d);
    expect(paths[0].getAttribute("transform")).toBe("translate(0 0.75)");
    expect(paths[2].getAttribute("transform")).toBe("translate(1.85 1.85) scale(0.7)");
    expect(container.querySelector("defs, linearGradient, radialGradient, clipPath")).toBeNull();
    expect(container.querySelector("[id]")).toBeNull();
    expect(container.querySelector("[style]")).toBeNull();
  });

  it("carries the fill rule onto all three passes of a shape with a hole", () => {
    const { container } = render(<AgentEmblem shape="orbit" hue="blue" />);
    for (const path of container.querySelectorAll("path")) {
      expect(path.getAttribute("fill-rule")).toBe("evenodd");
    }
  });

  it("leaves the fill rule off a shape drawn from overlapping subpaths", () => {
    const { container } = render(<AgentEmblem shape="shell" hue="red" />);
    for (const path of container.querySelectorAll("path")) {
      expect(path.getAttribute("fill-rule")).toBeNull();
    }
  });

  it("greys a failed agent and moves the state to a corner dot, never to the hue", () => {
    const { container } = render(<AgentEmblem shape="gem" hue="violet" status="error" />);
    const svg = container.querySelector(".agent-emblem");
    expect(svg?.getAttribute("data-status")).toBe("error");
    // Still that agent's shape and hue — only the paint changes, in CSS.
    expect(svg?.getAttribute("data-hue")).toBe("violet");
    expect(container.querySelector(".agent-emblem-fault")).not.toBeNull();
  });

  it("shows no fault dot once an agent has landed", () => {
    const { container } = render(<AgentEmblem shape="gem" hue="violet" status="done" />);
    expect(container.querySelector(".agent-emblem-fault")).toBeNull();
  });
});
