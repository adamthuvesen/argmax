// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createDatabase, type ArgmaxDatabase } from "../../persistence/database.js";
import type { ProjectSettings } from "../../../shared/types.js";
import { GhService, type GhRunner } from "../../gh/ghService.js";
import { GitOpsService, type GitRunner } from "../gitOpsService.js";

const settings: ProjectSettings = {
  defaultProvider: "codex",
  defaultModelLabel: "GPT-5.3 Codex Spark Low",
  worktreeLocation: "/tmp/wt",
  setupCommand: "",
  checkCommands: []
};

function seedProjectWorkspaceSession(database: ArgmaxDatabase): {
  projectId: string;
  workspaceId: string;
  sessionId: string;
} {
  const projectId = "p-git";
  const workspaceId = "ws-git";
  const sessionId = "session-git";
  database.persistProject({
    id: projectId,
    name: "git",
    repoPath: "/tmp/repo-git",
    currentBranch: "feature/x",
    defaultBranch: "main",
    settings
  });
  database.persistWorkspace({
    id: workspaceId,
    projectId,
    taskLabel: "task",
    branch: "feature/x",
    baseRef: "main",
    path: "/tmp/repo-git-wt",
    state: "running",
    sharedWorkspace: false,
    dirty: false,
    changedFiles: 0
  });
  database.persistSession({
    id: sessionId,
    workspaceId,
    provider: "codex",
    modelLabel: "x",
    modelId: "gpt-5.3-codex",
    reasoningEffort: "medium",
    prompt: "p",
    state: "running",
    attention: "normal"
  });
  return { projectId, workspaceId, sessionId };
}

interface GitCall {
  cwd: string;
  args: string[];
}

interface MakeGitRunnerOptions {
  responses?: Record<string, string | Error>;
  defaultResponse?: string;
}

function makeGitRunner(options: MakeGitRunnerOptions = {}): {
  runner: GitRunner;
  calls: GitCall[];
} {
  const calls: GitCall[] = [];
  const runner: GitRunner = (cwd, args) => {
    calls.push({ cwd, args });
    const key = args.join(" ");
    const response = options.responses?.[key];
    if (response instanceof Error) return Promise.reject(response);
    if (response !== undefined) return Promise.resolve(response);
    if (options.defaultResponse !== undefined) return Promise.resolve(options.defaultResponse);
    return Promise.resolve("");
  };
  return { runner, calls };
}

function makeGhRunner(responses: Record<string, string | Error>): GhRunner {
  return (_cwd, args) => {
    const key = args.join(" ");
    const response = responses[key];
    if (response === undefined) return Promise.reject(new Error(`no stub for gh ${key}`));
    if (response instanceof Error) return Promise.reject(response);
    return Promise.resolve(response);
  };
}

describe("GitOpsService.commitAll", () => {
  it("stages everything, commits with the message, and returns sha + branch", async () => {
    const database = createDatabase(":memory:", { seed: false });
    const { workspaceId } = seedProjectWorkspaceSession(database);
    const { runner, calls } = makeGitRunner({
      responses: {
        "rev-parse HEAD": "deadbeefcafe\n",
        "branch --show-current": "feature/x\n"
      }
    });
    const ghService = new GhService(database);
    const service = new GitOpsService(database, ghService, runner);

    const result = await service.commitAll({ workspaceId, message: "wip: stuff" });

    expect(result).toEqual({ commitSha: "deadbeefcafe", branch: "feature/x" });
    expect(calls.map((c) => c.args)).toEqual([
      ["add", "-A"],
      ["commit", "-m", "wip: stuff"],
      ["rev-parse", "HEAD"],
      ["branch", "--show-current"]
    ]);
    expect(calls[0].cwd).toBe("/tmp/repo-git-wt");
  });
});

