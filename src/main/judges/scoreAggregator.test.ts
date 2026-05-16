// @vitest-environment node
import { describe, expect, it } from "vitest";
import { aggregate } from "./scoreAggregator.js";
import type {
  CriterionScore,
  ScoringPolicy
} from "../../shared/types.js";

function policy(): ScoringPolicy {
  return {
    id: "p",
    name: "test",
    scope: "user",
    projectId: null,
    isBuiltIn: true,
    criteria: [
      { id: "tests-pass", weight: 2, threshold: { op: "==", value: 1 } },
      { id: "diff-size-lines", weight: 1 },
      { id: "cost-usd", weight: 1 }
    ],
    autoKeepRule: { min_total: 0.8, min_margin: 0.1 },
    tiesThreshold: 0.05,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function score(
  contestantIndex: number,
  criterionId: CriterionScore["criterionId"],
  raw: number | null,
  status: CriterionScore["status"] = "ok"
): CriterionScore {
  return {
    tournamentId: "t",
    contestantIndex,
    criterionId,
    status,
    rawValue: raw,
    normalizedValue: null,
    evidence: {},
    scoredAt: "2026-01-01T00:00:00.000Z"
  };
}

describe("aggregate", () => {
  it("ranks higher-correctness contestant first when tests differ", () => {
    const verdict = aggregate({
      policy: policy(),
      contestantIndices: [0, 1],
      scores: [
        score(0, "tests-pass", 1),
        score(0, "diff-size-lines", 100),
        score(0, "cost-usd", 0.5),
        score(1, "tests-pass", 0),
        score(1, "diff-size-lines", 50),
        score(1, "cost-usd", 0.1)
      ]
    });
    // Contestant 1 fails the hard gate on tests-pass; should be disqualified.
    expect(verdict.disqualified).toContain(1);
    expect(verdict.winner).toBe(0);
  });

  it("normalizes smaller-is-better criteria with pool minimum as 1.0", () => {
    const verdict = aggregate({
      policy: policy(),
      contestantIndices: [0, 1, 2],
      scores: [
        score(0, "tests-pass", 1),
        score(0, "diff-size-lines", 100),
        score(0, "cost-usd", 1),
        score(1, "tests-pass", 1),
        score(1, "diff-size-lines", 50),
        score(1, "cost-usd", 1),
        score(2, "tests-pass", 1),
        score(2, "diff-size-lines", 25),
        score(2, "cost-usd", 1)
      ]
    });
    expect(verdict.winner).toBe(2);
    // Contestant 2 has the smallest diff (25) and matches others on cost +
    // tests, so it should rank above contestant 1, which should rank above 0.
    const sorted = [...verdict.totals].sort((a, b) => b.total - a.total);
    expect(sorted.map((t) => t.contestantIndex)).toEqual([2, 1, 0]);
  });

  it("returns null winner when top scores are within ties_threshold", () => {
    const verdict = aggregate({
      policy: policy(),
      contestantIndices: [0, 1],
      scores: [
        score(0, "tests-pass", 1),
        score(0, "diff-size-lines", 100),
        score(0, "cost-usd", 1),
        score(1, "tests-pass", 1),
        score(1, "diff-size-lines", 100),
        score(1, "cost-usd", 1)
      ]
    });
    expect(verdict.winner).toBeNull();
    expect(verdict.ties).toHaveLength(1);
  });

  it("excludes inconclusive criteria from totals without disqualifying", () => {
    const verdict = aggregate({
      policy: policy(),
      contestantIndices: [0, 1],
      scores: [
        score(0, "tests-pass", null, "inconclusive"),
        score(0, "diff-size-lines", 50),
        score(0, "cost-usd", 0.5),
        score(1, "tests-pass", null, "inconclusive"),
        score(1, "diff-size-lines", 100),
        score(1, "cost-usd", 1)
      ]
    });
    // Inconclusive tests-pass shouldn't disqualify either contestant; the
    // smaller diff + smaller cost should win.
    expect(verdict.disqualified).not.toContain(0);
    expect(verdict.disqualified).not.toContain(1);
    expect(verdict.winner).toBe(0);
  });

  it("treats raw==0 on smaller-is-better as ideal (1.0 normalized)", () => {
    const verdict = aggregate({
      policy: policy(),
      contestantIndices: [0, 1],
      scores: [
        score(0, "tests-pass", 1),
        score(0, "diff-size-lines", 0),
        score(0, "cost-usd", 0),
        score(1, "tests-pass", 1),
        score(1, "diff-size-lines", 100),
        score(1, "cost-usd", 1)
      ]
    });
    expect(verdict.winner).toBe(0);
  });
});
