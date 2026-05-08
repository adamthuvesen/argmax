// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createDatabase, type MaestroDatabase } from "../persistence/database.js";
import type { PersistProjectInput, PersistWorkspaceInput } from "../persistence/database.js";
import type { ProviderId } from "../../shared/types.js";
import type { ProviderAdapter, ProviderEvent, ProviderLaunchInput, ProviderSessionHandle } from "./providerTypes.js";
import { ProviderSessionService } from "./providerSessionService.js";

describe("ProviderSessionService", () => {
  it("launches a provider from a selected workspace and completes successful exits for review", async () => {
    const database = createDatabase(":memory:", { seed: false });
    const workspace = persistWorkspaceFixture(database);
    const fakeProvider = createFakeProvider("claude");
    const service = new ProviderSessionService(database, () => fakeProvider.adapter);

    const session = await service.launch({
      workspaceId: workspace.id,
      provider: "claude",
      prompt: "Ship the cockpit",
      modelLabel: "Claude Sonnet",
      cols: 100,
      rows: 30
    });

    expect(fakeProvider.launchInput).toMatchObject({
      sessionId: session.id,
      workspacePath: workspace.path,
      prompt: "Ship the cockpit",
      mode: "interactive-pty"
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
    expect(snapshot.rawOutputs).toEqual([
      expect.objectContaining({ stream: "system", createdAt: "2026-05-08T16:01:00.000Z" }),
      expect.objectContaining({ stream: "stderr", createdAt: "2026-05-08T16:00:02.000Z" }),
      expect.objectContaining({ stream: "stdout", createdAt: "2026-05-08T16:00:01.000Z" }),
      expect.objectContaining({ stream: "pty", createdAt: "2026-05-08T16:00:00.000Z" })
    ]);

    database.connection.close();
  });

  it("routes input, resize, and termination to the live provider handle", async () => {
    const database = createDatabase(":memory:", { seed: false });
    const workspace = persistWorkspaceFixture(database);
    const fakeProvider = createFakeProvider("codex");
    const service = new ProviderSessionService(database, () => fakeProvider.adapter);

    const session = await service.launch({
      workspaceId: workspace.id,
      provider: "codex",
      prompt: "Ship the board",
      modelLabel: "GPT-5 Codex",
      cols: 80,
      rows: 24
    });

    service.sendInput(session.id, "yes\r");
    service.resize(session.id, 120, 40);
    service.terminate(session.id);

    expect(fakeProvider.sentInput).toEqual(["yes\r"]);
    expect(fakeProvider.resizeCalls).toEqual([{ cols: 120, rows: 40 }]);
    expect(fakeProvider.terminated).toBe(true);

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
} {
  let onEvent: ((event: ProviderEvent) => void) | null = null;
  const fake = {
    launchInput: null as ProviderLaunchInput | null,
    sentInput: [] as string[],
    resizeCalls: [] as Array<{ cols: number; rows: number }>,
    terminated: false
  };

  const handle: ProviderSessionHandle = {
    sessionId: "pending",
    provider,
    sendInput: (input) => fake.sentInput.push(input),
    resize: (cols, rows) => fake.resizeCalls.push({ cols, rows }),
    terminate: () => {
      fake.terminated = true;
    }
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
        return Promise.resolve({ ...handle, sessionId: input.sessionId });
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
      defaultModelLabel: "GPT-5 Codex",
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
