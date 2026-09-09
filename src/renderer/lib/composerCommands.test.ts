import { describe, expect, it } from "vitest";
import { dispatchedCommandNames, isClearCommand } from "./composerCommands.js";

describe("dispatchedCommandNames", () => {
  const all = { hasSession: true, canMultitask: true, goalEnabled: true };

  it("marks the commands the composer acts on itself", () => {
    expect(dispatchedCommandNames(all)).toEqual(new Set(["clear", "multitask", "goal"]));
  });

  /// A tinted token has to dispatch. Listing a name whose submit branch is off
  /// would mark a line as a command and then send it to the agent as prose.
  it("drops a command whose submit branch is not live", () => {
    expect(dispatchedCommandNames({ ...all, goalEnabled: false }).has("goal")).toBe(false);
    expect(dispatchedCommandNames({ ...all, canMultitask: false }).has("multitask")).toBe(false);
  });

  it("offers only /clear on the launcher, which has no session to act on", () => {
    expect(dispatchedCommandNames({ ...all, hasSession: false })).toEqual(new Set(["clear"]));
  });
});

describe("isClearCommand", () => {
  it("matches the bare command and nothing that merely starts with it", () => {
    expect(isClearCommand("/clear")).toBe(true);
    expect(isClearCommand("  /clear  ")).toBe(true);
    expect(isClearCommand("/clear the cache")).toBe(false);
  });
});
