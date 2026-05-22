import type { ArgmaxDatabase } from "../main/persistence/database.js";
import type { PersistProjectInput, PersistWorkspaceInput } from "../main/persistence/database.js";
import type { ProviderId } from "../shared/types.js";
import type { ProviderAdapter, ProviderEvent, ProviderLaunchInput, ProviderSessionHandle } from "../main/providers/providerTypes.js";

export function createFakeProvider(provider: ProviderId): {
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

export function createPendingProvider(provider: ProviderId): {
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

export function persistWorkspaceFixture(database: ArgmaxDatabase): ReturnType<ArgmaxDatabase["persistWorkspace"]> {
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
