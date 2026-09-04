import { describe, expect, it } from "vitest";
import { turnExhaleWeight, type TurnOutput } from "./turnExhale.js";

function output(overrides: Partial<TurnOutput> = {}): TurnOutput {
  return { files: 0, lines: 0, tools: 0, answerChars: 0, ...overrides };
}

describe("turnExhaleWeight", () => {
  it("stays near zero for a one-line reply and reaches the top for a turn that rewrote the repo", () => {
    expect(turnExhaleWeight(output({ answerChars: 60 }))).toBeLessThan(0.05);
    expect(
      turnExhaleWeight(output({ files: 40, lines: 1_800, tools: 60, answerChars: 4_000 }))
    ).toBe(1);
  });

  it("ranks a small edit under a large one and a large one under a whole refactor", () => {
    const typo = turnExhaleWeight(output({ files: 1, lines: 2, tools: 3, answerChars: 200 }));
    const feature = turnExhaleWeight(output({ files: 4, lines: 120, tools: 12, answerChars: 800 }));
    const refactor = turnExhaleWeight(output({ files: 22, lines: 900, tools: 40, answerChars: 900 }));
    expect(typo).toBeLessThan(feature);
    expect(feature).toBeLessThan(refactor);
  });

  it("counts a research turn that wrote nothing, without letting it outrank written work", () => {
    const research = turnExhaleWeight(output({ tools: 30, answerChars: 3_000 }));
    expect(research).toBeGreaterThan(0.3);
    expect(research).toBeLessThan(turnExhaleWeight(output({ files: 20, lines: 600, tools: 30 })));
  });

  it("reads one big rewrite and many small edits as the same size of turn", () => {
    // Files and lines measure the same work at different resolutions, so they
    // take the larger of the two rather than stacking into a double count.
    const oneRewrite = turnExhaleWeight(output({ files: 1, lines: 500 }));
    const manyEdits = turnExhaleWeight(output({ files: 14, lines: 28 }));
    expect(oneRewrite).toBeCloseTo(manyEdits, 5);
  });

  it("ignores nonsense counts rather than producing a weight outside 0..1", () => {
    expect(turnExhaleWeight(output({ files: -3, lines: Number.NaN }))).toBe(0);
    expect(turnExhaleWeight(output({ files: Number.POSITIVE_INFINITY }))).toBe(0);
  });
});