describe("GitOpsService.push", () => {
  it("does a plain push when an upstream is already set", async () => {
    const database = createDatabase(":memory:", { seed: false });
    const { workspaceId } = seedProjectWorkspaceSession(database);
    const { runner, calls } = makeGitRunner({
      responses: {
        "branch --show-current": "feature/x\n",
        push: ""
      }
    });
    const service = new GitOpsService(database, new GhService(database), runner);

    const result = await service.push({ workspaceId });

    expect(result).toEqual({ branch: "feature/x", upstreamSet: false });
    expect(calls.map((c) => c.args.join(" "))).toEqual(["branch --show-current", "push"]);
  });

  it("falls back to push -u origin <branch> when no upstream is configured", async () => {
    const database = createDatabase(":memory:", { seed: false });
    const { workspaceId } = seedProjectWorkspaceSession(database);
    const { runner, calls } = makeGitRunner({
      responses: {
        "branch --show-current": "feature/x\n",
        push: new Error(
          "git failed: fatal: The current branch feature/x has no upstream branch."
        ),
        "push -u origin feature/x": ""
      }
    });
    const service = new GitOpsService(database, new GhService(database), runner);

    const result = await service.push({ workspaceId });

    expect(result).toEqual({ branch: "feature/x", upstreamSet: true });
    expect(calls.map((c) => c.args.join(" "))).toEqual([
      "branch --show-current",
      "push",
      "push -u origin feature/x"
    ]);
  });

  it("rethrows non-upstream push failures", async () => {
    const database = createDatabase(":memory:", { seed: false });
    const { workspaceId } = seedProjectWorkspaceSession(database);
    const { runner } = makeGitRunner({
      responses: {
        "branch --show-current": "feature/x\n",
        push: new Error("git failed: error: failed to push some refs")
      }
    });
    const service = new GitOpsService(database, new GhService(database), runner);

    await expect(service.push({ workspaceId })).rejects.toThrow(/failed to push some refs/);
  });
});

describe("GitOpsService.createBranch", () => {
  it("runs git checkout -b with the validated branch name", async () => {
    const database = createDatabase(":memory:", { seed: false });
    const { workspaceId } = seedProjectWorkspaceSession(database);
    const { runner, calls } = makeGitRunner();
    const service = new GitOpsService(database, new GhService(database), runner);

    const result = await service.createBranch({ workspaceId, branch: "feature/new-thing" });

    expect(result).toEqual({ branch: "feature/new-thing" });
    expect(calls).toEqual([
      { cwd: "/tmp/repo-git-wt", args: ["checkout", "-b", "feature/new-thing"] }
    ]);
  });
});

describe("GitOpsService.viewOrCreatePr", () => {
  it("returns the GitHub URL for an existing PR record without shelling out to gh", async () => {
    const database = createDatabase(":memory:", { seed: false });
    const { projectId, sessionId } = seedProjectWorkspaceSession(database);
    database.updateProjectRemote(projectId, { owner: "acme", name: "widgets" });
    database.upsertGhPr({
      sessionId,
      prNumber: 42,
      headSha: "abc123",
      lastSeenCheckState: "success",
      updatedAt: new Date().toISOString()
    });

    const { runner } = makeGitRunner();
    const ghRunner = makeGhRunner({}); // would reject if called
    const service = new GitOpsService(
      database,
      new GhService(database, ghRunner),
      runner,
      ghRunner
    );

    const result = await service.viewOrCreatePr({ sessionId });

    expect(result).toEqual({
      action: "opened",
      url: "https://github.com/acme/widgets/pull/42",
      prNumber: 42
    });
  });

  it("runs gh pr create --fill, parses the PR URL, and refreshes the gh_pr cache", async () => {
    const database = createDatabase(":memory:", { seed: false });
    const { projectId, sessionId } = seedProjectWorkspaceSession(database);
    database.updateProjectRemote(projectId, { owner: "acme", name: "widgets" });

    const { runner } = makeGitRunner();
    const ghRunner = makeGhRunner({
      "pr create --fill":
        "Creating pull request for feature/x into main in acme/widgets\n" +
        "https://github.com/acme/widgets/pull/77\n",
      "pr view --json number,headRefOid,statusCheckRollup": JSON.stringify({
        number: 77,
        headRefOid: "newsha",
        statusCheckRollup: []
      })
    });
    const service = new GitOpsService(
      database,
      new GhService(database, ghRunner),
      runner,
      ghRunner
    );

    const result = await service.viewOrCreatePr({ sessionId });

    expect(result.action).toBe("created");
    expect(result.url).toBe("https://github.com/acme/widgets/pull/77");
    expect(result.prNumber).toBe(77);
    expect(database.listGhPrForSession(sessionId)).toHaveLength(1);
  });

  it("throws when gh pr create returns no parseable URL", async () => {
    const database = createDatabase(":memory:", { seed: false });
    const { sessionId } = seedProjectWorkspaceSession(database);
    const { runner } = makeGitRunner();
    const ghRunner = makeGhRunner({ "pr create --fill": "weird output without url\n" });
    const service = new GitOpsService(
      database,
      new GhService(database, ghRunner),
      runner,
      ghRunner
    );

    await expect(service.viewOrCreatePr({ sessionId })).rejects.toThrow(/did not return a PR URL/);
  });
});
