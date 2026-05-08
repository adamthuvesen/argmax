import { spawn as spawnProcess } from "node:child_process";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { createRequire } from "node:module";
import type { IPty, IPtyForkOptions } from "node-pty";
import type * as NodePty from "node-pty";
import type { ProviderId } from "../../shared/types.js";
import { defaultDiscoveryRunner, discoverProviderById, type ProviderDiscoveryRunner } from "./providerDiscovery.js";
import type {
  ProviderAdapter,
  ProviderCapabilityReport,
  ProviderEvent,
  ProviderLaunchInput,
  ProviderSessionHandle
} from "./providerTypes.js";

const require = createRequire(import.meta.url);
const nodePty = require("node-pty") as typeof NodePty;

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
}

const providerDefinitions: ProviderLaunchDefinition[] = [
  {
    id: "claude",
    displayName: "Claude Code",
    binaryName: "claude",
    structuredArgs: (input) => ["-p", "--output-format", "stream-json", "--verbose", input.prompt]
  },
  {
    id: "codex",
    displayName: "Codex",
    binaryName: "codex",
    structuredArgs: (input) => ["exec", "--json", input.prompt]
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
    ptyProcess = spawnPty(capability.binaryPath, [], {
      name: "xterm-256color",
      cols: input.cols,
      rows: input.rows,
      cwd: input.workspacePath,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: process.env.COLORTERM ?? "truecolor"
      }
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown PTY error";
    throw new ProviderLaunchError(`Could not launch ${definition.displayName}: ${detail}`, definition.id);
  }

  const createdAt = () => new Date().toISOString();
  const dataDisposable = ptyProcess.onData((data) => {
    onEvent({
      sessionId: input.sessionId,
      type: "output",
      stream: "pty",
      message: data,
      createdAt: createdAt()
    });
  });

  const exitDisposable = ptyProcess.onExit(({ exitCode, signal }) => {
    onEvent({
      sessionId: input.sessionId,
      type: exitCode === 0 ? "exit" : "error",
      stream: "system",
      message: signal
        ? `${definition.displayName} exited with code ${exitCode} and signal ${signal}.`
        : `${definition.displayName} exited with code ${exitCode}.`,
      exitCode,
      createdAt: createdAt()
    });
    dataDisposable.dispose();
    exitDisposable.dispose();
  });

  if (input.prompt.trim()) {
    ptyProcess.write(`${input.prompt}\r`);
  }

  return {
    sessionId: input.sessionId,
    provider: definition.id,
    sendInput: (data) => ptyProcess.write(data),
    resize: (cols, rows) => ptyProcess.resize(cols, rows),
    terminate: () => {
      ptyProcess.kill();
    }
  };
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
      env: {
        ...process.env,
        NO_COLOR: "1"
      }
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown process error";
    throw new ProviderLaunchError(`Could not launch ${definition.displayName} structured probe: ${detail}`, definition.id);
  }

  const createdAt = () => new Date().toISOString();
  childProcess.stdout.on("data", (data: Buffer | string) => {
    onEvent({
      sessionId: input.sessionId,
      type: "output",
      stream: "stdout",
      message: data.toString(),
      createdAt: createdAt()
    });
  });
  childProcess.stderr.on("data", (data: Buffer | string) => {
    onEvent({
      sessionId: input.sessionId,
      type: "output",
      stream: "stderr",
      message: data.toString(),
      createdAt: createdAt()
    });
  });
  childProcess.on("error", (error) => {
    onEvent({
      sessionId: input.sessionId,
      type: "error",
      stream: "system",
      message: error.message,
      createdAt: createdAt()
    });
  });
  childProcess.on("exit", (exitCode, signal) => {
    const code = exitCode ?? 1;
    onEvent({
      sessionId: input.sessionId,
      type: code === 0 ? "exit" : "error",
      stream: "system",
      message: signal
        ? `${definition.displayName} structured probe exited with code ${code} and signal ${signal}.`
        : `${definition.displayName} structured probe exited with code ${code}.`,
      exitCode: code,
      createdAt: createdAt()
    });
  });

  return {
    sessionId: input.sessionId,
    provider: definition.id,
    sendInput: (data) => childProcess.stdin.write(data),
    resize: () => undefined,
    terminate: () => {
      childProcess.kill();
    }
  };
}
