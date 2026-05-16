/**
 * Aggregator for tournament mode (MVP).
 *
 * Inputs: per-contestant maps of criterion-id → CriterionScore that the runner
 * has already persisted. Outputs: a Verdict that names the winner, runner-up,
 * margin, ties, and any contestants disqualified by hard gates.
 *
 * Normalization rule: smaller-is-better criteria (diff-size, cost) treat the
 * pool minimum as 1.0 and scale others as min/value. Boolean/larger-is-better
 * criteria (tests-pass) keep their raw value as the normalized value. The
 * aggregator excludes inconclusive scores from per-criterion normalization
 * AND from the per-contestant total, so one failed runner does not poison
 * the whole tournament.
 */

import type {
  CriterionId,
  CriterionScore,
  PolicyCriterion,
  ScoringPolicy,
  TournamentVerdict
} from "../../shared/types.js";

const SMALLER_IS_BETTER: ReadonlySet<CriterionId> = new Set<CriterionId>([
  "diff-size-lines",
  "files-touched",
  "wall-clock-seconds",
  "cost-usd"
]);

export interface AggregatorInput {
  policy: ScoringPolicy;
  contestantIndices: number[];
  /** All persisted scores for the tournament. */
  scores: CriterionScore[];
}

interface NormalizedScore {
  contestantIndex: number;
  criterionId: CriterionId;
  normalized: number;
  status: CriterionScore["status"];
  raw: number | null;
}

/**
 * Compute normalized values per criterion across the contestant pool. Returns
 * a flat array; the per-criterion key is `${contestantIndex}:${criterionId}`.
 */
function normalizeAcrossPool(input: AggregatorInput): NormalizedScore[] {
  const result: NormalizedScore[] = [];
  for (const criterion of input.policy.criteria) {
    const scoresForCriterion = input.scores.filter((s) => s.criterionId === criterion.id);
    const okScores = scoresForCriterion.filter((s) => s.status === "ok" && s.rawValue !== null);
    const smaller = SMALLER_IS_BETTER.has(criterion.id);
    let poolMin = Number.POSITIVE_INFINITY;
    let poolMax = Number.NEGATIVE_INFINITY;
    for (const s of okScores) {
      const v = s.rawValue as number;
      if (v < poolMin) poolMin = v;
      if (v > poolMax) poolMax = v;
    }
    for (const s of scoresForCriterion) {
      if (s.status !== "ok" || s.rawValue === null) {
        result.push({
          contestantIndex: s.contestantIndex,
          criterionId: criterion.id,
          normalized: 0,
          status: s.status,
          raw: s.rawValue
        });
        continue;
      }
      const raw = s.rawValue;
      let normalized: number;
      if (smaller) {
        // smaller raw = better. Min in pool gets 1.0; pure zero is treated
        // as 1.0 (no diff / no cost is the ideal). If only one contestant has
        // a value, it gets 1.0.
        if (raw === 0) {
          normalized = 1;
        } else if (poolMin === Number.POSITIVE_INFINITY) {
          normalized = 0;
        } else if (poolMin === 0) {
          // Some other contestant achieved zero; this one didn't.
          normalized = 0;
        } else {
          normalized = poolMin / raw;
        }
      } else {
        // larger raw = better; for boolean criteria (0 or 1) this is identity.
        if (poolMax === Number.NEGATIVE_INFINITY || poolMax === 0) {
          normalized = raw === 0 ? 0 : 1;
        } else {
          normalized = raw / poolMax;
        }
      }
      // Clamp to [0, 1] to defend against rounding.
      normalized = Math.max(0, Math.min(1, normalized));
      result.push({
        contestantIndex: s.contestantIndex,
        criterionId: criterion.id,
        normalized,
        status: s.status,
        raw
      });
    }
  }
  return result;
}

function passesHardGate(criterion: PolicyCriterion, raw: number | null, status: CriterionScore["status"]): boolean {
  if (!criterion.threshold) return true;
  // Inconclusive does not fail a hard gate — the criterion just doesn't apply.
  // (Otherwise an MVP that doesn't implement lint-clean would disqualify
  // every contestant under correctness-first.)
  if (status !== "ok" || raw === null) return true;
  const { op, value } = criterion.threshold;
  if (op === "==") return raw === value;
  if (op === "<=") return raw <= value;
  if (op === ">=") return raw >= value;
  return true;
}

export function aggregate(input: AggregatorInput): TournamentVerdict {
  const normalized = normalizeAcrossPool(input);
  const weightSum = input.policy.criteria.reduce((acc, c) => acc + c.weight, 0);
  if (weightSum <= 0) {
    return {
      winner: null,
      runnerUp: null,
      margin: 0,
      ties: [],
      disqualified: [],
      totals: input.contestantIndices.map((i) => ({ contestantIndex: i, total: 0 })),
      computedAt: new Date().toISOString()
    };
  }

  const disqualified = new Set<number>();
  for (const criterion of input.policy.criteria) {
    if (!criterion.threshold) continue;
    for (const idx of input.contestantIndices) {
      const score = input.scores.find(
        (s) => s.contestantIndex === idx && s.criterionId === criterion.id
      );
      if (!score) continue;
      if (!passesHardGate(criterion, score.rawValue, score.status)) {
        disqualified.add(idx);
      }
    }
  }

  // Compute per-contestant total. Inconclusive criteria are dropped from
  // both numerator and denominator so the total still reads as a [0, 1]
  // weighted average over the criteria that produced ok scores.
  const totals = input.contestantIndices.map((idx) => {
    let weighted = 0;
    let activeWeight = 0;
    for (const criterion of input.policy.criteria) {
      const norm = normalized.find(
        (n) => n.contestantIndex === idx && n.criterionId === criterion.id
      );
      if (!norm || norm.status !== "ok") continue;
      weighted += norm.normalized * criterion.weight;
      activeWeight += criterion.weight;
    }
    return { contestantIndex: idx, total: activeWeight > 0 ? weighted / activeWeight : 0 };
  });

  // Rank only the non-disqualified contestants. Disqualified contestants
  // keep their total visible on the leaderboard but cannot win.
  const eligible = totals.filter((t) => !disqualified.has(t.contestantIndex));
  const ordered = [...eligible].sort((a, b) => b.total - a.total);
  const winner = ordered[0]?.contestantIndex ?? null;
  const runnerUp = ordered[1]?.contestantIndex ?? null;
  const margin = ordered.length >= 2 ? (ordered[0]?.total ?? 0) - (ordered[1]?.total ?? 0) : ordered[0]?.total ?? 0;
  const ties: number[] = [];
  if (winner !== null) {
    const top = ordered[0]?.total ?? 0;
    for (const t of eligible) {
      if (t.contestantIndex !== winner && Math.abs(t.total - top) < input.policy.tiesThreshold) {
        ties.push(t.contestantIndex);
      }
    }
  }

  return {
    winner: ties.length > 0 ? null : winner,
    runnerUp,
    margin,
    ties,
    disqualified: [...disqualified],
    totals,
    computedAt: new Date().toISOString()
  };
}
