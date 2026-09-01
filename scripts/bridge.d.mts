// Hand-written declarations for the one export TypeScript consumes:
// src/test/bridgeDefaults.test.ts imports the launch-default table to pin it
// against PROVIDER_MODEL_DEFAULTS.
import type { ReasoningEffort } from "../src/shared/providerModels.js";

export declare const LAUNCH_MODEL_DEFAULTS: Record<
  string,
  { modelLabel: string; modelId: string; reasoningEffort: ReasoningEffort | null }
>;
