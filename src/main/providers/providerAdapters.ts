import { spawn as spawnProcess } from "node:child_process";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { createRequire } from "node:module";
import type { IPty, IPtyForkOptions } from "node-pty";
import type * as NodePty from "node-pty";
import type { ProviderId } from "../../shared/types.js";
import { defaultDiscoveryRunner, discoverProviderById, type ProviderDiscoveryRunner } from "./providerDiscovery.js";
import { buildProviderEnvironment, providerShell, shellQuote } from "./providerEnvironment.js";
import type {
  ProviderAdapter,
  ProviderCapabilityReport,
  ProviderEvent,
  ProviderLaunchInput,
  ProviderSessionHandle
} from "./providerTypes.js";

const require = createRequire(import.meta.url);
const nodePty = require("node-pty") as typeof NodePty;

/** Grace period between SIGTERM and SIGKILL during teardown. */
const KILL_GRACE_MS = 2_000;

export type PtySpawner = (file: string, args: string[], options: IPtyForkOptions) => IPty;
export type ProcessSpawner = (
  file: string,
  args: string[],
  options: SpawnOptionsWithoutStdio
) => ChildProcessWithoutNullStreams;

interface ProviderLaunchDefinition {
  id: ProviderId;
  displayName: string;
  binaryName: string;
  structuredArgs: (input: ProviderLaunchInput) => string[];
  structuredStdin?: (input: ProviderLaunchInput) => string | null;
}

const providerDefinitions: ProviderLaunchDefinition[] = [
  {
    id: "claude",
    displayName: "Claude Code",
    binaryName: "claude",
    structuredArgs: (input) => ["-p", "--output-format", "stream-json", "--verbose", input.prompt],
    structuredStdin: () => null
  },
  {
    id: "codex",
    displayName: "Codex",
    binaryName: "codex",
    structuredArgs: () => ["exec", "--json", "--ignore-user-config", "-"],
    structuredStdin: (input) => input.prompt
  }
];

export class ProviderLaunchError extends Error {
  constructor(
    message: string,
    readonly provider: ProviderId
  ) {
    super(message);
    this.name = "ProviderLaunchError";
  }
}

export function createProviderAdapters(
  runner: ProviderDiscoveryRunner = defaultDiscoveryRunner,
  spawnPty: PtySpawner = nodePty.spawn,
  spawnStructuredProcess: ProcessSpawner = spawnProcess
): Map<ProviderId, ProviderAdapter> {
  return new Map(
    providerDefinitions.map((definition) => [
      definition.id,
      createProviderAdapter(definition, runner, spawnPty, spawnStructuredProcess)
    ])
  );
}

export function getProviderAdapter(
  providerId: ProviderId,
  runner: ProviderDiscoveryRunner = defaultDiscoveryRunner,
  spawnPty: PtySpawner = nodePty.spawn,
  spawnStructuredProcess: ProcessSpawner = spawnProcess
): ProviderAdapter {
  const adapter = createProviderAdapters(runner, spawnPty, spawnStructuredProcess).get(providerId);
  if (!adapter) {
    throw new ProviderLaunchError(`Unknown provider: ${providerId}`, providerId);
  }
  return adapter;
}

function createProviderAdapter(
  definition: ProviderLaunchDefinition,
  runner: ProviderDiscoveryRunner,
  spawnPty: PtySpawner,
  spawnStructuredProcess: ProcessSpawner
): ProviderAdapter {
  return {
    id: definition.id,
    displayName: definition.displayName,
    binaryName: definition.binaryName,
    discover: () => discoverProviderById(definition.id, runner),
    launch: (input, onEvent) =>
      input.mode === "structured-json"
        ? launchStructuredProcess(definition, input, onEvent, runner, spawnStructuredProcess)
        : launchInteractivePty(definition, input, onEvent, runner, spawnPty)
  };
}

