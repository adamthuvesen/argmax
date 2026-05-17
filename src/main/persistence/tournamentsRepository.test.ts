// @vitest-environment node
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "./migrations.js";
import {
  BuiltInPolicyMutationError,
  InvalidPolicyError,
  deleteScoringPolicy,
  findScoringPolicyById,
  listScoringPolicies,
  saveScoringPolicy
} from "./scoringPoliciesRepository.js";
import {
  createContestant,
  createTournament,
  findContestantBySession,
  findTournamentById,
  listContestantsByTournament,
  listScoresByTournament,
  listTournaments,
  persistCriterionScore,
  readTournamentLeaderboard,
  setTournamentDecision,
  setTournamentVerdict,
  updateContestantOutcome,
  updateTournamentState
} from "./tournamentsRepository.js";
import type { ScoringPolicy } from "../../shared/types.js";

let connection: Database.Database;

function seedProject(id = "p1"): void {
  connection
    .prepare(
      `INSERT INTO projects (
         id, name, repo_path, current_branch, default_branch,
         default_provider, default_model_label, worktree_location,
         setup_command, check_commands_json, ui_preferences_json,
         created_at, updated_at
       ) VALUES (?, ?, ?, 'main', 'main', 'claude', 'Claude', '/tmp/wt', '', '[]', '{}', ?, ?)`
    )
    .run(id, `proj-${id}`, `/tmp/repo-${id}`, new Date().toISOString(), new Date().toISOString());
}

function seedWorkspace(id: string, projectId = "p1"): void {
  connection
    .prepare(
      `INSERT INTO workspaces (
         id, project_id, task_label, branch, base_ref, path, state,
         shared_workspace, dirty, changed_files, last_activity_at,
         created_at, updated_at, pinned
       ) VALUES (?, ?, ?, ?, 'main', ?, 'running', 0, 0, 0, ?, ?, ?, 0)`
    )
    .run(
      id,
      projectId,
      `task-${id}`,
      `branch-${id}`,
      `/tmp/${id}`,
      new Date().toISOString(),
      new Date().toISOString(),
      new Date().toISOString()
    );
}

function seedSession(sessionId: string, workspaceId: string): void {
  connection
    .prepare(
      `INSERT INTO sessions (
         id, workspace_id, provider, model_label, model_id,
         reasoning_effort, permission_mode, agent_mode, prompt,
         state, attention, started_at, last_activity_at,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd
       ) VALUES (?, ?, 'claude', 'Claude', 'sonnet', NULL, 'auto-approve', 'auto', 'p',
         'running', 'normal', ?, ?, 0, 0, 0, 0, 0)`
    )
    .run(sessionId, workspaceId, new Date().toISOString(), new Date().toISOString());
}

