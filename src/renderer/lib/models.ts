import {
  costOf as rendererCostOf,
  DEFAULT_REASONING_EFFORT,
  PROVIDER_MODEL_DEFAULTS,
  PROVIDER_MODELS,
  type ProviderModelSelection,
  type ReasoningEffort
} from "../../shared/providerModels.js";
import type { DiscoveredProvider, ProviderId, SessionCostSummary, SessionSummary } from "../../shared/types.js";

export type ModelPickerSelection = ProviderModelSelection & { provider: ProviderId };

/** A picker row: a model plus whether it exposes an editable effort. */
export type ModelPickerOption = ModelPickerSelection & { supportsReasoningEffort: boolean };

export const allModelOptions: ModelPickerOption[] = (Object.keys(PROVIDER_MODELS) as ProviderId[])
  .flatMap((provider) =>
    PROVIDER_MODELS[provider].map((model) => ({
      provider,
      label: model.label,
      modelId: model.modelId,
      supportsReasoningEffort: Boolean(model.supportsReasoningEffort),
      ...(model.supportsReasoningEffort ? { reasoningEffort: DEFAULT_REASONING_EFFORT } : {})
    }))
  );

// One row per model now, so the key no longer encodes effort.
export function modelValue(model: Pick<ModelPickerSelection, "provider" | "modelId">): string {
  return `${model.provider}:${model.modelId}`;
}

export function optionKey(model: Pick<ProviderModelSelection, "modelId">): string {
  return model.modelId;
}

// Cursor serves a faster variant of each model as a `-fast` id suffix — every
// Cursor model has one except Gemini 3.5 Flash (already a fast model). Claude
// and Codex fast mode is provider-wide (a settings flag / priority tier), not
// tied to the model. Kept in sync with the Rust cursor adapter's -fast mapping.
export function modelSupportsFastMode(model: Pick<ModelPickerSelection, "provider" | "modelId">): boolean {
  if (model.provider !== "cursor") return true;
  return model.modelId !== "gemini-3.5-flash";
}

const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra"
};

export function effortLabel(reasoningEffort: ReasoningEffort): string {
  return EFFORT_LABELS[reasoningEffort];
}

export function modelDefaultForProvider(provider: ProviderId): ProviderModelSelection {
  const model = PROVIDER_MODEL_DEFAULTS[provider];
  const reasoningEffort = model.reasoningEffort ?? (model.supportsReasoningEffort ? DEFAULT_REASONING_EFFORT : undefined);
  return {
    label: model.label,
    modelId: model.modelId,
    ...(reasoningEffort ? { reasoningEffort } : {})
  };
}

/** Launch-default provider order: Claude first, then Codex, then Cursor. */
export const PROVIDER_LAUNCH_PRIORITY: ProviderId[] = ["claude", "codex", "cursor"];

/**
 * Highest-priority provider whose CLI is installed and logged in
 * (`authenticated: null` means unknown and counts as usable). Falls back to
 * the highest-priority installed provider when none are logged in.
 */
export function preferredLaunchProvider(providers: DiscoveredProvider[]): ProviderId | null {
  const byId = new Map(providers.map((entry) => [entry.provider, entry]));
  for (const provider of PROVIDER_LAUNCH_PRIORITY) {
    const entry = byId.get(provider);
    if (entry?.installed && entry.authenticated !== false) return provider;
  }
  for (const provider of PROVIDER_LAUNCH_PRIORITY) {
    if (byId.get(provider)?.installed) return provider;
  }
  return null;
}

export function modelSelectionFromSession(session: SessionSummary | null): ProviderModelSelection {
  if (!session) {
    return modelDefaultForProvider("codex");
  }
  return {
    label: session.modelLabel,
    modelId: session.modelId,
    ...(session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {})
  };
}

/** Same as {@link modelSelectionFromSession} but carries the provider, for the
 *  cross-provider composer picker that can switch an idle session's agent. */
export function modelPickerSelectionFromSession(session: SessionSummary | null): ModelPickerSelection {
  return {
    provider: session?.provider ?? "codex",
    ...modelSelectionFromSession(session)
  };
}

const EMPTY_USAGE_COUNTS: SessionCostSummary["tokens"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0
};

export function costForBucket(
  bucket: keyof SessionCostSummary["tokens"],
  tokens: number,
  modelId: string | null
): number {
  if (!modelId || tokens <= 0) return 0;
  return rendererCostOf({ ...EMPTY_USAGE_COUNTS, [bucket]: tokens }, modelId);
}