async function launchInteractivePty(
  definition: ProviderLaunchDefinition,
  input: ProviderLaunchInput,
  onEvent: (event: ProviderEvent) => void,
  runner: ProviderDiscoveryRunner,
  spawnPty: PtySpawner
): Promise<ProviderSessionHandle> {
  if (input.mode !== "interactive-pty") {
    throw new ProviderLaunchError(`${definition.displayName} does not support ${input.mode} launches yet.`, definition.id);
  }

  const capability = await discoverProviderById(definition.id, runner);
  if (!capability.installed || !capability.binaryPath) {
    throw new ProviderLaunchError(missingBinaryMessage(capability), definition.id);
  }

  let ptyProcess: IPty;
  try {
    ptyProcess = spawnPty(providerShell(), ["-lc", `exec ${shellQuote(capability.binaryPath)}`], {
      name: "xterm-256color",
      cols: input.cols,
      rows: input.rows,
      cwd: input.workspacePath,
      env: buildProviderEnvironment({
        TERM: "xterm-256color",
        COLORTERM: process.env.COLORTERM ?? "truecolor"
      })
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown PTY error";
    throw new ProviderLaunchError(
      `Could not launch ${definition.displayName} from ${capability.binaryPath}: ${detail}`,
      definition.id
    );
  }

  // Mutable state shared between terminate/onExit. Declared up front so the
  // handle's terminate() closure can refer to them.
  let killTimer: NodeJS.Timeout | null = null;
  let dataDisposable: { dispose: () => void } = { dispose: () => undefined };
  let exitDisposable: { dispose: () => void } = { dispose: () => undefined };
  const createdAt = () => new Date().toISOString();

  // `disposed` on the handle is the source of truth: terminate() flips it
  // before any work; onData/onExit drop racing emissions when set.
  const handle: ProviderSessionHandle = {
    sessionId: input.sessionId,
    provider: definition.id,
    acceptsInput: true,
    disposed: false,
    sendInput: (data) => {
      if (handle.disposed) return;
      ptyProcess.write(data);
    },
    resize: (cols, rows) => {
      if (handle.disposed) return;
      ptyProcess.resize(cols, rows);
    },
    terminate: () => {
      if (handle.disposed) return;
      handle.disposed = true;
      try {
        dataDisposable.dispose();
      } catch {
        /* ignore */
      }
      try {
        exitDisposable.dispose();
      } catch {
        /* ignore */
      }
      try {
        ptyProcess.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      killTimer = setTimeout(() => {
        try {
          ptyProcess.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, KILL_GRACE_MS);
      if (typeof killTimer.unref === "function") {
        killTimer.unref();
      }
    }
  };

  try {
    dataDisposable = ptyProcess.onData((data) => {
      if (handle.disposed) return;
      onEvent({
        sessionId: input.sessionId,
        type: "output",
        stream: "pty",
        message: data,
        createdAt: createdAt()
      });
    });

    exitDisposable = ptyProcess.onExit(({ exitCode, signal }) => {
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      if (handle.disposed) {
        return;
      }
      handle.disposed = true;
      const wasCancelled = signal != null;
      onEvent({
        sessionId: input.sessionId,
        type: wasCancelled ? "error" : exitCode === 0 ? "exit" : "error",
        stream: "system",
        message: signal
          ? `${definition.displayName} exited with code ${exitCode} and signal ${signal}.`
          : `${definition.displayName} exited with code ${exitCode}.`,
        exitCode,
        createdAt: createdAt()
      });
      try {
        dataDisposable.dispose();
      } catch {
        /* ignore */
      }
      try {
        exitDisposable.dispose();
      } catch {
        /* ignore */
      }
    });

    if (input.prompt.trim()) {
      ptyProcess.write(`${input.prompt}\r`);
    }
  } catch (error) {
    // Post-spawn wiring failed: ensure the child is killed before re-throwing.
    try {
      handle.terminate();
    } catch {
      /* ignore */
    }
    const detail = error instanceof Error ? error.message : "Unknown PTY wiring error";
    throw new ProviderLaunchError(
      `Could not wire ${definition.displayName} PTY: ${detail}`,
      definition.id
    );
  }

  return handle;
}

function missingBinaryMessage(capability: ProviderCapabilityReport): string {
  return capability.setupGuidance ?? `${capability.displayName} is not installed or could not be found on PATH.`;
}

async function launchStructuredProcess(
  definition: ProviderLaunchDefinition,
  input: ProviderLaunchInput,
  onEvent: (event: ProviderEvent) => void,
  runner: ProviderDiscoveryRunner,
  spawnStructuredProcess: ProcessSpawner
): Promise<ProviderSessionHandle> {
  const capability = await discoverProviderById(definition.id, runner);
  if (!capability.installed || !capability.binaryPath) {
    throw new ProviderLaunchError(missingBinaryMessage(capability), definition.id);
  }

  let childProcess: ChildProcessWithoutNullStreams;
  try {
    childProcess = spawnStructuredProcess(capability.binaryPath, definition.structuredArgs(input), {
      cwd: input.workspacePath,
      env: buildProviderEnvironment({
        NO_COLOR: "1"
      })
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown process error";
    throw new ProviderLaunchError(`Could not launch ${definition.displayName} structured probe: ${detail}`, definition.id);
  }

  let killTimer: NodeJS.Timeout | null = null;
  const handle: ProviderSessionHandle = {
    sessionId: input.sessionId,
    provider: definition.id,
    acceptsInput: false,
    disposed: false,
    sendInput: (data) => {
      if (handle.disposed) return;
      if (childProcess.stdin.writable) {
        childProcess.stdin.write(data);
      }
    },
    resize: () => undefined,
    terminate: () => {
      if (handle.disposed) return;
      handle.disposed = true;
      try {
        if (childProcess.stdin.writable) {
          childProcess.stdin.end();
        }
      } catch {
        /* already closed */
      }
      try {
        childProcess.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      killTimer = setTimeout(() => {
        try {
          childProcess.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, KILL_GRACE_MS);
      if (typeof killTimer.unref === "function") {
        killTimer.unref();
      }
    }
  };

  // Swallow EPIPE on stdin (M9): writes after the child closes stdin would
  // otherwise crash the main process.
  childProcess.stdin.on("error", () => {
    /* swallow EPIPE and similar */
  });

  const createdAt = () => new Date().toISOString();

  try {
    childProcess.stdout.on("data", (data: Buffer | string) => {
      if (handle.disposed) return;
      onEvent({
        sessionId: input.sessionId,
        type: "output",
        stream: "stdout",
        message: data.toString(),
        createdAt: createdAt()
      });
    });
    childProcess.stderr.on("data", (data: Buffer | string) => {
      if (handle.disposed) return;
      onEvent({
        sessionId: input.sessionId,
        type: "output",
        stream: "stderr",
        message: data.toString(),
        createdAt: createdAt()
      });
    });
    childProcess.on("error", (error) => {
      if (handle.disposed) return;
      onEvent({
        sessionId: input.sessionId,
        type: "error",
        stream: "system",
        message: error.message,
        createdAt: createdAt()
      });
    });
    childProcess.on("exit", (exitCode, signal) => {
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      if (handle.disposed) return;
      handle.disposed = true;
      const code = exitCode ?? 1;
      const wasCancelled = signal != null;
      onEvent({
        sessionId: input.sessionId,
        type: wasCancelled ? "error" : code === 0 ? "exit" : "error",
        stream: "system",
        message: signal
          ? `${definition.displayName} structured probe exited with code ${code} and signal ${signal}.`
          : `${definition.displayName} structured probe exited with code ${code}.`,
        exitCode: code,
        createdAt: createdAt()
      });
    });
    childProcess.stdin.end(definition.structuredStdin?.(input) ?? undefined);
  } catch (error) {
    try {
      handle.terminate();
    } catch {
      /* ignore */
    }
    const detail = error instanceof Error ? error.message : "Unknown wiring error";
    throw new ProviderLaunchError(
      `Could not wire ${definition.displayName} structured probe: ${detail}`,
      definition.id
    );
  }

  return handle;
}
