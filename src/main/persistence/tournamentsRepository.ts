import type Database from "better-sqlite3";
import { RecordNotFoundError } from "./errors.js";
import { safeJsonParse } from "../../shared/safeJson.js";
import { findScoringPolicyById } from "./scoringPoliciesRepository.js";
import type { ReasoningEffort } from "../../shared/providerModels.js";
import type {
  ContestantConfig,
  ContestantOutcome,
  CriterionId,
  CriterionScore,
  CriterionStatus,
  ProviderId,
  ScoringPolicy,
  Tournament,
  TournamentContestant,
  TournamentDecision,
  TournamentLeaderboard,
  TournamentLeaderboardRow,
  TournamentState,
  TournamentVerdict
} from "../../shared/types.js";

interface TournamentRow {
  id: string;
  project_id: string;
  task_label: string;
  prompt: string;
  state: TournamentState;
  quorum: number;
  policy_id: string | null;
  policy_snapshot_json: string;
  verdict_json: string | null;
  decision_json: string | null;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
}

interface ContestantRow {
  tournament_id: string;
  contestant_index: number;
  session_id: string;
  provider: ProviderId;
  model_id: string;
  model_label: string;
  reasoning_effort: ReasoningEffort | null;
  config_json: string;
  outcome: ContestantOutcome;
  created_at: string;
}

interface ScoreRow {
  tournament_id: string;
  contestant_index: number;
  criterion_id: CriterionId;
  status: CriterionStatus;
  raw_value: number | null;
  normalized_value: number | null;
  evidence_json: string;
  scored_at: string;
}

export interface CreateTournamentInput {
  id: string;
  projectId: string;
  taskLabel: string;
  prompt: string;
  quorum: number;
  policySnapshot: ScoringPolicy;
}

export interface CreateContestantInput {
  tournamentId: string;
  contestantIndex: number;
  sessionId: string;
  config: ContestantConfig;
}

export interface PersistScoreInput {
  tournamentId: string;
  contestantIndex: number;
  criterionId: CriterionId;
  status: CriterionStatus;
  rawValue: number | null;
  normalizedValue: number | null;
  evidence: Record<string, unknown>;
}

function rowToTournament(row: TournamentRow): Tournament {
  const snapshotParsed = safeJsonParse(
    row.policy_snapshot_json,
    "tournaments.policy_snapshot_json"
  );
  if (!snapshotParsed || typeof snapshotParsed !== "object") {
    throw new Error(`Tournament ${row.id} has corrupt policy_snapshot_json`);
  }
  return {
    id: row.id,
    projectId: row.project_id,
    taskLabel: row.task_label,
    prompt: row.prompt,
    state: row.state,
    quorum: row.quorum,
    policyId: row.policy_id,
    policySnapshot: snapshotParsed as ScoringPolicy,
    verdict: row.verdict_json
      ? (safeJsonParse(row.verdict_json, "tournaments.verdict_json") as TournamentVerdict | null)
      : null,
    decision: row.decision_json
      ? (safeJsonParse(row.decision_json, "tournaments.decision_json") as TournamentDecision | null)
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decidedAt: row.decided_at
  };
}

function rowToContestant(row: ContestantRow): TournamentContestant {
  const configParsed = safeJsonParse(row.config_json, "tournament_contestants.config_json");
  return {
    tournamentId: row.tournament_id,
    contestantIndex: row.contestant_index,
    sessionId: row.session_id,
    provider: row.provider,
    modelId: row.model_id,
    modelLabel: row.model_label,
    reasoningEffort: row.reasoning_effort,
    config: configParsed && typeof configParsed === "object" ? (configParsed as Record<string, unknown>) : {},
    outcome: row.outcome,
    createdAt: row.created_at
  };
}

