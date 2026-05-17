/**
 * Tournament orchestrator (MVP).
 *
 * Owns the lifecycle: launch N contestants in their own worktrees, watch for
 * all of them to reach a terminal session state, then run the judge pipeline
 * synchronously and persist the verdict. The user keeps a winner via the
 * `keepWinner` IPC, which calls existing per-session keep / archive paths.
 *
 * Polling-based for MVP: the IPC layer calls `refreshAndJudgeIfReady` from
 * `tournament:get` so the orchestrator advances state on demand. A future
 * change can subscribe to the dashboard event bus and push deltas.
 */

import { randomUUID } from "node:crypto";
import type { ArgmaxDatabase } from "../persistence/database.js";
import type { CheckService } from "../checks/checkService.js";
import type { ProviderSessionService } from "../providers/providerSessionService.js";
import type { WorkspaceService } from "../workspaces/workspaceOrchestration.js";
import {
  createContestant,
  createTournament,
  findTournamentById,
  listContestantsByTournament,
  listScoresByTournament,
  listTournaments,
  persistCriterionScore,
  readTournamentLeaderboard,
  setTournamentDecision,
  setTournamentVerdict,
  transitionTournamentState,
  updateContestantOutcome,
  updateTournamentState
} from "../persistence/tournamentsRepository.js";
import { findScoringPolicyById, listScoringPolicies } from "../persistence/scoringPoliciesRepository.js";
import {
  runCriteriaForContestant,
  type CriterionRunnerContext
} from "../judges/criterionRunners.js";
import { aggregate } from "../judges/scoreAggregator.js";
import { logger } from "../../shared/logger.js";
import { errorMessage } from "../../shared/error.js";
import type {
  ContestantConfig,
  CriterionId,
  SessionState,
  Tournament,
  TournamentLeaderboard
} from "../../shared/types.js";

export interface LaunchTournamentInput {
  projectId: string;
  taskLabel: string;
  prompt: string;
  policyId: string;
  contestants: ContestantConfig[];
  /** xterm sizing forwarded to each contestant's PTY launch. */
  cols: number;
  rows: number;
}

const TERMINAL_SESSION_STATES: ReadonlySet<SessionState> = new Set<SessionState>([
  "complete",
  "failed",
  "cancelled"
]);

export class TournamentService {
  constructor(
    private readonly database: ArgmaxDatabase,
    private readonly providerSessions: ProviderSessionService,
    private readonly workspaces: WorkspaceService,
    private readonly checks: CheckService
  ) {}

  async launchTournament(input: LaunchTournamentInput): Promise<Tournament> {
    if (input.contestants.length < 2) {
      throw new Error("Tournament requires at least two contestants");
    }
    const policy = findScoringPolicyById(this.database.connection, input.policyId);
    const tournamentId = randomUUID();
    createTournament(this.database.connection, {
      id: tournamentId,
      projectId: input.projectId,
      taskLabel: input.taskLabel,
      prompt: input.prompt,
      quorum: input.contestants.length,
      policySnapshot: policy
    });

    // Launch contestants serially so a worktree-creation failure halts the
    // tournament before we burn N model launches. (Parallel launch would
    // race for the project's git index.)
    //
    // Track launched contestants so a mid-loop failure can roll back the
    // already-spawned worktrees and sessions instead of leaving orphans behind
    // with the tournament stuck in 'pending'.
    const launched: Array<{ workspaceId: string; sessionId: string }> = [];
    try {
      for (let index = 0; index < input.contestants.length; index++) {
        const config = input.contestants[index];
        if (!config) continue;
        const workspace = await this.workspaces.createIsolatedWorkspace({
          projectId: input.projectId,
          taskLabel: `${input.taskLabel} · #${index + 1}`
        });
        const session = await this.providerSessions.launch({
          workspaceId: workspace.id,
          provider: config.provider,
          prompt: input.prompt,
          modelLabel: config.modelLabel,
          modelId: config.modelId,
          ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
          cols: input.cols,
          rows: input.rows
        });
        launched.push({ workspaceId: workspace.id, sessionId: session.id });
        createContestant(this.database.connection, {
          tournamentId,
          contestantIndex: index,
          sessionId: session.id,
          config
        });
      }
    } catch (error) {
      // Roll back any already-launched contestants so we don't leave orphaned
      // worktrees and provider sessions tied to a tournament that never
      // entered 'running'. Each cleanup is best-effort: log and continue so
      // one stuck workspace doesn't block the rest.
      for (const entry of launched) {
        try {
          await this.providerSessions.terminate(entry.sessionId);
        } catch (cleanupError) {
          logger.warn("tournaments.launchTournament", "cleanup terminate failed", {
            tournamentId,
            sessionId: entry.sessionId,
            error: errorMessage(cleanupError)
          });
        }
        try {
          await this.workspaces.archiveWorkspace(entry.workspaceId);
        } catch (cleanupError) {
          logger.warn("tournaments.launchTournament", "cleanup archive failed", {
            tournamentId,
            workspaceId: entry.workspaceId,
            error: errorMessage(cleanupError)
          });
        }
      }
      updateTournamentState(this.database.connection, tournamentId, "cancelled");
      throw error;
    }

    return updateTournamentState(this.database.connection, tournamentId, "running");
  }

