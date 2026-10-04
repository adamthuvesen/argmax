import {
  DEFAULT_REASONING_EFFORT,
  effortForModel,
  modelLabelFor,
  successorModelId,
  PROVIDER_MODEL_DEFAULTS,
  PROVIDER_MODELS,
  reasoningEffortsForModel,
  type ProviderModelSelection,
  type ReasoningEffort
} from "../../shared/providerModels.js";
import type { AutoTier, DiscoveredProvider, ProviderId, SessionSummary } from "../../shared/types.js";

/** A {@link ProviderModelSelection} plus its provider, for the composer picker
 *  that spans providers (an idle session can switch agent). `autoTier` marks
 *  an Auto row: the router picks provider, model and effort at launch, and the
 *  rest of the selection is only the fallback it overwrites. */
export type ModelPickerSelection = ProviderModelSelection & { provider: ProviderId; autoTier?: AutoTier };

/** Picker order: the strongest tier first. */
export const AUTO_TIERS: readonly AutoTier[] = ["intelligence", "balanced", "cost", "economy"];

/** The tier alone, for chips and rows under the Router header, where the
 *  "Router" prefix would only make them longer. */
export const AUTO_TIER_SHORT_LABELS: Record<AutoTier, string> = {
  cost: "Speed",
  balanced: "Balance",
  intelligence: "Frontier",
  economy: "Cost"
};

const AUTO_TIER_LABELS: Record<AutoTier, string> = {
  cost: "Router Speed",
  balanced: "Router Balance",
  intelligence: "Router Frontier",
  economy: "Router Cost"
};

// Prose copy of the routing grid in src-tauri/src/routing/table.rs; edit both
// together, and docs/routing.md too.
export const AUTO_TIER_DESCRIPTIONS: Record<AutoTier, string> = {
  cost: "Sonnet and DeepSeek, reviews included",
  balanced: "Sonnet for everyday work, Opus for heavy work and reviews",
  intelligence: "Frontier models, deeper reasoning",
  economy: "DeepSeek for routine work, Sol for larger work; Sonnet for reviews"
};

/** Picker row and recency key for an Auto row, apart from every `provider:modelId`. */
export function autoTierKey(autoTier: AutoTier): string {
  return `auto:${autoTier}`;
}

export function isAutoTier(value: unknown): value is AutoTier {
  return AUTO_TIERS.includes(value as AutoTier);
}

/** An Auto picker row. Provider, model and effort are the backend's fallback,
 *  so every consumer that reads them keeps working. */
export function autoTierSelection(autoTier: AutoTier): ModelPickerSelection {
  const economy = autoTier === "economy";
  return {
    provider: economy ? "codex" : "claude",
    label: AUTO_TIER_LABELS[autoTier],
    modelId: economy ? "gpt-6.1-sol" : "claude-opus-5-5",
    reasoningEffort: "medium",
    autoTier
  };
}

/** The chat chip for a routed session: "Balance → Opus 5.5". The effort
 *  chip beside it names the effort. Null when the chat is pinned. */
export function autoSessionChipLabel(session: SessionSummary): string | null {
  if (!isAutoTier(session.autoTier)) return null;
  const model = modelLabelFor(session.provider, session.modelId) ?? session.modelLabel;
  return `${AUTO_TIER_SHORT_LABELS[session.autoTier]} → ${model}`;
}

/** A picker row: a {@link ModelPickerSelection} plus whether the model exposes
 *  an editable reasoning effort (fast models don't). */
type ModelPickerOption = ModelPickerSelection & { supportsReasoningEffort: boolean };

