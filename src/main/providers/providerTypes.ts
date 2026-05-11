import type { ProviderId } from "../../shared/types.js";
import type { ReasoningEffort } from "../../shared/providerModels.js";

export type ProviderMode = "interactive-pty" | "structured-json";

export interface ProviderCapabilityReport {
  provider: ProviderId;
  displayName: string;
  binaryName: string;
  installed: boolean;
  binaryPath: string | null;
  version: string | null;
  modes: ProviderMode[];
  setupGuidance: string | null;
}

export interface ProviderLaunchInput {
  sessionId: string;
  workspacePath: string;
  prompt: string;
  modelLabel: string;
  modelId: string;
  reasoningEffort?: ReasoningEffort;
  resumeConversationId?: string;
  mode: ProviderMode;
  cols: number;
  rows: number;
}

export interface ProviderEvent {
  sessionId: string;
  type: "output" | "exit" | "error";
  stream: "stdout" | "stderr" | "pty" | "system";
  message: string;
  exitCode?: number;
  createdAt: string;
}

export interface ProviderSessionHandle {
  sessionId: string;
  provider: ProviderId;
  acceptsInput: boolean;
  disposed: boolean;
  sendInput: (input: string) => void;
  resize: (cols: number, rows: number) => void;
  /**
   * Initiates teardown (SIGTERM, then SIGKILL escalation) and resolves when the
   * child process has actually exited (onExit fired). Idempotent — repeated
   * calls return the same already-resolved promise.
   */
  terminate: () => Promise<void>;
}

export interface ProviderAdapter {
  id: ProviderId;
  displayName: string;
  binaryName: string;
  discover: () => Promise<ProviderCapabilityReport>;
  launch: (input: ProviderLaunchInput, onEvent: (event: ProviderEvent) => void) => Promise<ProviderSessionHandle>;
}