function rowToScore(row: ScoreRow): CriterionScore {
  const evidenceParsed = safeJsonParse(row.evidence_json, "tournament_scores.evidence_json");
  return {
    tournamentId: row.tournament_id,
    contestantIndex: row.contestant_index,
    criterionId: row.criterion_id,
    status: row.status,
    rawValue: row.raw_value,
    normalizedValue: row.normalized_value,
    evidence:
      evidenceParsed && typeof evidenceParsed === "object"
        ? (evidenceParsed as Record<string, unknown>)
        : {},
    scoredAt: row.scored_at
  };
}

export function createTournament(
  connection: Database.Database,
  input: CreateTournamentInput
): Tournament {
  if (input.quorum < 1) {
    throw new Error("Tournament quorum must be at least 1");
  }
  const now = new Date().toISOString();
  connection
    .prepare(
      `INSERT INTO tournaments (
         id, project_id, task_label, prompt, state, quorum,
         policy_id, policy_snapshot_json,
         verdict_json, decision_json,
         created_at, updated_at, decided_at
       ) VALUES (
         @id, @projectId, @taskLabel, @prompt, 'pending', @quorum,
         @policyId, @snapshotJson,
         NULL, NULL,
         @now, @now, NULL
       )`
    )
    .run({
      id: input.id,
      projectId: input.projectId,
      taskLabel: input.taskLabel,
      prompt: input.prompt,
      quorum: input.quorum,
      policyId: input.policySnapshot.id,
      snapshotJson: JSON.stringify(input.policySnapshot),
      now
    });

  return findTournamentById(connection, input.id);
}

export function findTournamentById(
  connection: Database.Database,
  tournamentId: string
): Tournament {
  const row = connection
    .prepare("SELECT * FROM tournaments WHERE id = ?")
    .get(tournamentId) as TournamentRow | undefined;
  if (!row) {
    throw new RecordNotFoundError("tournament", tournamentId);
  }
  return rowToTournament(row);
}

