import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TournamentPanel } from "./TournamentPanel.js";
import type {
  ProjectSummary,
  ScoringPolicy,
  Tournament,
  TournamentLeaderboard
} from "../../shared/types.js";

const project: ProjectSummary = {
  id: "p1",
  name: "Argmax",
  repoPath: "/tmp/argmax",
  currentBranch: "main",
  defaultBranch: "main",
  settings: {
    defaultProvider: "claude",
    defaultModelLabel: "Claude",
    worktreeLocation: "/tmp/wt",
    setupCommand: "",
    checkCommands: ["npm test"]
  },
  counts: { active: 0, blocked: 0, failed: 0, reviewReady: 0 },
  latestActivityAt: null
};

function builtInPolicy(id: string, name: string): ScoringPolicy {
  return {
    id,
    name,
    scope: "user",
    projectId: null,
    isBuiltIn: true,
    criteria: [
      { id: "tests-pass", weight: 2, threshold: { op: "==", value: 1 } },
      { id: "diff-size-lines", weight: 1 }
    ],
    autoKeepRule: {},
    tiesThreshold: 0.05,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function tournament(id: string, state: Tournament["state"] = "running"): Tournament {
  return {
    id,
    projectId: "p1",
    taskLabel: `task-${id}`,
    prompt: "do the thing",
    state,
    quorum: 2,
    policyId: "builtin:correctness-first",
    policySnapshot: builtInPolicy("builtin:correctness-first", "Correctness first"),
    verdict: null,
    decision: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    decidedAt: null
  };
}

function leaderboardWithVerdict(): TournamentLeaderboard {
  const t = tournament("t1", "awaiting-decision");
  t.verdict = {
    winner: 0,
    runnerUp: 1,
    margin: 0.3,
    ties: [],
    disqualified: [],
    totals: [
      { contestantIndex: 0, total: 0.9 },
      { contestantIndex: 1, total: 0.6 }
    ],
    computedAt: "2026-01-01T00:00:00.000Z"
  };
  return {
    tournament: t,
    rows: [
      {
        contestant: {
          tournamentId: "t1",
          contestantIndex: 0,
          sessionId: "s0",
          provider: "claude",
          modelId: "claude-haiku-4-5",
          modelLabel: "Claude Haiku 4.5",
          reasoningEffort: null,
          config: {},
          outcome: "in-quorum",
          createdAt: "2026-01-01T00:00:00.000Z"
        },
        scores: [],
        total: 0.9,
        rank: 1
      },
      {
        contestant: {
          tournamentId: "t1",
          contestantIndex: 1,
          sessionId: "s1",
          provider: "codex",
          modelId: "gpt-5.3-codex-spark",
          modelLabel: "Codex Spark",
          reasoningEffort: "medium",
          config: {},
          outcome: "in-quorum",
          createdAt: "2026-01-01T00:00:00.000Z"
        },
        scores: [],
        total: 0.6,
        rank: 2
      }
    ],
    verdict: t.verdict
  };
}

const launch = vi.fn<(input: unknown) => Promise<Tournament>>();
const list = vi.fn<() => Promise<Tournament[]>>();
const get = vi.fn<() => Promise<TournamentLeaderboard>>();
const keep = vi.fn<() => Promise<TournamentLeaderboard>>();
const listPolicies = vi.fn<() => Promise<ScoringPolicy[]>>();

beforeEach(() => {
  launch.mockReset();
  list.mockReset();
  get.mockReset();
  keep.mockReset();
  listPolicies.mockReset();
  list.mockResolvedValue([]);
  listPolicies.mockResolvedValue([
    builtInPolicy("builtin:correctness-first", "Correctness first"),
    builtInPolicy("builtin:smallest-diff", "Smallest diff")
  ]);
  vi.stubGlobal("window", Object.assign(window, {
    argmax: {
      tournaments: { launch, list, get, keep },
      scoring: { listPolicies }
    }
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TournamentPanel", () => {
  it("loads policies and renders the launch form with two contestants by default", async () => {
    render(<TournamentPanel project={project} />);
    await waitFor(() => expect(listPolicies).toHaveBeenCalled());
    expect(screen.getByLabelText("Task label")).toBeInTheDocument();
    expect(screen.getByLabelText("Prompt")).toBeInTheDocument();
    // Two contestants by default: provider selectors with aria-labels.
    expect(screen.getByLabelText("Contestant 1 provider")).toBeInTheDocument();
    expect(screen.getByLabelText("Contestant 2 provider")).toBeInTheDocument();
    // Remove buttons disabled when at the minimum of 2.
    expect(screen.getByLabelText("Remove contestant 1")).toBeDisabled();
    expect(screen.getByLabelText("Remove contestant 2")).toBeDisabled();
  });

  it("launches a tournament with the entered task + prompt + selected policy", async () => {
    const t = tournament("t-new");
    launch.mockResolvedValue(t);
    list.mockResolvedValueOnce([]).mockResolvedValueOnce([t]);
    get.mockResolvedValue({ tournament: t, rows: [], verdict: null });

    render(<TournamentPanel project={project} />);
    await waitFor(() => expect(listPolicies).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText("Task label"), { target: { value: "Add hello" } });
    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "add a hello() function with a passing test" }
    });
    fireEvent.click(screen.getByLabelText("Launch tournament"));

    await waitFor(() => expect(launch).toHaveBeenCalledTimes(1));
    const arg = launch.mock.calls[0]?.[0] as { contestants: unknown[]; taskLabel: string; prompt: string; policyId: string };
    expect(arg.taskLabel).toBe("Add hello");
    expect(arg.prompt).toBe("add a hello() function with a passing test");
    expect(arg.policyId).toBe("builtin:correctness-first");
    expect(arg.contestants).toHaveLength(2);
  });

  it("renders the leaderboard with rank, totals, and a Keep button when awaiting decision", async () => {
    const board = leaderboardWithVerdict();
    list.mockResolvedValueOnce([board.tournament]);
    get.mockResolvedValue(board);

    render(<TournamentPanel project={project} />);
    await waitFor(() => expect(list).toHaveBeenCalled());

    fireEvent.click(screen.getByLabelText(`Open tournament ${board.tournament.taskLabel}`));
    await waitFor(() => expect(get).toHaveBeenCalled());
    await screen.findByLabelText("Leaderboard");

    expect(screen.getByLabelText("Keep contestant 1")).toBeInTheDocument();
    expect(screen.getByLabelText("Keep contestant 2")).toBeInTheDocument();
  });

  it("calls tournaments.keep when the user clicks Keep", async () => {
    const board = leaderboardWithVerdict();
    list.mockResolvedValueOnce([board.tournament]);
    get.mockResolvedValue(board);
    keep.mockResolvedValue({
      ...board,
      tournament: { ...board.tournament, state: "decided", decision: { keptContestantIndex: 0, source: "manual", overrodeWinner: false, decidedAt: "x" } }
    });

    render(<TournamentPanel project={project} />);
    await waitFor(() => expect(list).toHaveBeenCalled());

    fireEvent.click(screen.getByLabelText(`Open tournament ${board.tournament.taskLabel}`));
    await screen.findByLabelText("Keep contestant 1");
    fireEvent.click(screen.getByLabelText("Keep contestant 1"));
    await waitFor(() =>
      expect(keep).toHaveBeenCalledWith({ tournamentId: "t1", contestantIndex: 0 })
    );
  });

  it("blocks launch and shows error when prompt is empty", async () => {
    render(<TournamentPanel project={project} />);
    await waitFor(() => expect(listPolicies).toHaveBeenCalled());
    expect(screen.getByLabelText("Launch tournament")).toBeDisabled();
  });
});
