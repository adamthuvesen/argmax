// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createDatabase, type ArgmaxDatabase } from "../../persistence/database.js";
import type { ProjectSettings } from "../../../shared/types.js";
import { GhService, type GhRunner } from "../ghService.js";

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
  const projectId = "p-gh";
  const workspaceId = "ws-gh";
  const sessionId = "session-gh";
  database.persistProject({
    id: projectId,
    name: "gh",
    repoPath: "/tmp/repo-gh",
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
    path: "/tmp/repo-gh-wt",
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

function makeRunner(responses: Record<string, string | Error>): GhRunner {
  return (_cwd, args) => {
    const key = args.join(" ");
    const response = responses[key];
    if (response === undefined) {
      return Promise.reject(new Error(`no stub for gh ${key}`));
    }
    if (response instanceof Error) return Promise.reject(response);
    return Promise.resolve(response);
  };
}

describe("GhService.detectAndStoreRemote", () => {
  it("parses gh repo view and stores owner+name on the project", async () => {
    const database = createDatabase(":memory:", { seed: false });
    const { projectId } = seedProjectWorkspaceSession(database);

    const runner = makeRunner({
      "repo view --json owner,name": JSON.stringify({ owner: { login: "acme" }, name: "widgets" })
    });
    const service = new GhService(database, runner);

    const result = await service.detectAndStoreRemote(projectId);
    expect(result).toEqual({ owner: "acme", name: "widgets" });
    expect(database.getProjectRemote(projectId)).toEqual({ owner: "acme", name: "widgets" });
    database.connection.close();
  });

  it("returns null when gh fails (no remote, gh not installed)", async () => {
    const database = createDatabase(":memory:", { seed: false });
    const { projectId } = seedProjectWorkspaceSession(database);

    const runner = makeRunner({
      "repo view --json owner,name": new Error("gh: not installed")
    });
    const service = new GhService(database, runner);

    expect(await service.detectAndStoreRemote(projectId)).toBeNull();
    expect(database.getProjectRemote(projectId)).toBeNull();
    database.connection.close();
  });
});

describe("GhService.refresh", () => {
  it("populates gh_pr from a gh pr view payload and rolls up to 'failure' on any failed check", async () => {
    const database = createDatabase(":memory:", { seed: false });
    const { sessionId } = seedProjectWorkspaceSession(database);

    const runner = makeRunner({
      "pr view --json number,headRefOid,state,statusCheckRollup": JSON.stringify({
        number: 42,
        headRefOid: "deadbeef".repeat(5),
        statusCheckRollup: [
          { conclusion: "SUCCESS" },
          { conclusion: "FAILURE" },
          { conclusion: "SUCCESS" }
        ]
      })
    });
    const service = new GhService(database, runner);

    const rows = await service.refresh(sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId,
      prNumber: 42,
      lastSeenCheckState: "failure"
    });
    expect(database.listGhPrForSession(sessionId)).toHaveLength(1);
    database.connection.close();
  });

  it("rolls up to 'pending' when at least one check is in progress and none failed", async () => {
    const database = createDatabase(":memory:", { seed: false });
    const { sessionId } = seedProjectWorkspaceSession(database);

    const runner = makeRunner({
      "pr view --json number,headRefOid,state,statusCheckRollup": JSON.stringify({
        number: 7,
        headRefOid: "abc",
        statusCheckRollup: [{ status: "IN_PROGRESS" }, { conclusion: "SUCCESS" }]
      })
    });
    const service = new GhService(database, runner);

    const rows = await service.refresh(sessionId);
    expect(rows[0]?.lastSeenCheckState).toBe("pending");
    database.connection.close();
  });

  it("returns existing rows and skips the write when gh exits non-zero (no PR yet)", async () => {
    const database = createDatabase(":memory:", { seed: false });
    const { sessionId } = seedProjectWorkspaceSession(database);

    const runner = makeRunner({
      "pr view --json number,headRefOid,state,statusCheckRollup": new Error("no pull requests found")
    });
    const service = new GhService(database, runner);

    const rows = await service.refresh(sessionId);
    expect(rows).toEqual([]);
    database.connection.close();
  });

  it("upserts on a second refresh — new head SHA wins, same (session, pr) row", async () => {
    const database = createDatabase(":memory:", { seed: false });
    const { sessionId } = seedProjectWorkspaceSession(database);

    const firstRunner = makeRunner({
      "pr view --json number,headRefOid,state,statusCheckRollup": JSON.stringify({
        number: 12,
        headRefOid: "sha-1",
        statusCheckRollup: [{ conclusion: "SUCCESS" }]
      })
    });
    await new GhService(database, firstRunner).refresh(sessionId);

    const secondRunner = makeRunner({
      "pr view --json number,headRefOid,state,statusCheckRollup": JSON.stringify({
        number: 12,
        headRefOid: "sha-2",
        statusCheckRollup: [{ conclusion: "FAILURE" }]
      })
    });
    const rows = await new GhService(database, secondRunner).refresh(sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.headSha).toBe("sha-2");
    expect(rows[0]?.lastSeenCheckState).toBe("failure");
    database.connection.close();
  });
});