export function listTournaments(
  connection: Database.Database,
  options?: { projectId?: string; state?: TournamentState; limit?: number }
): Tournament[] {
  const limit = options?.limit ?? 200;
  let rows: TournamentRow[];
  if (options?.projectId && options.state) {
    rows = connection
      .prepare(
        `SELECT * FROM tournaments WHERE project_id = ? AND state = ? ORDER BY created_at DESC LIMIT ?`
      )
      .all(options.projectId, options.state, limit) as TournamentRow[];
  } else if (options?.projectId) {
    rows = connection
      .prepare(
        `SELECT * FROM tournaments WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`
      )
      .all(options.projectId, limit) as TournamentRow[];
  } else if (options?.state) {
    rows = connection
      .prepare(`SELECT * FROM tournaments WHERE state = ? ORDER BY created_at DESC LIMIT ?`)
      .all(options.state, limit) as TournamentRow[];
  } else {
    rows = connection
      .prepare(`SELECT * FROM tournaments ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as TournamentRow[];
  }
  return rows.map(rowToTournament);
}

export function updateTournamentState(
  connection: Database.Database,
  tournamentId: string,
  state: TournamentState
): Tournament {
  const now = new Date().toISOString();
  const result = connection
    .prepare("UPDATE tournaments SET state = ?, updated_at = ? WHERE id = ?")
    .run(state, now, tournamentId);
  if (result.changes === 0) {
    throw new RecordNotFoundError("tournament", tournamentId);
  }
  return findTournamentById(connection, tournamentId);
}

/**
 * Conditional state transition. Returns the updated row only when the
 * tournament was in `expectedFrom` at update time; returns null otherwise
 * (state already advanced or the row vanished). Used to gate `runJudge` so
 * two concurrent `refreshAndJudgeIfReady` calls can't both pass the
 * `state === 'running'` check and double-fire the judge pipeline.
 * (audit-2026-05-17 M8)
 */
export function transitionTournamentState(
  connection: Database.Database,
  tournamentId: string,
  expectedFrom: TournamentState,
  to: TournamentState
): Tournament | null {
  const now = new Date().toISOString();
  const result = connection
    .prepare("UPDATE tournaments SET state = ?, updated_at = ? WHERE id = ? AND state = ?")
    .run(to, now, tournamentId, expectedFrom);
  if (result.changes === 0) return null;
  return findTournamentById(connection, tournamentId);
}

export function setTournamentVerdict(
  connection: Database.Database,
  tournamentId: string,
  verdict: TournamentVerdict
): Tournament {
  const now = new Date().toISOString();
  const result = connection
    .prepare(
      `UPDATE tournaments SET verdict_json = ?, updated_at = ? WHERE id = ?`
    )
    .run(JSON.stringify(verdict), now, tournamentId);
  if (result.changes === 0) {
    throw new RecordNotFoundError("tournament", tournamentId);
  }
  return findTournamentById(connection, tournamentId);
}

export function setTournamentDecision(
  connection: Database.Database,
  tournamentId: string,
  decision: TournamentDecision
): Tournament {
  const now = new Date().toISOString();
  const result = connection
    .prepare(
      `UPDATE tournaments
       SET decision_json = ?, state = 'decided', decided_at = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(JSON.stringify(decision), now, now, tournamentId);
  if (result.changes === 0) {
    throw new RecordNotFoundError("tournament", tournamentId);
  }
  return findTournamentById(connection, tournamentId);
}

export function createContestant(
  connection: Database.Database,
  input: CreateContestantInput
): TournamentContestant {
  const now = new Date().toISOString();
  connection
    .prepare(
      `INSERT INTO tournament_contestants (
         tournament_id, contestant_index, session_id,
         provider, model_id, model_label, reasoning_effort,
         config_json, outcome, created_at
       ) VALUES (
         @tournamentId, @contestantIndex, @sessionId,
         @provider, @modelId, @modelLabel, @reasoningEffort,
         @configJson, 'pending', @now
       )`
    )
    .run({
      tournamentId: input.tournamentId,
      contestantIndex: input.contestantIndex,
      sessionId: input.sessionId,
      provider: input.config.provider,
      modelId: input.config.modelId,
      modelLabel: input.config.modelLabel,
      reasoningEffort: input.config.reasoningEffort ?? null,
      configJson: JSON.stringify(input.config.config ?? {}),
      now
    });
  // Backfill the session row so session.tournament_id / session.contestant_index
  // round-trip with what tournament_contestants knows.
  connection
    .prepare(
      `UPDATE sessions SET tournament_id = ?, contestant_index = ? WHERE id = ?`
    )
    .run(input.tournamentId, input.contestantIndex, input.sessionId);

  return findContestantBySession(connection, input.sessionId);
}

export function findContestantBySession(
  connection: Database.Database,
  sessionId: string
): TournamentContestant {
  const row = connection
    .prepare("SELECT * FROM tournament_contestants WHERE session_id = ?")
    .get(sessionId) as ContestantRow | undefined;
  if (!row) {
    throw new RecordNotFoundError("tournament_contestant", sessionId);
  }
  return rowToContestant(row);
}

export function listContestantsByTournament(
  connection: Database.Database,
  tournamentId: string
): TournamentContestant[] {
  const rows = connection
    .prepare(
      `SELECT * FROM tournament_contestants
       WHERE tournament_id = ?
       ORDER BY contestant_index ASC`
    )
    .all(tournamentId) as ContestantRow[];
  return rows.map(rowToContestant);
}

export function updateContestantOutcome(
  connection: Database.Database,
  tournamentId: string,
  contestantIndex: number,
  outcome: ContestantOutcome
): void {
  const result = connection
    .prepare(
      `UPDATE tournament_contestants
       SET outcome = ?
       WHERE tournament_id = ? AND contestant_index = ?`
    )
    .run(outcome, tournamentId, contestantIndex);
  if (result.changes === 0) {
    throw new RecordNotFoundError("tournament_contestant", `${tournamentId}#${contestantIndex}`);
  }
}

export function persistCriterionScore(
  connection: Database.Database,
  input: PersistScoreInput
): CriterionScore {
  const now = new Date().toISOString();
  connection
    .prepare(
      `INSERT INTO tournament_scores (
         tournament_id, contestant_index, criterion_id,
         status, raw_value, normalized_value, evidence_json, scored_at
       ) VALUES (
         @tournamentId, @contestantIndex, @criterionId,
         @status, @rawValue, @normalizedValue, @evidenceJson, @now
       )
       ON CONFLICT(tournament_id, contestant_index, criterion_id)
       DO UPDATE SET
         status = excluded.status,
         raw_value = excluded.raw_value,
         normalized_value = excluded.normalized_value,
         evidence_json = excluded.evidence_json,
         scored_at = excluded.scored_at`
    )
    .run({
      tournamentId: input.tournamentId,
      contestantIndex: input.contestantIndex,
      criterionId: input.criterionId,
      status: input.status,
      rawValue: input.rawValue,
      normalizedValue: input.normalizedValue,
      evidenceJson: JSON.stringify(input.evidence ?? {}),
      now
    });

  const row = connection
    .prepare(
      `SELECT * FROM tournament_scores
       WHERE tournament_id = ? AND contestant_index = ? AND criterion_id = ?`
    )
    .get(input.tournamentId, input.contestantIndex, input.criterionId) as ScoreRow;
  return rowToScore(row);
}

export function listScoresByTournament(
  connection: Database.Database,
  tournamentId: string
): CriterionScore[] {
  const rows = connection
    .prepare(`SELECT * FROM tournament_scores WHERE tournament_id = ?`)
    .all(tournamentId) as ScoreRow[];
  return rows.map(rowToScore);
}

/**
 * Focused read for the live leaderboard. Joins contestants + scores +
 * verdict in three queries (each backed by an index) and assembles the
 * snapshot in JS. Designed to be cheap enough to call on every
 * `tournament:delta` push.
 */
export function readTournamentLeaderboard(
  connection: Database.Database,
  tournamentId: string
): TournamentLeaderboard {
  const tournament = findTournamentById(connection, tournamentId);
  const contestants = listContestantsByTournament(connection, tournamentId);
  const scores = listScoresByTournament(connection, tournamentId);

  const scoresByContestant = new Map<number, CriterionScore[]>();
  for (const score of scores) {
    const bucket = scoresByContestant.get(score.contestantIndex) ?? [];
    bucket.push(score);
    scoresByContestant.set(score.contestantIndex, bucket);
  }

  const totalsByContestant = new Map<number, number | null>();
  if (tournament.verdict) {
    for (const entry of tournament.verdict.totals) {
      totalsByContestant.set(entry.contestantIndex, entry.total);
    }
  }
  const rankByContestant = new Map<number, number>();
  if (tournament.verdict) {
    const ordered = [...tournament.verdict.totals].sort((a, b) => b.total - a.total);
    ordered.forEach((entry, idx) => rankByContestant.set(entry.contestantIndex, idx + 1));
  }

  const rows: TournamentLeaderboardRow[] = contestants.map((contestant) => ({
    contestant,
    scores: scoresByContestant.get(contestant.contestantIndex) ?? [],
    total: totalsByContestant.get(contestant.contestantIndex) ?? null,
    rank: rankByContestant.get(contestant.contestantIndex) ?? null
  }));

  return {
    tournament,
    rows,
    verdict: tournament.verdict
  };
}

/**
 * Re-load the policy snapshot for a finished tournament. Used by the
 * aggregator-only re-judge path so `findScoringPolicyById` is not needed.
 */
export function loadPolicySnapshot(
  connection: Database.Database,
  tournamentId: string
): ScoringPolicy {
  const tournament = findTournamentById(connection, tournamentId);
  return tournament.policySnapshot;
}

// Re-export for callers that want to look up the live (non-snapshot) policy.
export { findScoringPolicyById };
