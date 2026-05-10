// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDatabase, type MaestroDatabase } from "../persistence/database.js";
import type { PersistProjectInput, PersistWorkspaceInput } from "../persistence/database.js";
import type { DashboardDelta, ProviderId } from "../../shared/types.js";
import type { ProviderAdapter, ProviderEvent, ProviderLaunchInput, ProviderSessionHandle } from "./providerTypes.js";
import { ProviderSessionService } from "./providerSessionService.js";

describe("ProviderSessionService", () => {
  it("publishes initial dashboard rows after launching a provider session", async () => {
    const database = createDatabase(":memory:", { seed: false });
    const workspace = persistWorkspaceFixture(database);
    const fakeProvider = createFakeProvider("claude");
    const deltas: DashboardDelta[] = [];
    const service = new ProviderSessionService(database, () => fakeProvider.adapter, (delta) => deltas.push(delta));

    const session = await service.launch({
      workspaceId: workspace.id,
      provider: "claude",
      prompt: "Ship the cockpit",
      modelLabel: "Claude Haiku",
      modelId: "haiku",
      cols: 100,
      rows: 30
    });

    expect(deltas).toContainEqual(
      expect.objectContaining({
        projects: expect.any(Array) as unknown,
        workspaces: [expect.objectContaining({ id: workspace.id, state: "running" })],
        sessions: [expect.objectContaining({ id: session.id, state: "running" })],
        events: [
          expect.objectContaining({ sessionId: session.id, type: "user.message" }),
          expect.objectContaining({ sessionId: session.id, type: "session.started" })
        ]
      })
    );

    database.connection.close();
  });

  it("publishes output micro-batches as dashboard deltas", async () => {
    vi.useFakeTimers();
    const database = createDatabase(":memory:", { seed: false });
    const workspace = persistWorkspaceFixture(database);
    const fakeProvider = createFakeProvider("codex");
    const deltas: DashboardDelta[] = [];
    const service = new ProviderSessionService(database, () => fakeProvider.adapter, (delta) => deltas.push(delta));

    try {
      const session = await service.launch({
        workspaceId: workspace.id,
        provider: "codex",
        prompt: "Ship",
        modelLabel: "GPT-5.3 Codex Spark Low",
        modelId: "gpt-5.3-codex-spark",
        reasoningEffort: "low",
        cols: 80,
        rows: 24
      });
      deltas.length = 0;

      fakeProvider.emit({
        sessionId: session.id,
        type: "output",
        stream: "stdout",
        message: '{"type":"message.delta","message":"Streaming now."}\n',
        createdAt: "2026-05-08T16:00:00.000Z"
      });
      await vi.advanceTimersByTimeAsync(20);

      expect(deltas).toContainEqual(
        expect.objectContaining({
          rawOutputs: [expect.objectContaining({ sessionId: session.id, stream: "stdout" })],
          events: [expect.objectContaining({ sessionId: session.id, message: "Streaming now." })],
          sessions: [expect.objectContaining({ id: session.id, lastActivityAt: "2026-05-08T16:00:00.000Z" })]
        })
      );
    } finally {
      database.clearPruneInterval();
      vi.useRealTimers();
      database.connection.close();
    }
  });

  it("publishes final lifecycle state as a dashboard delta", async () => {
    const database = createDatabase(":memory:", { seed: false });
    const workspace = persistWorkspaceFixture(database);
    const fakeProvider = createFakeProvider("codex");
    const deltas: DashboardDelta[] = [];
    const service = new ProviderSessionService(database, () => fakeProvider.adapter, (delta) => deltas.push(delta));

    const session = await service.launch({
      workspaceId: workspace.id,
      provider: "codex",
      prompt: "Ship",
      modelLabel: "GPT-5.3 Codex Spark Low",
      modelId: "gpt-5.3-codex-spark",
      reasoningEffort: "low",
      cols: 80,
      rows: 24
    });
    deltas.length = 0;

    fakeProvider.emit({
      sessionId: session.id,
      type: "exit",
      stream: "system",
      message: "Codex exited with code 0.",
      exitCode: 0,
      createdAt: "2026-05-08T16:00:01.000Z"
    });

    expect(deltas).toContainEqual(
      expect.objectContaining({
        workspaces: [expect.objectContaining({ id: workspace.id, state: "complete" })],
        sessions: [expect.objectContaining({ id: session.id, state: "complete" })],
        events: [expect.objectContaining({ sessionId: session.id, type: "session.completed" })],
        rawOutputs: [expect.objectContaining({ sessionId: session.id, stream: "system" })]
      })
    );

    database.connection.close();
  });

  it("does not publish a micro-batch delta when persistence fails", async () => {
    const database = createDatabase(":memory:", { seed: false });
    const workspace = persistWorkspaceFixture(database);
    const fakeProvider = createFakeProvider("codex");
    const deltas: DashboardDelta[] = [];
    const service = new ProviderSessionService(database, () => fakeProvider.adapter, (delta) => deltas.push(delta));

    const session = await service.launch({
      workspaceId: workspace.id,
      provider: "codex",
      prompt: "Ship",
      modelLabel: "GPT-5.3 Codex Spark Low",
      modelId: "gpt-5.3-codex-spark",
      reasoningEffort: "low",
      cols: 80,
      rows: 24
    });
    deltas.length = 0;
    const persistRawOutput = vi.spyOn(database, "persistRawOutput").mockImplementation(() => {
      throw new Error("write failed");
    });

    try {
      fakeProvider.emit({
        sessionId: session.id,
        type: "output",
        stream: "stdout",
        message: "plain log line\n",
        createdAt: "2026-05-08T16:00:00.000Z"
      });

      expect(() =>
        (service as unknown as { flushBatch: (sessionId: string) => void }).flushBatch(session.id)
      ).toThrow("write failed");
      expect(deltas).toEqual([]);
    } finally {
      persistRawOutput.mockRestore();
      await service.terminate(session.id);
      database.connection.close();
    }
  });

  it("launches a provider from a selected workspace and completes successful exits for review", async () => {
    const database = createDatabase(":memory:", { seed: false });
    const workspace = persistWorkspaceFixture(database);
    const fakeProvider = createFakeProvider("claude");
    const service = new ProviderSessionService(database, () => fakeProvider.adapter);

    const session = await service.launch({
      workspaceId: workspace.id,
      provider: "claude",
      prompt: "Ship the cockpit",
      modelLabel: "Claude Haiku",
      modelId: "haiku",
      cols: 100,
      rows: 30
    });

    expect(fakeProvider.launchInput).toMatchObject({
      sessionId: session.id,
      workspacePath: workspace.path,
      prompt: "Ship the cockpit",
      modelId: "haiku",
      mode: "structured-json"
    });
    expect(database.getWorkspace(workspace.id).state).toBe("running");

    fakeProvider.emit({
      sessionId: session.id,
      type: "output",
      stream: "pty",
      message: "working",
      createdAt: "2026-05-08T16:00:00.000Z"
    });
    fakeProvider.emit({
      sessionId: session.id,
      type: "output",
      stream: "stdout",
      message: "{\"type\":\"message.delta\"}\n",
      createdAt: "2026-05-08T16:00:01.000Z"
    });
    fakeProvider.emit({
      sessionId: session.id,
      type: "output",
      stream: "stderr",
      message: "provider warning\n",
      createdAt: "2026-05-08T16:00:02.000Z"
    });
    fakeProvider.emit({
      sessionId: session.id,
      type: "exit",
      stream: "system",
      message: "Claude Code exited with code 0.",
      exitCode: 0,
      createdAt: "2026-05-08T16:01:00.000Z"
    });

    const snapshot = database.loadDashboard();
    expect(snapshot.sessions.find((item) => item.id === session.id)).toMatchObject({
      state: "complete",
      attention: "review-ready",
      completedAt: "2026-05-08T16:01:00.000Z"
    });
    expect(snapshot.workspaces.find((item) => item.id === workspace.id)?.state).toBe("complete");
    expect(snapshot.events.some((event) => event.type === "session.completed")).toBe(true);
    expect(snapshot.events.some((event) => event.message === "working")).toBe(false);
    expect(snapshot.rawOutputs).toEqual([
      expect.objectContaining({ stream: "system", createdAt: "2026-05-08T16:01:00.000Z" }),
      expect.objectContaining({ stream: "stderr", createdAt: "2026-05-08T16:00:02.000Z" }),
      expect.objectContaining({ stream: "stdout", createdAt: "2026-05-08T16:00:01.000Z" }),
      expect.objectContaining({ stream: "pty", createdAt: "2026-05-08T16:00:00.000Z" })
    ]);

    database.connection.close();
  });

  it("runs Codex follow-up prompts as fast structured provider turns", async () => {
    const database = createDatabase(":memory:", { seed: false });
    const workspace = persistWorkspaceFixture(database);
    const fakeProvider = createFakeProvider("codex");
    const service = new ProviderSessionService(database, () => fakeProvider.adapter);

    const session = await service.launch({
      workspaceId: workspace.id,
      provider: "codex",
      prompt: "Ship the board",
      modelLabel: "GPT-5.3 Codex Spark Low",
      modelId: "gpt-5.3-codex-spark",
      reasoningEffort: "low",
      cols: 80,
      rows: 24
    });

    await expect(service.sendInput(session.id, "too soon\r")).rejects.toThrow("Wait for the current response");
    fakeProvider.emit({
      sessionId: session.id,
      type: "output",
      stream: "stdout",
      message: '{"type":"thread.started","thread_id":"thread-1"}\n',
      createdAt: "2026-05-08T16:00:00.000Z"
    });
    fakeProvider.emit({
      sessionId: session.id,
      type: "exit",
      stream: "system",
      message: "Codex structured probe exited with code 0.",
      exitCode: 0,
      createdAt: "2026-05-08T16:01:00.000Z"
    });
    expect(database.getSession(session.id).providerConversationId).toBe("thread-1");

    await service.sendInput(session.id, "yes\r");

    expect(fakeProvider.sentInput).toEqual([]);
    expect(fakeProvider.launchInput).toMatchObject({
      prompt: "yes",
      modelId: "gpt-5.3-codex-spark",
      reasoningEffort: "low",
      resumeConversationId: "thread-1",
      mode: "structured-json"
    });
    expect(database.loadDashboard().events).toContainEqual(
      expect.objectContaining({
        sessionId: session.id,
        type: "user.message",
        message: "yes"
      })
    );

    database.connection.close();
  });

  it("resumes Claude follow-up prompts using the Maestro session id", async () => {
    const database = createDatabase(":memory:", { seed: false });
    const workspace = persistWorkspaceFixture(database);
    const fakeProvider = createFakeProvider("claude");
    const service = new ProviderSessionService(database, () => fakeProvider.adapter);

    const session = await service.launch({
      workspaceId: workspace.id,
      provider: "claude",
      prompt: "Ship the board",
      modelLabel: "Claude Haiku",
      modelId: "haiku",
      cols: 80,
      rows: 24
    });

    expect(session.providerConversationId).toBe(session.id);
    expect(fakeProvider.launchInput).toMatchObject({
      resumeConversationId: undefined,
      mode: "structured-json"
    });
    fakeProvider.emit({
      sessionId: session.id,
      type: "exit",
      stream: "system",
      message: "Claude Code structured probe exited with code 0.",
      exitCode: 0,
      createdAt: "2026-05-08T16:01:00.000Z"
    });

    await service.sendInput(session.id, "what did you write?\r");

    expect(fakeProvider.launchInput).toMatchObject({
      prompt: "what did you write?",
      modelId: "haiku",
      resumeConversationId: session.id,
      mode: "structured-json"
    });

    database.connection.close();
  });

  it("reassembles a JSON object split across two PTY chunks without parse failures", async () => {
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
      reasoningEffort: "low",
      cols: 80,
      rows: 24
    });

    fakeProvider.emit({
      sessionId: session.id,
      type: "output",
      stream: "stdout",
      message: '{"type":"command.started"',
      createdAt: "2026-05-08T16:00:00.000Z"
    });
    fakeProvider.emit({
      sessionId: session.id,
      type: "output",
      stream: "stdout",
      message: ',"message":"npm test"}\n',
      createdAt: "2026-05-08T16:00:00.500Z"
    });
    fakeProvider.emit({
      sessionId: session.id,
      type: "exit",
      stream: "system",
      message: "Codex exited with code 0.",
      exitCode: 0,
      createdAt: "2026-05-08T16:00:01.000Z"
    });

    const snapshot = database.loadDashboard();
    const commandStarted = snapshot.events.filter((event) => event.type === "command.started");
    expect(commandStarted).toHaveLength(1);
    expect(commandStarted[0]?.message).toBe("npm test");

    // No raw fallback events for the partial halves.
    const rawDeltas = snapshot.events.filter(
      (event) => event.type === "message.delta" && (event.payload as { raw?: boolean })?.raw === true
    );
    expect(rawDeltas).toEqual([]);

    database.connection.close();
  });

  it("emits both JSON and raw timeline events when a chunk mixes parsed and unparsed lines", async () => {
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
      reasoningEffort: "low",
      cols: 80,
      rows: 24
    });

    fakeProvider.emit({
      sessionId: session.id,
      type: "output",
      stream: "stdout",
      message: '{"type":"command.started","message":"npm test"}\nplain text line\n',
      createdAt: "2026-05-08T16:00:00.000Z"
    });
    fakeProvider.emit({
      sessionId: session.id,
      type: "exit",
      stream: "system",
      message: "Codex exited with code 0.",
      exitCode: 0,
      createdAt: "2026-05-08T16:00:01.000Z"
    });

    const snapshot = database.loadDashboard();
    expect(snapshot.events.some((event) => event.type === "command.started" && event.message === "npm test")).toBe(true);
    expect(
      snapshot.events.some(
        (event) =>
          event.type === "message.delta" &&
          event.message === "plain text line" &&
          (event.payload as { raw?: boolean })?.raw === true
      )
    ).toBe(true);

    database.connection.close();
  });

  it("flushes a partial trailing line as a final event on exit", async () => {
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
      reasoningEffort: "low",
      cols: 80,
      rows: 24
    });

    // Emit a JSON line missing its trailing newline; only the next event flushes it.
    fakeProvider.emit({
      sessionId: session.id,
      type: "output",
      stream: "stdout",
      message: '{"type":"message.completed","message":"All set."}',
      createdAt: "2026-05-08T16:00:00.000Z"
    });
    // No flush yet — partial line still buffered.
    expect(database.loadDashboard().events.some((event) => event.message === "All set.")).toBe(false);

    fakeProvider.emit({
      sessionId: session.id,
      type: "exit",
      stream: "system",
      message: "Codex exited with code 0.",
      exitCode: 0,
      createdAt: "2026-05-08T16:00:01.000Z"
    });

    const snapshot = database.loadDashboard();
    expect(snapshot.events.some((event) => event.type === "message.completed" && event.message === "All set.")).toBe(true);

    database.connection.close();
  });

  it("emits multiple events at the same timestamp without dropping any", async () => {
    // Sequence is in-memory and per-session-instance; not persisted to a
    // dedicated column. This test validates the consumer-visible behaviour:
    // when two events emit within a single output chunk (same createdAt
    // millisecond), neither is dropped.
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
      reasoningEffort: "low",
      cols: 80,
      rows: 24
    });

    fakeProvider.emit({
      sessionId: session.id,
      type: "output",
      stream: "stdout",
      message:
        '{"type":"command.started","message":"step one"}\n' +
        '{"type":"command.completed","message":"step two"}\n',
      createdAt: "2026-05-08T16:00:00.000Z"
    });
    fakeProvider.emit({
      sessionId: session.id,
      type: "exit",
      stream: "system",
      message: "Codex exited with code 0.",
      exitCode: 0,
      createdAt: "2026-05-08T16:00:01.000Z"
    });

    const snapshot = database.loadDashboard();
    const sameMillis = snapshot.events.filter((event) => event.createdAt === "2026-05-08T16:00:00.000Z");
    const stepOne = sameMillis.find((event) => event.message === "step one");
    const stepTwo = sameMillis.find((event) => event.message === "step two");
    expect(stepOne).toBeDefined();
    expect(stepTwo).toBeDefined();

    database.connection.close();
  });

  it("is idempotent on terminate; the second call is a no-op", async () => {
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
      reasoningEffort: "low",
      cols: 80,
      rows: 24
    });

    await service.terminate(session.id);
    expect(fakeProvider.terminatedCalls).toBe(1);
    // Second terminate on a now-disposed handle should be a quiet no-op.
    await expect(service.terminate(session.id)).resolves.toBeUndefined();
    expect(fakeProvider.terminatedCalls).toBe(1);

    database.connection.close();
  });

  it("throttles lastActivityAt updates to once per ~2 seconds while streaming", async () => {
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
      reasoningEffort: "low",
      cols: 80,
      rows: 24
    });

    const updateSpy = vi.spyOn(database, "updateSessionState");
    const baseline = updateSpy.mock.calls.length;

    fakeProvider.emit({
      sessionId: session.id,
      type: "output",
      stream: "stdout",
      message: "plain log line\n",
      createdAt: "2026-05-08T16:00:00.000Z"
    });
    fakeProvider.emit({
      sessionId: session.id,
      type: "output",
      stream: "stdout",
      message: "another log line\n",
      createdAt: "2026-05-08T16:00:00.100Z"
    });
    const afterClose = updateSpy.mock.calls.length - baseline;
    expect(afterClose).toBe(1);

    fakeProvider.emit({
      sessionId: session.id,
      type: "output",
      stream: "stdout",
      message: "after gap\n",
      createdAt: "2026-05-08T16:00:03.000Z"
    });
    expect(updateSpy.mock.calls.length - baseline).toBe(2);

    // Clean up: terminate flushes pending state synchronously and clears timers.
    await service.terminate(session.id);
    updateSpy.mockRestore();
    database.connection.close();
  });
});