export const allModelOptions: ModelPickerOption[] = (Object.keys(PROVIDER_MODELS) as ProviderId[])
  .flatMap((provider) =>
    PROVIDER_MODELS[provider].map((model) => {
      // Resolve the seed onto what the model actually offers: the OpenCode
      // variant lists are discrete (Qwen3.8 Flash is high/max only), so an unresolved
      // "medium" would show Medium in the picker while the adapter launched a
      // different variant. The row seed is catalog-level, so it uses the
      // built-in default effort rather than the user's preference.
      const reasoningEffort = model.supportsReasoningEffort
        ? effortForModel(provider, model.modelId)
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

// Eligibility includes the active chat transport. Cursor's legacy CLI suffix
// does not give its ACP chats a speed control. Unknown models default to off.
export function modelSupportsFastMode(model: Pick<ModelPickerSelection, "provider" | "modelId">): boolean {
  return PROVIDER_MODELS[model.provider].find((option) => option.modelId === model.modelId)?.supportsFastMode === true;
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

/** The provider's catalog default, run at the app-wide default effort. The
 *  catalog's own seed stands in when that effort isn't on the model's ladder
 *  and the seed is (GLM-5.3-Flash offers no Medium, and Low reads as a worse
 *  default than the High the catalog names). */
export function modelDefaultForProvider(
  provider: ProviderId,
  preferredEffort: ReasoningEffort = DEFAULT_REASONING_EFFORT
): ProviderModelSelection {
  const model = PROVIDER_MODEL_DEFAULTS[provider];
  const allowed = reasoningEffortsForModel(provider, model.modelId);
  const reasoningEffort = !model.supportsReasoningEffort
    ? undefined
    : allowed.includes(preferredEffort)
      ? preferredEffort
      : (model.reasoningEffort ?? effortForModel(provider, model.modelId, preferredEffort));
  return {
    label: model.label,
    modelId: model.modelId,
    ...(reasoningEffort ? { reasoningEffort } : {})
  };
}

/** Fallback provider order when the seeded launch model isn't installed or
 *  authenticated: Claude first, then Codex, Cursor, OpenCode, Grok Build.
 *  Must list every ProviderId — a provider missing here is invisible to the
 *  launcher even when it is the only one installed, and the array type won't
 *  catch the omission (see the exhaustiveness test in models.test.ts). */
export const PROVIDER_LAUNCH_PRIORITY: ProviderId[] = [
  "claude",
  "codex",
  "cursor",
  "opencode",
  "grok"
];

/** Last-resort launcher pick when no provider CLI is installed: OpenCode's
 *  catalog default. */
export const FALLBACK_LAUNCH_MODEL: ModelPickerSelection = {
  provider: "opencode",
  ...modelDefaultForProvider("opencode")
};

/** Unpersisted factory default: highest-priority provider's catalog default. */
export function factoryLaunchModel(preferredEffort?: ReasoningEffort): ModelPickerSelection {
  const provider = PROVIDER_LAUNCH_PRIORITY[0];
  return { provider, ...modelDefaultForProvider(provider, preferredEffort) };
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
 * Catalog default for {@link preferredLaunchProvider}, or OpenCode's when no
 * provider is usable. Used to pre-fill the launcher when the stored global
 * preference is missing or points at an unusable provider.
 */
export function preferredLaunchModel(
  providers: DiscoveredProvider[],
  preferredEffort?: ReasoningEffort
): ModelPickerSelection {
  const preferred = preferredLaunchProvider(providers);
  if (!preferred) return FALLBACK_LAUNCH_MODEL;
  return { provider: preferred, ...modelDefaultForProvider(preferred, preferredEffort) };
}

export function modelSelectionFromSession(session: SessionSummary | null): ProviderModelSelection {
  if (!session) {
    return modelDefaultForProvider("codex");
  }
  // A replaced id follows its successor before the catalog lookup, so a
  // Sonnet 5 chat keeps a Sonnet row instead of dropping to the provider default.
  const modelId = successorModelId(session.provider, session.modelId);
  // The catalog wins over the stored label when it recognizes the id: an
  // imported session's label is the provider's raw API id, not a chip name.
  const label = modelLabelFor(session.provider, modelId);
  if (!label) {
    // A model Argmax doesn't carry — an imported transcript can name anything,
    // and a retired model outlives its catalog entry. Fall back to that
    // provider's default rather than showing a raw id the picker can't match.
    return modelDefaultForProvider(session.provider);
  }
  // A session row can carry no effort — an imported transcript never recorded
  // one, and older rows predate the field — while the model it names still runs
  // at one. The composer chip has to read like the launcher's ("Opus 5 Medium"),
  // and it has to name the effort the next send will actually use, so resolve
  // the default onto the model's own ladder. The catalog flag is the gate, not
  // the ladder: `reasoningEffortsForModel` answers per provider, so it hands
  // Haiku the full Claude ladder for a model that has no effort at all.
  const supportsEffort =
    PROVIDER_MODELS[session.provider].find((model) => model.modelId === modelId)
      ?.supportsReasoningEffort === true;
  const reasoningEffort =
    session.reasoningEffort ??
    (supportsEffort ? effortForModel(session.provider, modelId) : undefined);
  return {
    label,
    modelId,
    ...(reasoningEffort ? { reasoningEffort } : {})
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