  /**
   * Boot-time reconciler — any tournament left in 'judging' after the previous
   * process exited has partial scores at best and no verdict. Reset to
   * 'running' so refreshAndJudgeIfReady can re-drive the judge pipeline
   * idempotently. Without this, a crash mid-judge wedged tournaments forever.
   */
  /**
   * Per-tournament AbortControllers active inside runJudge. `dispose()` (called
   * from main.ts shutdown) aborts all of them so in-flight check commands stop
   * instead of running to completion against a torn-down app.
   * (audit-2026-05-17 M9)
   */
  private readonly judgeAborts = new Map<string, AbortController>();

  dispose(): void {
    for (const controller of this.judgeAborts.values()) {
      controller.abort();
    }
    this.judgeAborts.clear();
  }

  recoverStuckJudgingTournaments(): number {
    const stuck = listTournaments(this.database.connection, { state: "judging" });
    for (const t of stuck) {
      updateTournamentState(this.database.connection, t.id, "running");
    }
    if (stuck.length > 0) {
      logger.info("tournaments.recover", "reset stuck judging tournaments", { count: stuck.length });
    }
    return stuck.length;
  }

  listTournamentsForProject(projectId: string): Tournament[] {
    return listTournaments(this.database.connection, { projectId });
  }

  /**
   * Read the leaderboard, and if every contestant has reached a terminal
   * session state without a verdict yet, run the judge pipeline inline and
   * persist the verdict. Returning the leaderboard after judging means a
   * single IPC call hydrates the view.
   */
  async refreshAndJudgeIfReady(tournamentId: string): Promise<TournamentLeaderboard> {
    const tournament = findTournamentById(this.database.connection, tournamentId);
    if (tournament.state === "running") {
      const contestants = listContestantsByTournament(this.database.connection, tournamentId);
      let allTerminal = true;
      for (const contestant of contestants) {
        const session = this.database.getSession(contestant.sessionId);
        if (!TERMINAL_SESSION_STATES.has(session.state)) {
          allTerminal = false;
          break;
        }
      }
      if (allTerminal) {
        await this.runJudge(tournamentId);
      }
    }
    return readTournamentLeaderboard(this.database.connection, tournamentId);
  }

