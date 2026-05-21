import { describe, expect, it } from "vitest";
import type { TurnBodyChild } from "../components/TurnBlock.js";
import { splitTurnIntoPhases } from "./turnPhases.js";

function assistant(id: string): TurnBodyChild {
  return { kind: "assistant", id, node: null };
}

function tool(id: string): TurnBodyChild {
  return { kind: "tool", id, node: null };
}

describe("splitTurnIntoPhases", () => {
  it("returns no phases for empty body", () => {
    expect(splitTurnIntoPhases([])).toEqual([]);
  });

  it("collapses text-only turns to a single result phase", () => {
    const body = [assistant("a"), assistant("b")];
    const phases = splitTurnIntoPhases(body);
    expect(phases).toHaveLength(1);
    expect(phases[0]?.kind).toBe("result");
    expect(phases[0]?.children).toEqual(body);
  });

  it("splits plan / work / result for a sandwiched tool", () => {
    const body = [assistant("plan-1"), tool("t1"), assistant("result-1")];
    const phases = splitTurnIntoPhases(body);
    expect(phases.map((p) => p.kind)).toEqual(["plan", "work", "result"]);
    expect(phases[0]?.children.map((c) => c.id)).toEqual(["plan-1"]);
    expect(phases[1]?.children.map((c) => c.id)).toEqual(["t1"]);
    expect(phases[2]?.children.map((c) => c.id)).toEqual(["result-1"]);
  });

  it("omits the plan phase when no leading text", () => {
    const body = [tool("t1"), assistant("post")];
    const phases = splitTurnIntoPhases(body);
    expect(phases.map((p) => p.kind)).toEqual(["work", "result"]);
  });

  it("omits the result phase when no trailing text", () => {
    const body = [assistant("plan-1"), tool("t1")];
    const phases = splitTurnIntoPhases(body);
    expect(phases.map((p) => p.kind)).toEqual(["plan", "work"]);
  });

  it("rolls interleaved text inside the tool run into work, not separate phases", () => {
    // plan / [t1, mid, t2] / result — only one work phase, mid stays inside it.
    const body = [
      assistant("plan-1"),
      tool("t1"),
      assistant("mid"),
      tool("t2"),
      assistant("result-1")
    ];
    const phases = splitTurnIntoPhases(body);
    expect(phases.map((p) => p.kind)).toEqual(["plan", "work", "result"]);
    expect(phases[1]?.children.map((c) => c.id)).toEqual(["t1", "mid", "t2"]);
  });

  it("collapses a tools-only turn to a single work phase", () => {
    const body = [tool("t1"), tool("t2")];
    const phases = splitTurnIntoPhases(body);
    expect(phases.map((p) => p.kind)).toEqual(["work"]);
    expect(phases[0]?.children.map((c) => c.id)).toEqual(["t1", "t2"]);
  });

  it("preserves order — concatenating phases yields original body", () => {
    const body = [
      assistant("a"),
      tool("t1"),
      assistant("b"),
      tool("t2"),
      assistant("c")
    ];
    const phases = splitTurnIntoPhases(body);
    const flat = phases.flatMap((p) => p.children);
    expect(flat).toEqual(body);
  });
});
