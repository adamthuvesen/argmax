// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createDatabase, type ArgmaxDatabase } from "../persistence/database.js";
import type { PersistProjectInput, PersistWorkspaceInput } from "../persistence/database.js";
import type { DashboardDelta, ProviderId } from "../../shared/types.js";
import type {
  ProviderAdapter,
  ProviderEvent,
  ProviderLaunchInput,
  ProviderSessionHandle
} from "./providerTypes.js";
import { ProviderSessionService } from "./providerSessionService.js";

/**
 * In-memory queue: messages composed while the agent is mid-turn don't reach
 * the provider until the current turn completes. These tests cover the four
 * states that matter — enqueue, drain, cancel, drop on terminal failure.
 */
describe("ProviderSessionService — pending-message queue", () => {
  it("queues a follow-up sent while a structured turn is still running", async () => {
    const database = createDatabase(":memory:", { seed: false });
    const workspace = persistWorkspaceFixture(database);
    const fakeProvider = createFakeProvider("codex");
    const deltas: DashboardDelta[] = [];
    const service = new ProviderSessionService(
      database,
      () => fakeProvider.adapter,
      (delta) => deltas.push(delta)
    );

    const session = await service.launch({
      workspaceId: workspace.id,
      provider: "codex",
      prompt: "Ship",
      modelLabel: "GPT-5.3 Codex Spark Low",
      modelId: "gpt-5.3-codex-spark",
      cols: 80,
      rows: 24
    });
    deltas.length = 0;

    const result = await service.sendInput(session.id, "next: write tests");
    expect(result).toEqual({ queued: true });

    const queue = service.getAllPendingMessages()[session.id];
    expect(queue).toHaveLength(1);
    expect(queue?.[0]?.content).toBe("next: write tests");

    // Renderer learns about the new chip via dashboard:delta, not by polling.
    const queueDelta = deltas.find((delta) => delta.pendingMessages?.[session.id]);
    expect(queueDelta?.pendingMessages?.[session.id]).toHaveLength(1);

    database.connection.close();
  });

  it("drains queued follow-ups in arrival order after the agent reaches complete", async () => {
    const database = createDatabase(":memory:", { seed: false });
    const workspace = persistWorkspaceFixture(database);
    const fakeProvider = createFakeProvider("codex");
    const service = new ProviderSessionService(database, () => fakeProvider.adapter);

    const session = await service.launch({
      workspaceId: workspace.id,
      provider: "codex",
      prompt: "Ship",
      modelLabel: "GPT-5.3 Codex Spark Low",
      modelId: "gpt-5.3-codex-spark",
      cols: 80,
      rows: 24
    });

    // Capture the conversation id so the re-launch path resumes the same thread.
    fakeProvider.emit({
      sessionId: session.id,
      type: "output",
      stream: "stdout",
      message: '{"type":"thread.started","thread_id":"thread-1"}\n',
      createdAt: "2026-05-08T16:00:00.000Z"
    });

    await service.sendInput(session.id, "first follow-up");
    await service.sendInput(session.id, "second follow-up");
    expect(service.getAllPendingMessages()[session.id]).toHaveLength(2);

    // First turn finishes → head of the queue drains and re-launches with the
    // first follow-up as the prompt. The second item stays queued.
    fakeProvider.emit({
      sessionId: session.id,
      type: "exit",
      stream: "system",
      message: "Codex structured probe exited with code 0.",
      exitCode: 0,
      createdAt: "2026-05-08T16:01:00.000Z"
    });
    await flushMicrotasks();

    expect(fakeProvider.launchInput?.prompt).toBe("first follow-up");
    expect(fakeProvider.launchInput?.resumeConversationId).toBe("thread-1");
    expect(service.getAllPendingMessages()[session.id]).toHaveLength(1);

    // Second turn finishes → the remaining queued message drains.
    fakeProvider.emit({
      sessionId: session.id,
      type: "exit",
      stream: "system",
      message: "Codex structured probe exited with code 0.",
      exitCode: 0,
      createdAt: "2026-05-08T16:02:00.000Z"
    });
    await flushMicrotasks();

    expect(fakeProvider.launchInput?.prompt).toBe("second follow-up");
    expect(service.getAllPendingMessages()).toEqual({});

    database.connection.close();
  });

  it("cancelQueuedMessage drops only the named entry and pushes an updated delta", async () => {
    const database = createDatabase(":memory:", { seed: false });
    const workspace = persistWorkspaceFixture(database);
    const fakeProvider = createFakeProvider("codex");
    const deltas: DashboardDelta[] = [];
    const service = new ProviderSessionService(
      database,
      () => fakeProvider.adapter,
      (delta) => deltas.push(delta)
    );

    const session = await service.launch({
      workspaceId: workspace.id,
      provider: "codex",
      prompt: "Ship",
      modelLabel: "GPT-5.3 Codex Spark Low",
      modelId: "gpt-5.3-codex-spark",
      cols: 80,
      rows: 24
    });

    await service.sendInput(session.id, "first");
    await service.sendInput(session.id, "second");
    const queueBefore = service.getAllPendingMessages()[session.id];
    expect(queueBefore).toHaveLength(2);

    deltas.length = 0;
    service.cancelQueuedMessage(session.id, queueBefore[0].id);

    const queueAfter = service.getAllPendingMessages()[session.id];
    expect(queueAfter).toHaveLength(1);
    expect(queueAfter[0]?.content).toBe("second");

    const removalDelta = deltas.find((delta) => delta.pendingMessages?.[session.id]);
    expect(removalDelta?.pendingMessages?.[session.id]).toHaveLength(1);

    database.connection.close();
  });

  it("drops the queue when the session fails so a dead session doesn't auto-flush", async () => {
    const database = createDatabase(":memory:", { seed: false });
    const workspace = persistWorkspaceFixture(database);
    const fakeProvider = createFakeProvider("codex");
    const service = new ProviderSessionService(database, () => fakeProvider.adapter);

    const session = await service.launch({
      workspaceId: workspace.id,
      provider: "codex",
      prompt: "Ship",
      modelLabel: "GPT-5.3 Codex Spark Low",
      modelId: "gpt-5.3-codex-spark",
      cols: 80,
      rows: 24
    });

    await service.sendInput(session.id, "stranded follow-up");
    expect(service.getAllPendingMessages()[session.id]).toHaveLength(1);

    fakeProvider.emit({
      sessionId: session.id,
      type: "exit",
      stream: "system",
      message: "Codex crashed.",
      exitCode: 1,
      createdAt: "2026-05-08T16:01:00.000Z"
    });
    await flushMicrotasks();

    expect(service.getAllPendingMessages()).toEqual({});
    // Failure must not have triggered a re-launch carrying the queued message.
    expect(fakeProvider.launchInput?.prompt).toBe("Ship");

    database.connection.close();
  });

  it("terminate clears the queue before tearing the session down", async () => {
    const database = createDatabase(":memory:", { seed: false });
    const workspace = persistWorkspaceFixture(database);
    const fakeProvider = createFakeProvider("codex");
    const service = new ProviderSessionService(database, () => fakeProvider.adapter);

    const session = await service.launch({
      workspaceId: workspace.id,
      provider: "codex",
      prompt: "Ship",
      modelLabel: "GPT-5.3 Codex Spark Low",
      modelId: "gpt-5.3-codex-spark",
      cols: 80,
      rows: 24
    });

    await service.sendInput(session.id, "queued before stop");
    expect(service.getAllPendingMessages()[session.id]).toHaveLength(1);

    await service.terminate(session.id);

    expect(service.getAllPendingMessages()).toEqual({});

    database.connection.close();
  });
});

