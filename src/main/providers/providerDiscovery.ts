import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProviderId } from "../../shared/types.js";
import type { ProviderCapabilityReport, ProviderMode } from "./providerTypes.js";
import { buildProviderEnvironment } from "./providerEnvironment.js";

const execFileAsync = promisify(execFile);

interface ProviderDefinition {
  id: ProviderId;
  displayName: string;
  binaryName: string;
  versionArgs: string[];
  modes: ProviderMode[];
  setupGuidance: string;
}

export interface ProviderDiscoveryRunner {
  resolveBinary: (binaryName: string) => Promise<string | null>;
  readVersion: (binaryPath: string, versionArgs: string[]) => Promise<string | null>;
}

const providerDefinitions: ProviderDefinition[] = [
  {
    id: "claude",
    displayName: "Claude Code",
    binaryName: "claude",
    versionArgs: ["--version"],
    modes: ["interactive-pty", "structured-json"],
    setupGuidance:
      "Install Claude Code locally and authenticate it in your normal terminal. Maestro will launch the local `claude` CLI from the selected workspace."
  },
  {
    id: "codex",
    displayName: "Codex",
    binaryName: "codex",
    versionArgs: ["--version"],
    modes: ["interactive-pty", "structured-json"],
    setupGuidance:
      "Install the Codex CLI locally and authenticate it in your normal terminal. Maestro will launch the local `codex` CLI from the selected workspace."
  }
];

export async function discoverProviders(
  runner: ProviderDiscoveryRunner = defaultDiscoveryRunner
): Promise<ProviderCapabilityReport[]> {
  return Promise.all(providerDefinitions.map((definition) => discoverProvider(definition, runner)));
}

export async function discoverProviderById(
  providerId: ProviderId,
  runner: ProviderDiscoveryRunner = defaultDiscoveryRunner
): Promise<ProviderCapabilityReport> {
  const definition = providerDefinitions.find((item) => item.id === providerId);
  if (!definition) {
    throw new Error(`Unknown provider: ${providerId}`);
  }

  return discoverProvider(definition, runner);
}

async function discoverProvider(
  definition: ProviderDefinition,
  runner: ProviderDiscoveryRunner
): Promise<ProviderCapabilityReport> {
  const binaryPath = await runner.resolveBinary(definition.binaryName);
  const version = binaryPath ? await runner.readVersion(binaryPath, definition.versionArgs) : null;

  return {
    provider: definition.id,
    displayName: definition.displayName,
    binaryName: definition.binaryName,
    installed: Boolean(binaryPath),
    binaryPath,
    version,
    modes: definition.modes,
    setupGuidance: binaryPath ? null : definition.setupGuidance
  };
}

export const defaultDiscoveryRunner: ProviderDiscoveryRunner = {
  resolveBinary: async (binaryName) => {
    try {
      const { stdout } = await execFileAsync("which", [binaryName], {
        encoding: "utf8",
        env: buildProviderEnvironment(),
        timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024
      });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  },
  readVersion: async (binaryPath, versionArgs) => {
    try {
      const { stdout, stderr } = await execFileAsync(binaryPath, versionArgs, {
        encoding: "utf8",
        env: buildProviderEnvironment(),
        timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024
      });
      return (stdout || stderr).trim() || null;
    } catch {
      return null;
    }
  }
};
