// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDatabase, type ArgmaxDatabase } from "../persistence/database.js";
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

  it("reuses the persisted permission mode for follow-up launches (audit-2026-05-14 H2)", async () => {
    const database = createDatabase(":memory:", { seed: false });
    const workspace = persistWorkspaceFixture(database);
    const fakeProvider = createFakeProvider("codex");
    const service = new ProviderSessionService(database, () => fakeProvider.adapter);

    const session = await service.launch({
      workspaceId: workspace.id,
      provider: "codex",
      prompt: "Start",
      modelLabel: "GPT-5.3 Codex Spark Low",
      modelId: "gpt-5.3-codex-spark",
      permissionMode: "ask-each-time",
      cols: 80,
      rows: 24
    });
    fakeProvider.emit({
      sessionId: session.id,
      type: "exit",
      stream: "system",
      message: "Codex exited with code 0.",
      exitCode: 0,
      createdAt: "2026-05-08T16:00:00.000Z"
    });

    await service.sendInput(session.id, "Continue");

    expect(fakeProvider.launchInput?.permissionMode).toBe("ask-each-time");
    expect(database.getSession(session.id).permissionMode).toBe("ask-each-time");

    database.connection.close();
  });

  it("persists actionable approval rows from provider permission gates", async () => {
    const database = createDatabase(":memory:", { seed: false });
    const workspace = persistWorkspaceFixture(database);
    const fakeProvider = createFakeProvider("codex");
    const deltas: DashboardDelta[] = [];
    const service = new ProviderSessionService(database, () => fakeProvider.adapter, (delta) => deltas.push(delta));

    const session = await service.launch({
      workspaceId: workspace.id,
      provider: "codex",
      prompt: "Start",
      modelLabel: "GPT-5.3 Codex Spark Low",
      modelId: "gpt-5.3-codex-spark",
      cols: 80,
      rows: 24
    });

    fakeProvider.emit({
      sessionId: session.id,
      type: "output",
      stream: "stdout",
      message:
        JSON.stringify({
          jsonrpc: "2.0",
          method: "item/commandExecution/requestApproval",
          id: 50,
          params: {
            itemId: "cmd_1",
            threadId: "thr_123",
            turnId: "turn_456",
            command: ["rm", "-rf", "/tmp/build"],
            cwd: workspace.path,
            reason: "Clean build artifacts"
          }
        }) + "\n",
      createdAt: "2026-05-08T16:00:00.000Z"
    });

    await new Promise((resolve) => setTimeout(resolve, 30));

    const approval = database.listPendingApprovals()[0];
    expect(approval).toMatchObject({
      sessionId: session.id,
      command: "rm -rf /tmp/build",
      cwd: workspace.path,
      provider: "codex",
      riskLevel: "high",
      status: "pending"
    });
    expect(database.getSession(session.id)).toMatchObject({
      state: "waiting",
      attention: "approval-needed"
    });
    expect(
      database.listSessionEventsSince({ sessionId: session.id }).events.some((event) => event.type === "approval.requested")
    ).toBe(true);
    expect(deltas.some((delta) => delta.approvals?.some((row) => row.id === approval?.id))).toBe(true);

    database.connection.close();
  });

  it("persists agent mode and passes it to follow-up launches", async () => {
    const database = createDatabase(":memory:", { seed: false });
    const workspace = persistWorkspaceFixture(database);
    const fakeProvider = createFakeProvider("codex");
    const service = new ProviderSessionService(database, () => fakeProvider.adapter);

    const session = await service.launch({
      workspaceId: workspace.id,
      provider: "codex",
      prompt: "Start",
      modelLabel: "GPT-5.3 Codex Spark Low",
      modelId: "gpt-5.3-codex-spark",
      agentMode: "plan",
      cols: 80,
      rows: 24
    });
    expect(fakeProvider.launchInput?.agentMode).toBe("plan");
    expect(database.getSession(session.id).agentMode).toBe("plan");
    fakeProvider.emit({
      sessionId: session.id,
      type: "exit",
      stream: "system",
      message: "Codex exited with code 0.",
      exitCode: 0,
      createdAt: "2026-05-08T16:00:00.000Z"
    });

    await service.sendInput(session.id, "Continue", { agentMode: "auto" });

    expect(fakeProvider.launchInput?.agentMode).toBe("auto");
    expect(database.getSession(session.id).agentMode).toBe("auto");

    database.connection.close();
  });

  it("queues follow-up input while the provider launch handle is still pending (audit-2026-05-14 H3)", async () => {
    const database = createDatabase(":memory:", { seed: false });
    const workspace = persistWorkspaceFixture(database);
    const pendingProvider = createPendingProvider("codex");
    const service = new ProviderSessionService(database, () => pendingProvider.adapter);

    const launchPromise = service.launch({
      workspaceId: workspace.id,
      provider: "codex",
      prompt: "Start",
      modelLabel: "GPT-5.3 Codex Spark Low",
      modelId: "gpt-5.3-codex-spark",
      cols: 80,
      rows: 24
    });
    const sessionId = pendingProvider.launchInput?.sessionId;
    expect(sessionId).toBeDefined();

    // Used to throw "Wait for the current response..."; now parks the message
    // in the per-session queue and lets the drain pick it up after complete.
    const result = await service.sendInput(sessionId!, "Too soon");
    expect(result).toEqual({ queued: true });
    expect(service.getAllPendingMessages()[sessionId!]?.[0]?.content).toBe("Too soon");
    expect(pendingProvider.launchCalls).toBe(1);

    pendingProvider.resolve();
    await launchPromise;

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

  it("drops the partial-line buffer and emits a marker when stream output exceeds 1 MiB without a newline", async () => {
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

      // Two ~600 KB chunks of pure text with no newline — together they push
      // the per-stream buffer past the 1 MiB cap.
      const chunk = "x".repeat(600_000);
      fakeProvider.emit({
        sessionId: session.id,
        type: "output",
        stream: "stdout",
        message: chunk,
        createdAt: "2026-05-08T16:00:00.000Z"
      });
      fakeProvider.emit({
        sessionId: session.id,
        type: "output",
        stream: "stdout",
        message: chunk,
        createdAt: "2026-05-08T16:00:00.100Z"
      });
      await vi.advanceTimersByTimeAsync(20);

      const buffers = (service as unknown as {
        buffers: Map<string, { streamBuffers: Map<string, string> }>;
      }).buffers;
      expect(buffers.get(session.id)?.streamBuffers.get("stdout")).toBe("");
      const truncationDelta = deltas.find((d) =>
        d.events?.some((ev) => ev.message.includes("argmax: dropped"))
      );
      expect(truncationDelta).toBeDefined();
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

  it("keeps the failed batch queued and retries when persistence recovers", async () => {
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

      (service as unknown as { flushBatch: (sessionId: string) => void }).flushBatch(session.id);
      expect(deltas).toEqual([]);
      const buffers = (service as unknown as {
        buffers: Map<string, { pendingRawOutputs: unknown[]; failedFlushes: number }>;
      }).buffers;
      expect(buffers.get(session.id)?.pendingRawOutputs.length).toBe(1);
      expect(buffers.get(session.id)?.failedFlushes).toBe(1);

      persistRawOutput.mockRestore();
      (service as unknown as { flushBatch: (sessionId: string) => void }).flushBatch(session.id);

      expect(buffers.get(session.id)?.pendingRawOutputs.length).toBe(0);
      expect(buffers.get(session.id)?.failedFlushes).toBe(0);
      expect(database.listSessionEventsSince({ sessionId: session.id }).rawOutputs.map((output) => output.content)).toContain(
        "plain log line\n"
      );
    } finally {
      persistRawOutput.mockRestore();
      await service.terminate(session.id);
      database.connection.close();
    }
  });

  it("drops a truncated JSON trailing fragment instead of rendering it as a chat message", async () => {
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

    // Emit a half-finished JSON line (no newline, no closing brace). It
    // stays in the per-stream partial-line buffer until terminate triggers
    // a flush.
    fakeProvider.emit({
      sessionId: session.id,
      type: "output",
      stream: "stdout",
      message: '{"type":"message.delta","text":"never finishe',
      createdAt: "2026-05-08T16:00:00.000Z"
    });

    await service.terminate(session.id);

    const everyTimelineMessage = deltas.flatMap((d) => d.events ?? []).map((e) => e.message);
    // The fragment must NOT have been emitted as an assistant message.delta.
    expect(everyTimelineMessage.some((msg) => msg.includes("never finishe"))).toBe(false);
    // It must be surfaced somewhere — as a raw stderr debug entry.
    const rawOutputs = deltas.flatMap((d) => d.rawOutputs ?? []);
    expect(rawOutputs.some((r) => r.stream === "stderr" && r.content.includes("argmax: dropped truncated JSON"))).toBe(true);

    database.connection.close();
  });

  it("survives a lifecycle event when the session row is deleted mid-stream", async () => {
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

    // Delete the session row before the exit event lands. The lifecycle
    // writes (persistRawOutput, updateSessionState, updateWorkspaceState,
    // persistTimelineEvent) would otherwise throw uncaught into the
    // adapter's onExit callback.
    database.connection.prepare("DELETE FROM sessions WHERE id = ?").run(session.id);

    expect(() =>
      fakeProvider.emit({
        sessionId: session.id,
        type: "exit",
        stream: "system",
        message: "Codex exited with code 0.",
        exitCode: 0,
        createdAt: "2026-05-08T16:00:01.000Z"
      })
    ).not.toThrow();

    database.connection.close();
  });

  it("drops the batch without throwing when the session row is deleted mid-flush", async () => {
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
      type: "output",
      stream: "stdout",
      message: "plain log line\n",
      createdAt: "2026-05-08T16:00:00.000Z"
    });

    database.connection.prepare("DELETE FROM sessions WHERE id = ?").run(session.id);

    expect(() => (service as unknown as { flushBatch: (id: string) => void }).flushBatch(session.id)).not.toThrow();
    expect(deltas).toEqual([]);

    const rawOutputCount = database.connection
      .prepare("SELECT COUNT(*) AS c FROM raw_outputs WHERE session_id = ?")
      .get(session.id) as { c: number };
    expect(rawOutputCount.c).toBe(0);

    database.connection.close();
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

    // Used to throw "Wait for the current response..."; now queues silently
    // so the user can stack follow-ups while the agent is still working.
    const tooSoonResult = await service.sendInput(session.id, "too soon\r");
    expect(tooSoonResult).toEqual({ queued: true });
    expect(service.getAllPendingMessages()[session.id]?.[0]?.content).toBe("too soon");
    // Drop the queued message so it doesn't auto-flush after the simulated
    // exit below and interfere with the structured-resume assertions.
    service.cancelQueuedMessage(
      session.id,
      service.getAllPendingMessages()[session.id][0].id
    );
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

  it("persists model switches for the next structured follow-up turn", async () => {
    const database = createDatabase(":memory:", { seed: false });
    const workspace = persistWorkspaceFixture(database);
    const fakeProvider = createFakeProvider("codex");
    const service = new ProviderSessionService(database, () => fakeProvider.adapter);

    const session = await service.launch({
      workspaceId: workspace.id,
      provider: "codex",
      prompt: "Ship the board",
      modelLabel: "GPT-5.3 Codex",
      modelId: "gpt-5.3-codex",
      reasoningEffort: "medium",
      cols: 80,
      rows: 24
    });

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

    await service.sendInput(session.id, "try harder\r", {
      modelSelection: {
        modelLabel: "GPT-5.5",
        modelId: "gpt-5.5",
        reasoningEffort: "high"
      }
    });

    expect(fakeProvider.launchInput).toMatchObject({
      prompt: "try harder",
      modelLabel: "GPT-5.5",
      modelId: "gpt-5.5",
      reasoningEffort: "high",
      resumeConversationId: "thread-1"
    });
    expect(database.getSession(session.id)).toMatchObject({
      modelLabel: "GPT-5.5",
      modelId: "gpt-5.5",
      reasoningEffort: "high"
    });

    database.connection.close();
  });

  it("collapses embedded newlines in multi-line sendInput before writing to a live PTY", async () => {
    const database = createDatabase(":memory:", { seed: false });
    const workspace = persistWorkspaceFixture(database);
    const fakeProvider = createFakeProvider("claude");
    const service = new ProviderSessionService(database, () => fakeProvider.adapter);

    const session = await service.launch({
      workspaceId: workspace.id,
      provider: "claude",
      prompt: "Ship",
      modelLabel: "Claude Haiku",
      modelId: "haiku",
      cols: 80,
      rows: 24
    });

    // Force the handle into PTY-input mode (default in production is
    // structured-json, but the PTY-input path still exists and must not
    // submit each line as a separate prompt).
    const entry = (service as unknown as {
      handles: Map<string, { kind: string; handle?: { acceptsInput: boolean } }>;
    }).handles.get(session.id);
    if (entry?.handle) entry.handle.acceptsInput = true;

    await service.sendInput(session.id, "line one\nline two\nline three");

    expect(fakeProvider.sentInput).toEqual(["line one line two line three\r"]);
    // Persisted user.message keeps the original text — only PTY-bound bytes
    // are sanitized.
    expect(database.loadDashboard().events).toContainEqual(
      expect.objectContaining({
        sessionId: session.id,
        type: "user.message",
        message: "line one\nline two\nline three"
      })
    );

    database.connection.close();
  });

  it("resumes Claude follow-up prompts using the Argmax session id", async () => {
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

    await service.terminate(session.id);
    expect(fakeProvider.terminatedCalls).toBe(1);
    expect(database.getSession(session.id)).toMatchObject({
      state: "cancelled",
      attention: "normal"
    });
    expect(database.getWorkspace(workspace.id).state).toBe("cancelled");
    expect(database.loadDashboard().events).toContainEqual(
      expect.objectContaining({ sessionId: session.id, type: "session.cancelled" })
    );
    expect(deltas).toContainEqual(
      expect.objectContaining({
        workspaces: [expect.objectContaining({ id: workspace.id, state: "cancelled" })],
        sessions: [expect.objectContaining({ id: session.id, state: "cancelled" })],
        events: [expect.objectContaining({ sessionId: session.id, type: "session.cancelled" })]
      })
    );
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

    const updateSpy = vi.spyOn(database, "updateSessionLastActivity");
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

  it("persists Claude usage from assistant events and publishes updated session totals", async () => {
    const database = createDatabase(":memory:", { seed: false });
    const workspace = persistWorkspaceFixture(database);
    const fakeProvider = createFakeProvider("claude");
    const deltas: DashboardDelta[] = [];
    const service = new ProviderSessionService(database, () => fakeProvider.adapter, (delta) => deltas.push(delta));

    const session = await service.launch({
      workspaceId: workspace.id,
      provider: "claude",
      prompt: "Ship the cockpit",
      modelLabel: "Claude Sonnet",
      modelId: "claude-sonnet-4-6",
      cols: 100,
      rows: 30
    });
    deltas.length = 0;

    fakeProvider.emit({
      sessionId: session.id,
      type: "output",
      stream: "stdout",
      message:
        JSON.stringify({
          type: "assistant",
          message: {
            id: "m1",
            model: "claude-sonnet-4-6",
            content: [{ type: "text", text: "Hi" }],
            usage: {
              input_tokens: 1_000_000,
              output_tokens: 0,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0
            }
          }
        }) + "\n",
      createdAt: "2026-05-08T16:00:00.000Z"
    });
    fakeProvider.emit({
      sessionId: session.id,
      type: "exit",
      stream: "system",
      message: "Claude Code exited with code 0.",
      exitCode: 0,
      createdAt: "2026-05-08T16:00:01.000Z"
    });

    const summary = database.getSessionCostSummary(session.id);
    expect(summary.tokens.input).toBe(1_000_000);
    expect(summary.costUsd).toBeCloseTo(3.0, 9);
    expect(summary.modelId).toBe("claude-sonnet-4-6");

    const persistedSession = database.getSession(session.id);
    expect(persistedSession.costUsd).toBeCloseTo(3.0, 9);
    expect(persistedSession.tokens?.input).toBe(1_000_000);

    const sessionDeltaWithCost = deltas.find((delta) =>
      delta.sessions?.some((s) => s.id === session.id && (s.costUsd ?? 0) > 0)
    );
    expect(sessionDeltaWithCost).toBeDefined();

    database.connection.close();
  });

  it("persists Codex token_count usage with the model from the latest turn_context", async () => {
    const database = createDatabase(":memory:", { seed: false });
    const workspace = persistWorkspaceFixture(database);
    const fakeProvider = createFakeProvider("codex");
    const service = new ProviderSessionService(database, () => fakeProvider.adapter);

    const session = await service.launch({
      workspaceId: workspace.id,
      provider: "codex",
      prompt: "Ship",
      modelLabel: "GPT-5.4",
      modelId: "gpt-5.4",
      reasoningEffort: "medium",
      cols: 80,
      rows: 24
    });

    fakeProvider.emit({
      sessionId: session.id,
      type: "output",
      stream: "stdout",
      message:
        JSON.stringify({
          timestamp: "2026-05-08T16:00:00.000Z",
          type: "turn_context",
          payload: { model: "gpt-5.4", cwd: "/repo" }
        }) +
        "\n" +
        JSON.stringify({
          timestamp: "2026-05-08T16:00:01.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: {
                input_tokens: 1_000_000,
                cached_input_tokens: 0,
                output_tokens: 0,
                reasoning_output_tokens: 0,
                total_tokens: 1_000_000
              }
            }
          }
        }) +
        "\n",
      createdAt: "2026-05-08T16:00:01.000Z"
    });
    fakeProvider.emit({
      sessionId: session.id,
      type: "exit",
      stream: "system",
      message: "Codex exited with code 0.",
      exitCode: 0,
      createdAt: "2026-05-08T16:00:02.000Z"
    });

    const summary = database.getSessionCostSummary(session.id);
    expect(summary.modelId).toBe("gpt-5.4");
    expect(summary.tokens).toEqual({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(summary.costUsd).toBeCloseTo(2.5, 9);

    database.connection.close();
  });

  it("persists current Codex turn.completed usage with the launched model", async () => {
    const database = createDatabase(":memory:", { seed: false });
    const workspace = persistWorkspaceFixture(database);
    const fakeProvider = createFakeProvider("codex");
    const service = new ProviderSessionService(database, () => fakeProvider.adapter);

    const session = await service.launch({
      workspaceId: workspace.id,
      provider: "codex",
      prompt: "Ship",
      modelLabel: "GPT-5.5",
      modelId: "gpt-5.5",
      reasoningEffort: "medium",
      cols: 80,
      rows: 24
    });

    fakeProvider.emit({
      sessionId: session.id,
      type: "output",
      stream: "stdout",
      message:
        JSON.stringify({
          type: "turn.completed",
          usage: {
            input_tokens: 10_000,
            cached_input_tokens: 7_000,
            output_tokens: 500,
            reasoning_output_tokens: 100
          }
        }) + "\n",
      createdAt: "2026-05-08T16:00:01.000Z"
    });
    fakeProvider.emit({
      sessionId: session.id,
      type: "exit",
      stream: "system",
      message: "Codex exited with code 0.",
      exitCode: 0,
      createdAt: "2026-05-08T16:00:02.000Z"
    });

    const summary = database.getSessionCostSummary(session.id);
    expect(summary.modelId).toBe("gpt-5.5");
    expect(summary.tokens).toEqual({ input: 3_000, output: 500, cacheRead: 7_000, cacheWrite: 0 });
    expect(summary.costUsd).toBeCloseTo(0.0335, 9);

    database.connection.close();
  });

  it("treats unknown model ids as cost=0 without throwing", async () => {
    const database = createDatabase(":memory:", { seed: false });
    const workspace = persistWorkspaceFixture(database);
    const fakeProvider = createFakeProvider("claude");
    const service = new ProviderSessionService(database, () => fakeProvider.adapter);

    const session = await service.launch({
      workspaceId: workspace.id,
      provider: "claude",
      prompt: "Ship",
      modelLabel: "Brand new",
      modelId: "claude-omega-0",
      cols: 80,
      rows: 24
    });

    fakeProvider.emit({
      sessionId: session.id,
      type: "output",
      stream: "stdout",
      message:
        JSON.stringify({
          type: "assistant",
          message: {
            id: "m1",
            model: "claude-omega-0",
            content: [{ type: "text", text: "Hi" }],
            usage: {
              input_tokens: 1000,
              output_tokens: 0,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0
            }
          }
        }) + "\n",
      createdAt: "2026-05-08T16:00:00.000Z"
    });
    fakeProvider.emit({
      sessionId: session.id,
      type: "exit",
      stream: "system",
      message: "Claude Code exited with code 0.",
      exitCode: 0,
      createdAt: "2026-05-08T16:00:01.000Z"
    });

    const summary = database.getSessionCostSummary(session.id);
    expect(summary.costUsd).toBe(0);
    expect(summary.tokens.input).toBe(1000);

    database.connection.close();
  });

  it("recoverOrphanedSessions cancels rows left as 'running' from a previous process", () => {
    const database = createDatabase(":memory:", { seed: false });
    const workspace = persistWorkspaceFixture(database);
    database.persistSession({
      id: "session-orphan",
      workspaceId: workspace.id,
      provider: "claude",
      modelLabel: "Claude Haiku 4.5",
      modelId: "claude-haiku-4-5",
      prompt: "lost session",
      state: "running",
      attention: "normal"
    });

    const deltas: DashboardDelta[] = [];
    const service = new ProviderSessionService(database, undefined, (delta) => deltas.push(delta));
    const result = service.recoverOrphanedSessions();

    expect(result.recoveredCount).toBe(1);
    const recovered = database.getSession("session-orphan");
    expect(recovered.state).toBe("cancelled");

    const events = database.listSessionEventsSince({ sessionId: "session-orphan" }).events;
    expect(events.some((event) => event.type === "session.recovered-from-crash")).toBe(true);

    expect(deltas).toContainEqual(
      expect.objectContaining({
        sessions: [expect.objectContaining({ id: "session-orphan", state: "cancelled" })],
        events: [expect.objectContaining({ type: "session.recovered-from-crash" })]
      })
    );

    expect(service.recoverOrphanedSessions().recoveredCount).toBe(0);
    database.connection.close();
  });

  it("synthesizes learnings from the whole session, not just the latest event page (audit-2026-05-14 M9)", async () => {
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
    for (let i = 0; i < 2; i += 1) {
      database.persistTimelineEvent({
        id: `old-failure-${i}`,
        sessionId: session.id,
        type: "command.completed",
        message: "npm test",
        payload: { is_error: true },
        createdAt: `2026-05-08T15:00:${String(i).padStart(2, "0")}.000Z`
      });
    }
    for (let i = 0; i < 501; i += 1) {
      database.persistTimelineEvent({
        id: `filler-${i}`,
        sessionId: session.id,
        type: "message.delta",
        message: `filler ${i}`,
        payload: {},
        createdAt: "2026-05-08T15:10:00.000Z"
      });
    }

    fakeProvider.emit({
      sessionId: session.id,
      type: "exit",
      stream: "system",
      message: "Codex exited with code 0.",
      exitCode: 0,
      createdAt: "2026-05-08T16:00:00.000Z"
    });

    expect(database.listLearnings(workspace.projectId).some((learning) => learning.summary.includes("npm test"))).toBe(
      true
    );

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
            if (handle.disposed) return Promise.resolve();
            handle.disposed = true;
            fake.terminated = true;
            fake.terminatedCalls += 1;
            return Promise.resolve();
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

function createPendingProvider(provider: ProviderId): {
  adapter: ProviderAdapter;
  launchInput: ProviderLaunchInput | null;
  launchCalls: number;
  resolve: () => void;
} {
  let resolveLaunch: (() => void) | null = null;
  let launchInput: ProviderLaunchInput | null = null;
  let launchCalls = 0;

  return {
    adapter: {
      id: provider,
      displayName: provider,
      binaryName: provider,
      discover: () => {
        throw new Error("Not used by ProviderSessionService tests");
      },
      launch: (input) => {
        launchInput = input;
        launchCalls += 1;
        return new Promise<ProviderSessionHandle>((resolve) => {
          resolveLaunch = () =>
            resolve({
              sessionId: input.sessionId,
              provider,
              acceptsInput: false,
              disposed: false,
              sendInput: () => undefined,
              resize: () => undefined,
              terminate: () => Promise.resolve()
            });
        });
      }
    },
    get launchInput() {
      return launchInput;
    },
    get launchCalls() {
      return launchCalls;
    },
    resolve: () => {
      if (!resolveLaunch) {
        throw new Error("Provider launch was not pending");
      }
      resolveLaunch();
    }
  };
}

function persistWorkspaceFixture(database: ArgmaxDatabase): ReturnType<ArgmaxDatabase["persistWorkspace"]> {
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
    branch: "argmax/launch-provider",
    baseRef: "main",
    path: "/repo/.worktrees/launch-provider",
    state: "created",
    sharedWorkspace: false,
    dirty: false,
    changedFiles: 0
  };

  return database.persistWorkspace(workspace);
}
