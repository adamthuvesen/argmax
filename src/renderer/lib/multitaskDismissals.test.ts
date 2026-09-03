// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { dismissMultitask, readDismissedMultitasks } from "./multitaskDismissals.js";

describe("multitask dismissals", () => {
  beforeEach(() => window.localStorage.clear());

  it("remembers a dismissed row across mounts", () => {
    const dismissed = dismissMultitask(readDismissedMultitasks(), "child-1");
    expect(dismissed.has("child-1")).toBe(true);
    expect(readDismissedMultitasks().has("child-1")).toBe(true);
  });

  it("reads corrupt storage as nothing dismissed", () => {
    window.localStorage.setItem("argmax.multitask.dismissed", "{not json");
    expect(readDismissedMultitasks().size).toBe(0);
  });
});