/** Resolves once enqueued microtasks (the drain hop) have a chance to run. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createFakeProvider(provider: ProviderId): {
  adapter: ProviderAdapter;
  emit: (event: ProviderEvent) => void;
  launchInput: ProviderLaunchInput | null;
} {
  let onEvent: ((event: ProviderEvent) => void) | null = null;
  const state = {
    launchInput: null as ProviderLaunchInput | null
  };

  return {
    adapter: {
      id: provider,
      displayName: provider,
      binaryName: provider,
      discover: () => {
        throw new Error("Not used in queue tests");
      },
      launch: (input, callback) => {
        state.launchInput = input;
        onEvent = callback;
        const handle: ProviderSessionHandle = {
          sessionId: input.sessionId,
          provider,
          // structured-json mode is the default for Codex/Claude/Cursor, which
          // means acceptsInput is false — the busy state the queue is built for.
          acceptsInput: input.mode === "interactive-pty",
          disposed: false,
          sendInput: () => undefined,
          resize: () => undefined,
          terminate: () => {
            handle.disposed = true;
            return Promise.resolve();
          }
        };
        return Promise.resolve(handle);
      }
    },
    emit: (event) => {
      if (!onEvent) {
        throw new Error("Provider session was not launched");
      }
      onEvent(event);
    },
    get launchInput() {
      return state.launchInput;
    }
  };
}

function persistWorkspaceFixture(database: ArgmaxDatabase): ReturnType<ArgmaxDatabase["persistWorkspace"]> {
  const project: PersistProjectInput = {
    id: "project-queue",
    name: "Queue fixture",
    repoPath: "/repo",
    currentBranch: "main",
    defaultBranch: "main",
    settings: {
      defaultProvider: "codex",
      defaultModelLabel: "GPT-5.3 Codex Spark Low",
      worktreeLocation: "/repo/.worktrees",
      setupCommand: "",
      checkCommands: []
    }
  };
  database.persistProject(project);

  const workspace: PersistWorkspaceInput = {
    id: "workspace-queue",
    projectId: project.id,
    taskLabel: "Queue follow-ups",
    branch: "argmax/queue",
    baseRef: "main",
    path: "/repo/.worktrees/queue",
    state: "created",
    sharedWorkspace: false,
    dirty: false,
    changedFiles: 0
  };

  return database.persistWorkspace(workspace);
}
