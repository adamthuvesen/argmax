// @vitest-environment node
import { describe, expect, it } from "vitest";
import { computeSessionAttention } from "./sessionAttention.js";

describe("computeSessionAttention", () => {
  it("prioritizes pending approvals", () => {
    expect(
      computeSessionAttention({
        state: "running",
        pendingApprovals: [{ status: "pending" }]
      })
    ).toBe("approval-needed");
  });

  it("marks blocked or waiting sessions as blocked", () => {
    expect(computeSessionAttention({ state: "blocked" })).toBe("blocked");
    expect(computeSessionAttention({ state: "waiting" })).toBe("blocked");
  });

  it("marks failed sessions as failed", () => {
    expect(computeSessionAttention({ state: "failed" })).toBe("failed");
  });

  it("marks complete and kept sessions as review-ready", () => {
    expect(computeSessionAttention({ state: "complete" })).toBe("review-ready");
    expect(computeSessionAttention({ state: "kept" })).toBe("review-ready");
  });

  it("leaves created and running sessions normal", () => {
    expect(computeSessionAttention({ state: "created" })).toBe("normal");
    expect(computeSessionAttention({ state: "running" })).toBe("normal");
  });
});
