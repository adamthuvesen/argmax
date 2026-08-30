import {
  clampEffort,
  costOf as rendererCostOf,
  DEFAULT_REASONING_EFFORT,
  modelLabelFor,
  PROVIDER_MODEL_DEFAULTS,
  PROVIDER_MODELS,
  reasoningEffortsForModel,
  type ProviderModelSelection,
  type ReasoningEffort
} from "../../shared/providerModels.js";
import type { DiscoveredProvider, ProviderId, SessionCostSummary, SessionSummary } from "../../shared/types.js";

/** A {@link ProviderModelSelection} plus its provider, for the composer picker
 *  that spans providers (an idle session can switch agent). */
export type ModelPickerSelection = ProviderModelSelection & { provider: ProviderId };

/** A picker row: a {@link ModelPickerSelection} plus whether the model exposes
 *  an editable reasoning effort (fast models don't). */
export type ModelPickerOption = ModelPickerSelection & { supportsReasoningEffort: boolean };

export const allModelOptions: ModelPickerOption[] = (Object.keys(PROVIDER_MODELS) as ProviderId[])
  .flatMap((provider) =>
    PROVIDER_MODELS[provider].map((model) => {
      // Clamp the seed onto what the model actually offers, exactly as
      // `modelDefaultForProvider` does: the OpenCode Go variant lists are
      // discrete (Kimi K3 is `max`-only), so an unclamped "medium" would show
      // Medium in the picker while the adapter launched a different variant.
      const reasoningEffort = model.supportsReasoningEffort
        ? clampEffort(DEFAULT_REASONING_EFFORT, reasoningEffortsForModel(provider, model.modelId))
        : undefined;
      return {
        provider,
        label: model.label,
        modelId: model.modelId,
        supportsReasoningEffort: Boolean(model.supportsReasoningEffort),
        ...(reasoningEffort ? { reasoningEffort } : {})
      };
    })
  );

// One row per model now, so the key no longer encodes effort. The cross-provider
// picker needs the provider in the key (model ids can repeat across providers);
// a single-provider picker keys on the model id alone.
export function providerModelKey(model: Pick<ModelPickerSelection, "provider" | "modelId">): string {
  return `${model.provider}:${model.modelId}`;
}

export function modelKey(model: Pick<ProviderModelSelection, "modelId">): string {
  return model.modelId;
}

// Cursor serves a faster variant of each model as a `-fast` id suffix — every
// Cursor model has one except Gemini 3.7 Flash. Claude
// and Codex fast mode is provider-wide (a settings flag / priority tier), not
// tied to the model. OpenCode has no fast tier at all. Kept in sync with the
// Rust cursor adapter's -fast mapping.
export function modelSupportsFastMode(model: Pick<ModelPickerSelection, "provider" | "modelId">): boolean {
  if (model.provider === "opencode") return false;
  if (model.provider !== "cursor") return true;
  // Gemini 3.7 Flash has no `-fast` Cursor variant.
  return !model.modelId.startsWith("gemini-3.7-flash");
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
  const seeded = model.reasoningEffort ?? (model.supportsReasoningEffort ? DEFAULT_REASONING_EFFORT : undefined);
  const reasoningEffort = clampEffort(seeded, reasoningEffortsForModel(provider, model.modelId));
  return {
    label: model.label,
    modelId: model.modelId,
    ...(reasoningEffort ? { reasoningEffort } : {})
  };
}

/** Fallback provider order when the seeded launch model isn't installed or
 *  authenticated: Claude first, then Codex, then Cursor, then OpenCode. */
export const PROVIDER_LAUNCH_PRIORITY: ProviderId[] = ["claude", "codex", "cursor", "opencode"];

/** Last-resort launcher pick when no provider CLI is installed. OpenCode Zen
 *  Big Pickle, not the OpenCode Go default. */
export const FALLBACK_LAUNCH_MODEL: ModelPickerSelection = {
  provider: "opencode",
  label: "Big Pickle",
  modelId: "opencode/big-pickle"
};

/** Unpersisted factory default: highest-priority provider's catalog default. */
export function factoryLaunchModel(): ModelPickerSelection {
  const provider = PROVIDER_LAUNCH_PRIORITY[0];
  return { provider, ...modelDefaultForProvider(provider) };
}

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

/**
 * Catalog default for {@link preferredLaunchProvider}, or Big Pickle when no
 * provider is usable. Used to pre-fill the launcher when the stored global
 * preference is missing or points at an unusable provider.
 */
export function preferredLaunchModel(providers: DiscoveredProvider[]): ModelPickerSelection {
  const preferred = preferredLaunchProvider(providers);
  if (!preferred) return FALLBACK_LAUNCH_MODEL;
  return { provider: preferred, ...modelDefaultForProvider(preferred) };
}

export function modelSelectionFromSession(session: SessionSummary | null): ProviderModelSelection {
  if (!session) {
    return modelDefaultForProvider("codex");
  }
  // The catalog wins over the stored label when it recognizes the id: an
  // imported session's label is the provider's raw API id, not a chip name.
  const label = modelLabelFor(session.provider, session.modelId);
  if (!label) {
    // A model Argmax doesn't carry — an imported transcript can name anything,
    // and a retired model outlives its catalog entry. Fall back to that
    // provider's default rather than showing a raw id the picker can't match.
    return modelDefaultForProvider(session.provider);
  }
  return {
    label,
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
