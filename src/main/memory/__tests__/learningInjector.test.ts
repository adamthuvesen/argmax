import { describe, expect, it } from "vitest";
import type { Learning } from "../../../shared/types.js";
import { composeLearningPreamble } from "../learningInjector.js";

function makeLearning(overrides: Partial<Learning> & { id: string }): Learning {
  return {
    projectId: "p-1",
    kind: "pitfall",
    summary: "Run prettier before commit",
    evidenceSessionId: null,
    evidenceEventId: null,
    verified: false,
    hits: 0,
    createdAt: "2026-05-01T00:00:00.000Z",
    lastSeenAt: "2026-05-01T00:00:00.000Z",
    ...overrides
  };
}

describe("composeLearningPreamble", () => {
  it("returns the original prompt unchanged when no learnings exist", () => {
    const result = composeLearningPreamble(
      { listLearnings: () => [] },
      "p-1",
      "Build the dashboard"
    );
    expect(result.augmentedPrompt).toBe("Build the dashboard");
    expect(result.injectedIds).toEqual([]);
  });

  it("prepends a project-knowledge preamble with the top learnings", () => {
    const result = composeLearningPreamble(
      {
        listLearnings: () => [
          makeLearning({ id: "L1", summary: "Always run prettier before commit" }),
          makeLearning({ id: "L2", kind: "convention", summary: "Use absolute imports under src/" })
        ]
      },
      "p-1",
      "Ship the feature"
    );
    expect(result.augmentedPrompt).toContain("Project knowledge");
    expect(result.augmentedPrompt).toContain("Always run prettier before commit");
    expect(result.augmentedPrompt).toContain("absolute imports under src/");
    expect(result.augmentedPrompt.endsWith("Ship the feature")).toBe(true);
    expect(result.injectedIds).toEqual(["L1", "L2"]);
  });

  it("truncates the preamble before exceeding ~2000 chars", () => {
    const filler = "A".repeat(900);
    const result = composeLearningPreamble(
      {
        listLearnings: () => [
          makeLearning({ id: "L1", summary: filler }),
          makeLearning({ id: "L2", summary: filler }),
          makeLearning({ id: "L3", summary: filler })
        ]
      },
      "p-1",
      "Original prompt"
    );
    expect(result.injectedIds.length).toBeLessThanOrEqual(2);
    expect(result.augmentedPrompt.length).toBeLessThan(3000);
  });
});
