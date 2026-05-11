import { spawn as spawnProcess } from "node:child_process";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { createRequire } from "node:module";
import type { IPty, IPtyForkOptions } from "node-pty";
import type * as NodePty from "node-pty";
import type { ProviderId } from "../../shared/types.js";
import { PROVIDER_MODELS } from "../../shared/providerModels.js";
import { defaultDiscoveryRunner, discoverProviderById, type ProviderDiscoveryRunner } from "./providerDiscovery.js";
import { buildProviderEnvironment, providerShell, shellQuote } from "./providerEnvironment.js";
import { scheduleSigkillEscalation } from "../processControl.js";
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
  structuredResumeArgs: (input: ProviderLaunchInput, resumeConversationId: string) => string[];
  interactiveArgs: (input: ProviderLaunchInput) => string[];
  structuredStdin?: (input: ProviderLaunchInput) => string | null;
}

const CLAUDE_FULL_PERMISSION_ARGS = ["--permission-mode", "bypassPermissions"];
const CODEX_FULL_PERMISSION_ARGS = ["--dangerously-bypass-approvals-and-sandbox"];

const providerDefinitions: ProviderLaunchDefinition[] = [
  {
    id: "claude",
    displayName: "Claude Code",
    binaryName: "claude",
    structuredArgs: (input) => [
      "-p",
      ...CLAUDE_FULL_PERMISSION_ARGS,
      "--model",
      input.modelId,
      "--session-id",
      input.sessionId,
      "--output-format",
      "stream-json",
      "--verbose",
      input.prompt
    ],
    structuredResumeArgs: (input, resumeConversationId) => [
      "-p",
      "--resume",
      resumeConversationId,
      ...CLAUDE_FULL_PERMISSION_ARGS,
      "--model",
      input.modelId,
      "--output-format",
      "stream-json",
      "--verbose",
      input.prompt
    ],
    interactiveArgs: (input) => ["--model", input.modelId, ...CLAUDE_FULL_PERMISSION_ARGS],
    structuredStdin: () => null
  },
  {
    id: "codex",
    displayName: "Codex",
    binaryName: "codex",
    structuredArgs: (input) => [
      "exec",
      "--json",
      ...CODEX_FULL_PERMISSION_ARGS,
      "--model",
      input.modelId,
      ...codexReasoningArgs(input, true),
      "-"
    ],
    structuredResumeArgs: (input, resumeConversationId) => [
      "exec",
      "resume",
      "--json",
      ...CODEX_FULL_PERMISSION_ARGS,
      "--model",
      input.modelId,
      ...codexReasoningArgs(input, true),
      resumeConversationId,
      "-"
    ],
    interactiveArgs: (input) => ["--model", input.modelId, ...codexReasoningArgs(input), ...CODEX_FULL_PERMISSION_ARGS],
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

let defaultAdapterMap: Map<ProviderId, ProviderAdapter> | null = null;

export function getProviderAdapter(
  providerId: ProviderId,
  runner: ProviderDiscoveryRunner = defaultDiscoveryRunner,
  spawnPty: PtySpawner = nodePty.spawn,
  spawnStructuredProcess: ProcessSpawner = spawnProcess
): ProviderAdapter {
  const isDefault =
    runner === defaultDiscoveryRunner &&
    spawnPty === nodePty.spawn &&
    spawnStructuredProcess === spawnProcess;
  let map: Map<ProviderId, ProviderAdapter>;
  if (isDefault) {
    defaultAdapterMap ??= createProviderAdapters(runner, spawnPty, spawnStructuredProcess);
    map = defaultAdapterMap;
  } else {
    map = createProviderAdapters(runner, spawnPty, spawnStructuredProcess);
  }
  const adapter = map.get(providerId);
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

  let ptyProcess: IPty | null;
  try {
    ptyProcess = spawnPty(providerShell(), ["-lc", buildProviderShellCommand(capability.binaryPath, definition.interactiveArgs(input))], {
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
  let killEscalation: { cancel: () => void } | null = null;
  let dataDisposable: { dispose: () => void } = { dispose: () => undefined };
  let exitDisposable: { dispose: () => void } = { dispose: () => undefined };
  const createdAt = () => new Date().toISOString();

  // Release the master PTY FD held by node-pty. Called from both the natural
  // exit path and after the SIGKILL fires, whichever comes first.
  const releasePty = (): void => {
    ptyProcess = null;
  };

  // `disposed` on the handle is the source of truth: terminate() flips it
  // before any work; onData/onExit drop racing emissions when set.
  const handle: ProviderSessionHandle = {
    sessionId: input.sessionId,
    provider: definition.id,
    acceptsInput: true,
    disposed: false,
    sendInput: (data) => {
      if (handle.disposed) return;
      ptyProcess?.write(data);
    },
    resize: (cols, rows) => {
      if (handle.disposed) return;
      ptyProcess?.resize(cols, rows);
    },
    terminate: () => {
      if (handle.disposed) return;
      handle.disposed = true;
      dataDisposable.dispose();
      // exitDisposable stays alive so onExit can cancel the SIGKILL escalation
      // timer if SIGTERM succeeds first.
      killEscalation = scheduleSigkillEscalation(
        () => ptyProcess?.kill("SIGTERM"),
        () => {
          ptyProcess?.kill("SIGKILL");
          releasePty();
        }
      );
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
      killEscalation?.cancel();
      killEscalation = null;
      // Both the terminate() path and the natural exit path land here.
      releasePty();
      dataDisposable.dispose();
      exitDisposable.dispose();
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
    });

    if (input.prompt.trim()) {
      ptyProcess.write(`${input.prompt}\r`);
    }
  } catch (error) {
    // Post-spawn wiring failed: kill the child before re-throwing.
    void handle.terminate();
    const detail = error instanceof Error ? error.message : "Unknown PTY wiring error";
    throw new ProviderLaunchError(
      `Could not wire ${definition.displayName} PTY: ${detail}`,
      definition.id
    );
  }

  return handle;
}

function buildProviderShellCommand(binaryPath: string, args: string[]): string {
  return ["exec", shellQuote(binaryPath), ...args.map((arg) => shellQuote(arg))].join(" ");
}

function codexReasoningArgs(input: ProviderLaunchInput, structured = false): string[] {
  if (!input.reasoningEffort) {
    // No explicit effort — suppress user's global config in structured mode to avoid
    // model_reasoning_summary leaking into API calls for models that don't support it.
    return structured ? ["--ignore-user-config"] : [];
  }
  const args = ["-c", `model_reasoning_effort="${input.reasoningEffort}"`];
  if (structured) {
    const modelDef = PROVIDER_MODELS.codex.find((m) => m.modelId === input.modelId);
    if (modelDef?.disableReasoningSummary) {
      // Explicitly disable reasoning summaries for models that don't support them (e.g. Codex Spark).
      // Overrides any value the user's global Codex config might set.
      args.push("-c", 'model_reasoning_summary="none"');
    }
  }
  return args;
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
    const args = input.resumeConversationId
      ? definition.structuredResumeArgs(input, input.resumeConversationId)
      : definition.structuredArgs(input);
    childProcess = spawnStructuredProcess(capability.binaryPath, args, {
      cwd: input.workspacePath,
      env: buildProviderEnvironment({
        NO_COLOR: "1"
      })
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown process error";
    throw new ProviderLaunchError(`Could not launch ${definition.displayName} structured probe: ${detail}`, definition.id);
  }

  let killEscalation: { cancel: () => void } | null = null;
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
      if (childProcess.stdin.writable) {
        childProcess.stdin.end();
      }
      killEscalation = scheduleSigkillEscalation(
        () => childProcess.kill("SIGTERM"),
        () => childProcess.kill("SIGKILL")
      );
    }
  };

  // Swallow EPIPE (M9): writes after the child closes stdin would crash main.
  childProcess.stdin.on("error", () => undefined);

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
      killEscalation?.cancel();
      killEscalation = null;
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
    void handle.terminate();
    const detail = error instanceof Error ? error.message : "Unknown wiring error";
    throw new ProviderLaunchError(
      `Could not wire ${definition.displayName} structured probe: ${detail}`,
      definition.id
    );
  }

  return handle;
}