function createFakeProvider(provider: ProviderId): {
  adapter: ProviderAdapter;
  emit: (event: ProviderEvent) => void;
  launchInput: ProviderLaunchInput | null;
  sentInput: string[];
  resizeCalls: Array<{ cols: number; rows: number }>;
  terminated: boolean;
  terminatedCalls: number;
} {
  let onEvent: ((event: ProviderEvent) => void) | null = null;
  const fake = {
    launchInput: null as ProviderLaunchInput | null,
    sentInput: [] as string[],
    resizeCalls: [] as Array<{ cols: number; rows: number }>,
    terminated: false,
    terminatedCalls: 0,
    handle: null as ProviderSessionHandle | null
  };

  return {
    adapter: {
      id: provider,
      displayName: provider,
      binaryName: provider,
      discover: () => {
        throw new Error("Not used by ProviderSessionService tests");
      },
      launch: (input, callback) => {
        fake.launchInput = input;
        onEvent = callback;
        const handle: ProviderSessionHandle = {
          sessionId: input.sessionId,
          provider,
          acceptsInput: input.mode === "interactive-pty",
          disposed: false,
          sendInput: (data) => {
            fake.sentInput.push(data);
          },
          resize: (cols, rows) => fake.resizeCalls.push({ cols, rows }),
          terminate: () => {
            if (handle.disposed) return;
            handle.disposed = true;
            fake.terminated = true;
            fake.terminatedCalls += 1;
          }
        };
        fake.handle = handle;
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
      return fake.launchInput;
    },
    get sentInput() {
      return fake.sentInput;
    },
    get resizeCalls() {
      return fake.resizeCalls;
    },
    get terminated() {
      return fake.terminated;
    },
    get terminatedCalls() {
      return fake.terminatedCalls;
    }
  };
}

function persistWorkspaceFixture(database: MaestroDatabase): ReturnType<MaestroDatabase["persistWorkspace"]> {
  const project: PersistProjectInput = {
    id: "project-1",
    name: "Fixture",
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
    id: "workspace-1",
    projectId: project.id,
    taskLabel: "Launch provider",
    branch: "maestro/launch-provider",
    baseRef: "main",
    path: "/repo/.worktrees/launch-provider",
    state: "created",
    sharedWorkspace: false,
    dirty: false,
    changedFiles: 0
  };

  return database.persistWorkspace(workspace);
}