function freshPolicy(id: string, scope: "user" | "project" = "user", projectId: string | null = null): ScoringPolicy {
  return {
    id,
    name: `policy-${id}`,
    scope,
    projectId,
    isBuiltIn: false,
    criteria: [
      { id: "tests-pass", weight: 2, threshold: { op: "==", value: 1 } },
      { id: "diff-size-lines", weight: 1 }
    ],
    autoKeepRule: { min_total: 0.8, min_margin: 0.1 },
    tiesThreshold: 0.05,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

beforeEach(() => {
  connection = new Database(":memory:");
  runMigrations(connection);
});

afterEach(() => {
  connection.close();
});

describe("scoringPoliciesRepository", () => {
  it("seeds the three built-in presets at user scope", () => {
    const policies = listScoringPolicies(connection);
    const ids = policies.map((p) => p.id).sort();
    expect(ids).toEqual([
      "builtin:cheapest-green",
      "builtin:correctness-first",
      "builtin:smallest-diff"
    ]);
    for (const policy of policies) {
      expect(policy.isBuiltIn).toBe(true);
      expect(policy.scope).toBe("user");
      expect(policy.criteria.length).toBeGreaterThan(0);
    }
  });

  it("rejects deleting a built-in policy", () => {
    expect(() => deleteScoringPolicy(connection, "builtin:correctness-first")).toThrow(
      BuiltInPolicyMutationError
    );
  });

  it("rejects updating a built-in policy by id", () => {
    expect(() =>
      saveScoringPolicy(connection, {
        id: "builtin:correctness-first",
        name: "tampered",
        scope: "user",
        projectId: null,
        criteria: [{ id: "tests-pass", weight: 1 }],
        autoKeepRule: {},
        tiesThreshold: 0.05
      })
    ).toThrow(BuiltInPolicyMutationError);
  });

  it("creates and updates a custom user policy", () => {
    saveScoringPolicy(connection, {
      id: "custom-1",
      name: "Custom A",
      scope: "user",
      projectId: null,
      criteria: [{ id: "tests-pass", weight: 1 }],
      autoKeepRule: {},
      tiesThreshold: 0.05
    });
    const created = findScoringPolicyById(connection, "custom-1");
    expect(created.name).toBe("Custom A");
    expect(created.isBuiltIn).toBe(false);

    saveScoringPolicy(connection, {
      id: "custom-1",
      name: "Custom A v2",
      scope: "user",
      projectId: null,
      criteria: [{ id: "tests-pass", weight: 2 }],
      autoKeepRule: { min_total: 0.9 },
      tiesThreshold: 0.05
    });
    const updated = findScoringPolicyById(connection, "custom-1");
    expect(updated.name).toBe("Custom A v2");
    expect(updated.criteria[0]?.weight).toBe(2);
    expect(updated.autoKeepRule.min_total).toBe(0.9);
  });

  it("rejects policies with no criteria or zero weight sum", () => {
    expect(() =>
      saveScoringPolicy(connection, {
        id: "bad-1",
        name: "bad",
        scope: "user",
        projectId: null,
        criteria: [],
        autoKeepRule: {},
        tiesThreshold: 0.05
      })
    ).toThrow(InvalidPolicyError);

    expect(() =>
      saveScoringPolicy(connection, {
        id: "bad-2",
        name: "bad",
        scope: "user",
        projectId: null,
        criteria: [{ id: "tests-pass", weight: 0 }],
        autoKeepRule: {},
        tiesThreshold: 0.05
      })
    ).toThrow(InvalidPolicyError);
  });

  it("returns project-scoped policies alongside user-scope when filtered", () => {
    seedProject("p1");
    saveScoringPolicy(connection, {
      id: "proj-only",
      name: "Project A only",
      scope: "project",
      projectId: "p1",
      criteria: [{ id: "tests-pass", weight: 1 }],
      autoKeepRule: {},
      tiesThreshold: 0.05
    });

    const userOnly = listScoringPolicies(connection);
    expect(userOnly.find((p) => p.id === "proj-only")).toBeUndefined();

    const projectScoped = listScoringPolicies(connection, { projectId: "p1" });
    expect(projectScoped.find((p) => p.id === "proj-only")).toBeDefined();
  });
});

describe("tournamentsRepository — lifecycle", () => {
  it("creates a tournament with a frozen policy snapshot", () => {
    seedProject("p1");
    const policy = freshPolicy("snap-1");

    createTournament(connection, {
      id: "t1",
      projectId: "p1",
      taskLabel: "Add hello fn",
      prompt: "add a hello() function",
      quorum: 3,
      policySnapshot: policy
    });

    const tournament = findTournamentById(connection, "t1");
    expect(tournament.state).toBe("pending");
    expect(tournament.quorum).toBe(3);
    expect(tournament.policySnapshot.criteria[0]?.id).toBe("tests-pass");

    // Editing the source policy must not change the bound snapshot.
    const editedSnapshot = { ...policy, name: "edited", criteria: [{ id: "cost-usd", weight: 1 } as const] };
    saveScoringPolicy(connection, {
      id: editedSnapshot.id,
      name: editedSnapshot.name,
      scope: "user",
      projectId: null,
      criteria: editedSnapshot.criteria,
      autoKeepRule: {},
      tiesThreshold: 0.05
    });
    const refetched = findTournamentById(connection, "t1");
    expect(refetched.policySnapshot.name).toBe(policy.name);
    expect(refetched.policySnapshot.criteria[0]?.id).toBe("tests-pass");
  });

  it("links contestants to sessions and back", () => {
    seedProject("p1");
    seedWorkspace("ws1");
    seedWorkspace("ws2");
    seedSession("s1", "ws1");
    seedSession("s2", "ws2");

    createTournament(connection, {
      id: "t2",
      projectId: "p1",
      taskLabel: "task",
      prompt: "p",
      quorum: 2,
      policySnapshot: freshPolicy("snap-2")
    });

    createContestant(connection, {
      tournamentId: "t2",
      contestantIndex: 0,
      sessionId: "s1",
      config: { provider: "claude", modelId: "sonnet", modelLabel: "Claude Sonnet" }
    });
    createContestant(connection, {
      tournamentId: "t2",
      contestantIndex: 1,
      sessionId: "s2",
      config: { provider: "codex", modelId: "gpt-5.3-codex", modelLabel: "Codex Spark", reasoningEffort: "medium" }
    });

    const contestants = listContestantsByTournament(connection, "t2");
    expect(contestants).toHaveLength(2);
    expect(contestants[0]?.contestantIndex).toBe(0);
    expect(contestants[1]?.reasoningEffort).toBe("medium");

    const bySession = findContestantBySession(connection, "s2");
    expect(bySession.contestantIndex).toBe(1);

    // Session row should have been backfilled.
    const sessionRow = connection
      .prepare("SELECT tournament_id, contestant_index FROM sessions WHERE id = ?")
      .get("s2") as { tournament_id: string; contestant_index: number };
    expect(sessionRow.tournament_id).toBe("t2");
    expect(sessionRow.contestant_index).toBe(1);
  });

  it("transitions state and records verdict + decision", () => {
    seedProject("p1");
    createTournament(connection, {
      id: "t3",
      projectId: "p1",
      taskLabel: "task",
      prompt: "p",
      quorum: 2,
      policySnapshot: freshPolicy("snap-3")
    });

    updateTournamentState(connection, "t3", "running");
    expect(findTournamentById(connection, "t3").state).toBe("running");

    setTournamentVerdict(connection, "t3", {
      winner: 0,
      runnerUp: 1,
      margin: 0.2,
      ties: [],
      disqualified: [],
      totals: [
        { contestantIndex: 0, total: 0.95 },
        { contestantIndex: 1, total: 0.75 }
      ],
      computedAt: new Date().toISOString()
    });
    const withVerdict = findTournamentById(connection, "t3");
    expect(withVerdict.verdict?.winner).toBe(0);

    setTournamentDecision(connection, "t3", {
      keptContestantIndex: 0,
      source: "manual",
      overrodeWinner: false,
      decidedAt: new Date().toISOString()
    });
    const decided = findTournamentById(connection, "t3");
    expect(decided.state).toBe("decided");
    expect(decided.decidedAt).not.toBeNull();
    expect(decided.decision?.keptContestantIndex).toBe(0);
  });

  it("upserts criterion scores and reads them by tournament", () => {
    seedProject("p1");
    seedWorkspace("ws1");
    seedSession("s1", "ws1");
    createTournament(connection, {
      id: "t4",
      projectId: "p1",
      taskLabel: "task",
      prompt: "p",
      quorum: 1,
      policySnapshot: freshPolicy("snap-4")
    });
    createContestant(connection, {
      tournamentId: "t4",
      contestantIndex: 0,
      sessionId: "s1",
      config: { provider: "claude", modelId: "sonnet", modelLabel: "Claude" }
    });

    persistCriterionScore(connection, {
      tournamentId: "t4",
      contestantIndex: 0,
      criterionId: "tests-pass",
      status: "ok",
      rawValue: 1,
      normalizedValue: 1,
      evidence: { failing: [] }
    });
    persistCriterionScore(connection, {
      tournamentId: "t4",
      contestantIndex: 0,
      criterionId: "tests-pass",
      status: "ok",
      rawValue: 1,
      normalizedValue: 1,
      evidence: { failing: ["was-empty"] }
    });

    const scores = listScoresByTournament(connection, "t4");
    expect(scores).toHaveLength(1);
    expect((scores[0]?.evidence as { failing: string[] }).failing).toEqual(["was-empty"]);
  });

  it("readTournamentLeaderboard returns rows ordered by contestant_index with verdict ranks", () => {
    seedProject("p1");
    seedWorkspace("ws1");
    seedWorkspace("ws2");
    seedSession("s1", "ws1");
    seedSession("s2", "ws2");
    createTournament(connection, {
      id: "t5",
      projectId: "p1",
      taskLabel: "task",
      prompt: "p",
      quorum: 2,
      policySnapshot: freshPolicy("snap-5")
    });
    createContestant(connection, {
      tournamentId: "t5",
      contestantIndex: 0,
      sessionId: "s1",
      config: { provider: "claude", modelId: "sonnet", modelLabel: "Claude" }
    });
    createContestant(connection, {
      tournamentId: "t5",
      contestantIndex: 1,
      sessionId: "s2",
      config: { provider: "codex", modelId: "gpt-5.3-codex", modelLabel: "Codex" }
    });
    setTournamentVerdict(connection, "t5", {
      winner: 1,
      runnerUp: 0,
      margin: 0.3,
      ties: [],
      disqualified: [],
      totals: [
        { contestantIndex: 0, total: 0.5 },
        { contestantIndex: 1, total: 0.8 }
      ],
      computedAt: new Date().toISOString()
    });

    const board = readTournamentLeaderboard(connection, "t5");
    expect(board.rows.map((r) => r.contestant.contestantIndex)).toEqual([0, 1]);
    expect(board.rows.find((r) => r.contestant.contestantIndex === 1)?.rank).toBe(1);
    expect(board.rows.find((r) => r.contestant.contestantIndex === 0)?.rank).toBe(2);
  });

  it("updateContestantOutcome marks late finishers as outside-quorum", () => {
    seedProject("p1");
    seedWorkspace("ws1");
    seedSession("s1", "ws1");
    createTournament(connection, {
      id: "t6",
      projectId: "p1",
      taskLabel: "task",
      prompt: "p",
      quorum: 1,
      policySnapshot: freshPolicy("snap-6")
    });
    createContestant(connection, {
      tournamentId: "t6",
      contestantIndex: 0,
      sessionId: "s1",
      config: { provider: "claude", modelId: "sonnet", modelLabel: "Claude" }
    });
    updateContestantOutcome(connection, "t6", 0, "outside-quorum");
    const c = findContestantBySession(connection, "s1");
    expect(c.outcome).toBe("outside-quorum");
  });

  it("listTournaments scopes by project", () => {
    seedProject("p1");
    seedProject("p2");
    createTournament(connection, {
      id: "ta",
      projectId: "p1",
      taskLabel: "task",
      prompt: "p",
      quorum: 1,
      policySnapshot: freshPolicy("snap-a")
    });
    createTournament(connection, {
      id: "tb",
      projectId: "p2",
      taskLabel: "task",
      prompt: "p",
      quorum: 1,
      policySnapshot: freshPolicy("snap-b")
    });
    expect(listTournaments(connection, { projectId: "p1" }).map((t) => t.id)).toEqual(["ta"]);
    expect(listTournaments(connection, { projectId: "p2" }).map((t) => t.id)).toEqual(["tb"]);
    expect(listTournaments(connection).length).toBeGreaterThanOrEqual(2);
  });
});
