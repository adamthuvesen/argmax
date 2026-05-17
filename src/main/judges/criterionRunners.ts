/**
 * Criterion runners for tournament mode (MVP). Each runner takes a finished
 * contestant's context (worktree path, session row) and returns a raw value
 * the aggregator will normalize against the contestant pool.
 *
 * MVP scope: tests-pass, diff-size-lines, cost-usd. lint-clean and typecheck-
 * clean are stubbed to "inconclusive" — the seeded built-in policies still
 * reference them, but the aggregator drops inconclusive criteria so the
 * policy degrades gracefully.
 */

import type { ArgmaxDatabase } from "../persistence/database.js";
import { runGitText } from "../git/exec.js";
import { errorMessage } from "../../shared/error.js";
import { logger } from "../../shared/logger.js";
import type { CheckService } from "../checks/checkService.js";
import type { CriterionId, CriterionStatus } from "../../shared/types.js";

export interface CriterionRunnerContext {
  database: ArgmaxDatabase;
  checks: CheckService;
  workspaceId: string;
  sessionId: string;
  worktreePath: string;
  baseRef: string;
  /**
   * Threaded through to runWorkspaceCheck so a tournament cancel / app quit
   * can stop in-flight checks instead of letting them run to natural
   * completion. (audit-2026-05-17 M9)
   */
  signal?: AbortSignal;
}

export interface CriterionResult {
  status: CriterionStatus;
  rawValue: number | null;
  evidence: Record<string, unknown>;
}

export type CriterionRunner = (context: CriterionRunnerContext) => Promise<CriterionResult>;

/**
 * tests-pass: runs every command in `project.settings.checkCommands` against
 * the contestant's worktree, returns 1.0 if all pass, 0.0 otherwise.
 *
 * If the project has no check commands configured, returns inconclusive.
 */
const testsPassRunner: CriterionRunner = async ({ database, checks, workspaceId, signal }) => {
  const workspace = database.getWorkspace(workspaceId);
  const project = database.getProject(workspace.projectId);
  const commands = project.settings.checkCommands;
  if (commands.length === 0) {
    return {
      status: "inconclusive",
      rawValue: null,
      evidence: { reason: "no check commands configured" }
    };
  }
  const failures: Array<{ command: string; exitCode: number | null; summary: string | null }> = [];
  for (const command of commands) {
    if (signal?.aborted) {
      return {
        status: "inconclusive",
        rawValue: null,
        evidence: { reason: "cancelled", completed: failures.length }
      };
    }
    try {
      const run = await checks.runWorkspaceCheck({
        workspaceId,
        command,
        ...(signal ? { signal } : {})
      });
      if (run.status !== "passed") {
        failures.push({ command, exitCode: run.exitCode, summary: run.summary });
      }
    } catch (error) {
      failures.push({ command, exitCode: null, summary: errorMessage(error) });
    }
  }
  return {
    status: "ok",
    rawValue: failures.length === 0 ? 1 : 0,
    evidence: { checkCommands: commands.length, failures }
  };
};

const inconclusiveRunner: (reason: string) => CriterionRunner = (reason) => () =>
  Promise.resolve({
    status: "inconclusive",
    rawValue: null,
    evidence: { reason }
  });

/**
 * diff-size-lines: parses `git diff --shortstat <baseRef>...HEAD` for the
 * contestant's worktree. Returns added+deleted line count. The aggregator
 * normalizes "smaller is better" by dividing the pool minimum by this value.
 */
const diffSizeLinesRunner: CriterionRunner = async ({ worktreePath, baseRef }) => {
  try {
    const out = await runGitText(worktreePath, ["diff", "--shortstat", `${baseRef}...HEAD`]);
    // git --shortstat output: " 3 files changed, 42 insertions(+), 7 deletions(-)"
    const insertions = Number.parseInt(out.match(/(\d+)\s+insertion/)?.[1] ?? "0", 10);
    const deletions = Number.parseInt(out.match(/(\d+)\s+deletion/)?.[1] ?? "0", 10);
    const total = insertions + deletions;
    return {
      status: "ok",
      rawValue: total,
      evidence: { insertions, deletions, baseRef, raw: out.trim() }
    };
  } catch (error) {
    return {
      status: "inconclusive",
      rawValue: null,
      evidence: { reason: "git diff failed", error: errorMessage(error) }
    };
  }
};

/**
 * cost-usd: read directly from session.cost_usd (already populated incrementally
 * by the usage events pipeline using prices from providerModels.ts). The
 * normalizer marks the cheapest contestant 1.0 and scales others down.
 */
const costUsdRunner: CriterionRunner = ({ database, sessionId }) => {
  try {
    const session = database.getSession(sessionId);
    return Promise.resolve({
      status: "ok" as const,
      rawValue: session.costUsd ?? 0,
      evidence: {
        modelId: session.modelId,
        tokens: session.tokens ?? null
      }
    });
  } catch (error) {
    return Promise.resolve({
      status: "inconclusive" as const,
      rawValue: null,
      evidence: { reason: "session lookup failed", error: errorMessage(error) }
    });
  }
};

export const RUNNERS: Record<CriterionId, CriterionRunner> = {
  "tests-pass": testsPassRunner,
  "lint-clean": inconclusiveRunner("lint-clean runner not implemented in MVP"),
  "typecheck-clean": inconclusiveRunner("typecheck-clean runner not implemented in MVP"),
  "diff-size-lines": diffSizeLinesRunner,
  "files-touched": inconclusiveRunner("files-touched runner not implemented in MVP"),
  "wall-clock-seconds": inconclusiveRunner("wall-clock-seconds runner not implemented in MVP"),
  "cost-usd": costUsdRunner
};

/**
 * Run every criterion required by the policy for one contestant. Errors are
 * caught per-runner and surfaced as inconclusive so one broken runner can't
 * fail the whole tournament.
 */
export async function runCriteriaForContestant(
  context: CriterionRunnerContext,
  criterionIds: CriterionId[]
): Promise<Map<CriterionId, CriterionResult>> {
  const results = new Map<CriterionId, CriterionResult>();
  for (const id of criterionIds) {
    const runner = RUNNERS[id];
    try {
      results.set(id, await runner(context));
    } catch (error) {
      logger.warn("judges.runCriteriaForContestant", "criterion runner threw", {
        criterionId: id,
        sessionId: context.sessionId,
        error: errorMessage(error)
      });
      results.set(id, {
        status: "inconclusive",
        rawValue: null,
        evidence: { reason: "runner threw", error: errorMessage(error) }
      });
    }
  }
  return results;
}
