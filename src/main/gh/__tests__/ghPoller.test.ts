// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDatabase, type ArgmaxDatabase } from "../../persistence/database.js";
import type { GhPrRecord, ProjectSettings, SessionSummary } from "../../../shared/types.js";
import { GhPoller, type CheckFailureContext, type GhPollerDeps } from "../ghPoller.js";

const settings: ProjectSettings = {
  defaultProvider: "codex",
  defaultModelLabel: "Codex Spark",
  worktreeLocation: "/tmp/wt",
  setupCommand: "",
  checkCommands: []
};

function seed(database: ArgmaxDatabase): { sessionId: string; workspaceId: string } {
  const projectId = "p-poll";
  const workspaceId = "ws-poll";
  const sessionId = "session-poll";
  database.persistProject({
    id: projectId,
    name: "poll",
    repoPath: "/tmp/repo-poll",
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
    path: "/tmp/repo-poll-wt",
    state: "running",
    sharedWorkspace: false,
    dirty: false,
    changedFiles: 0
  });
  database.persistSession({
    id: sessionId,
    workspaceId,
    provider: "codex",
    modelLabel: "Codex Spark",
    modelId: "gpt-5.3-codex-spark",
    reasoningEffort: "medium",
    prompt: "p",
    state: "running",
    attention: "normal"
  });
  return { sessionId, workspaceId };
}

function makeRow(over: Partial<GhPrRecord>): GhPrRecord {
  return {
    sessionId: "session-poll",
    prNumber: 1,
    headSha: "sha-1",
    lastSeenCheckState: "failure",
    updatedAt: "2026-05-13T08:00:00.000Z",
    ...over
  };
}

describe("GhPoller.tick", () => {
  it("schedules a follow-up session when a PR transitions to failure", async () => {
    const database = createDatabase(":memory:", { seed: false });
    const { sessionId, workspaceId } = seed(database);

    const refresh = vi.fn<(sid: string) => Promise<GhPrRecord[]>>().mockResolvedValue([makeRow({ sessionId })]);
    const launchFollowUp = vi.fn<(ctx: CheckFailureContext) => Promise<void>>().mockResolvedValue();

    const poller = new GhPoller({
      database,
      ghService: { refresh },
      launchFollowUp
    });

    await poller.tick();

    expect(refresh).toHaveBeenCalledWith(sessionId);
    expect(launchFollowUp).toHaveBeenCalledTimes(1);
    expect(launchFollowUp).toHaveBeenCalledWith({
      sessionId,
      workspaceId,
      prNumber: 1,
      headSha: "sha-1"
    });
    database.connection.close();
  });

  it("does not re-queue when the same (session, pr, sha) stays failing across ticks", async () => {
    const database = createDatabase(":memory:", { seed: false });
    const { sessionId } = seed(database);

    const refresh = vi.fn<(sid: string) => Promise<GhPrRecord[]>>().mockResolvedValue([makeRow({ sessionId })]);
    const launchFollowUp = vi.fn<(ctx: CheckFailureContext) => Promise<void>>().mockResolvedValue();

    const poller = new GhPoller({
      database,
      ghService: { refresh },
      launchFollowUp
    });

    await poller.tick();
    await poller.tick();
    await poller.tick();

    expect(launchFollowUp).toHaveBeenCalledTimes(1);
    database.connection.close();
  });

  it("re-queues when a new head SHA also fails (commit pushed, still broken)", async () => {
    const database = createDatabase(":memory:", { seed: false });
    const { sessionId } = seed(database);

    const refresh = vi
      .fn<(sid: string) => Promise<GhPrRecord[]>>()
      .mockResolvedValueOnce([makeRow({ sessionId, headSha: "sha-1" })])
      .mockResolvedValueOnce([makeRow({ sessionId, headSha: "sha-2" })]);
    const launchFollowUp = vi.fn<(ctx: CheckFailureContext) => Promise<void>>().mockResolvedValue();

    const poller = new GhPoller({
      database,
      ghService: { refresh },
      launchFollowUp
    });

    await poller.tick();
    await poller.tick();

    expect(launchFollowUp).toHaveBeenCalledTimes(2);
    expect(launchFollowUp.mock.calls[1]?.[0].headSha).toBe("sha-2");
    database.connection.close();
  });

  it("does nothing when the state is not failure", async () => {
    const database = createDatabase(":memory:", { seed: false });
    const { sessionId } = seed(database);

    const refresh = vi
      .fn<(sid: string) => Promise<GhPrRecord[]>>()
      .mockResolvedValue([makeRow({ sessionId, lastSeenCheckState: "pending" })]);
    const launchFollowUp = vi.fn<(ctx: CheckFailureContext) => Promise<void>>().mockResolvedValue();

    const poller = new GhPoller({
      database,
      ghService: { refresh },
      launchFollowUp
    });

    await poller.tick();

    expect(launchFollowUp).not.toHaveBeenCalled();
    database.connection.close();
  });

  it("fires a check-failure notification on the transition", async () => {
    const database = createDatabase(":memory:", { seed: false });
    const { sessionId } = seed(database);

    const refresh = vi.fn<(sid: string) => Promise<GhPrRecord[]>>().mockResolvedValue([makeRow({ sessionId })]);
    const notifyCheckFailure = vi.fn<(session: SessionSummary, pr: GhPrRecord) => void>();
    const notifications = { notifyCheckFailure } as unknown as GhPollerDeps["notifications"];

    const poller = new GhPoller({
      database,
      ghService: { refresh },
      notifications,
      launchFollowUp: () => Promise.resolve()
    });

    await poller.tick();

    expect(notifyCheckFailure).toHaveBeenCalledTimes(1);
    expect(notifyCheckFailure.mock.calls[0]?.[0]?.id).toBe(sessionId);
    expect(notifyCheckFailure.mock.calls[0]?.[1]?.prNumber).toBe(1);
    database.connection.close();
  });
});