  private async runJudge(tournamentId: string): Promise<void> {
    // Conditional transition — if two refreshAndJudgeIfReady calls both pass
    // the `state === 'running'` check, only the first one transitions and
    // proceeds. The second observes null and bails. (audit-2026-05-17 M8)
    const transitioned = transitionTournamentState(
      this.database.connection,
      tournamentId,
      "running",
      "judging"
    );
    if (!transitioned) return;
    const abort = new AbortController();
    this.judgeAborts.set(tournamentId, abort);
    try {
    const tournament = findTournamentById(this.database.connection, tournamentId);
    const contestants = listContestantsByTournament(this.database.connection, tournamentId);
    const criterionIds: CriterionId[] = tournament.policySnapshot.criteria.map((c) => c.id);

    for (const contestant of contestants) {
      if (abort.signal.aborted) break;
      const session = this.database.getSession(contestant.sessionId);
      const workspace = this.database.getWorkspace(session.workspaceId);
      const ctx: CriterionRunnerContext = {
        database: this.database,
        checks: this.checks,
        workspaceId: workspace.id,
        sessionId: session.id,
        worktreePath: workspace.path,
        baseRef: workspace.baseRef,
        signal: abort.signal
      };
      try {
        const results = await runCriteriaForContestant(ctx, criterionIds);
        for (const [criterionId, result] of results) {
          persistCriterionScore(this.database.connection, {
            tournamentId,
            contestantIndex: contestant.contestantIndex,
            criterionId,
            status: result.status,
            rawValue: result.rawValue,
            normalizedValue: null,
            evidence: result.evidence
          });
        }
        updateContestantOutcome(
          this.database.connection,
          tournamentId,
          contestant.contestantIndex,
          "in-quorum"
        );
      } catch (error) {
        logger.warn("tournaments.runJudge", "contestant judge failed", {
          tournamentId,
          contestantIndex: contestant.contestantIndex,
          error: errorMessage(error)
        });
      }
    }

    const scores = listScoresByTournament(this.database.connection, tournamentId);
    const verdict = aggregate({
      policy: tournament.policySnapshot,
      contestantIndices: contestants.map((c) => c.contestantIndex),
      scores
    });
    setTournamentVerdict(this.database.connection, tournamentId, verdict);
    updateTournamentState(this.database.connection, tournamentId, "awaiting-decision");
    } finally {
      this.judgeAborts.delete(tournamentId);
    }
  }

  /**
   * Promote the chosen contestant via the existing keep path, archive every
   * other contestant via the existing archive path. Records the decision on
   * the tournament row.
   */
  async keepWinner(input: {
    tournamentId: string;
    contestantIndex: number;
    reason?: string;
  }): Promise<TournamentLeaderboard> {
    const tournament = findTournamentById(this.database.connection, input.tournamentId);
    if (tournament.state !== "awaiting-decision") {
      throw new Error(
        `Tournament ${input.tournamentId} is in state '${tournament.state}'; cannot keep a winner now`
      );
    }
    const contestants = listContestantsByTournament(this.database.connection, input.tournamentId);
    const winnerContestant = contestants.find(
      (c) => c.contestantIndex === input.contestantIndex
    );
    if (!winnerContestant) {
      throw new Error(`Contestant ${input.contestantIndex} not found in tournament ${input.tournamentId}`);
    }
    const winnerSession = this.database.getSession(winnerContestant.sessionId);
    this.workspaces.keepWorkspace(winnerSession.workspaceId);

    for (const contestant of contestants) {
      if (contestant.contestantIndex === input.contestantIndex) continue;
      const session = this.database.getSession(contestant.sessionId);
      try {
        await this.workspaces.archiveWorkspace(session.workspaceId, {
          cancelChecks: (id) => this.checks.cancelWorkspaceChecks(id)
        });
      } catch (error) {
        logger.warn("tournaments.keepWinner", "archive failed for loser", {
          tournamentId: input.tournamentId,
          contestantIndex: contestant.contestantIndex,
          error: errorMessage(error)
        });
      }
    }

    const overrodeWinner =
      tournament.verdict?.winner !== null && tournament.verdict?.winner !== input.contestantIndex;
    setTournamentDecision(this.database.connection, input.tournamentId, {
      keptContestantIndex: input.contestantIndex,
      source: "manual",
      overrodeWinner: Boolean(overrodeWinner),
      ...(input.reason ? { reason: input.reason } : {}),
      decidedAt: new Date().toISOString()
    });
    return readTournamentLeaderboard(this.database.connection, input.tournamentId);
  }

  listPolicies(): ReturnType<typeof listScoringPolicies> {
    return listScoringPolicies(this.database.connection);
  }

  getLeaderboard(tournamentId: string): TournamentLeaderboard {
    return readTournamentLeaderboard(this.database.connection, tournamentId);
  }
}
