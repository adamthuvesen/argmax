import { costOf as rendererCostOf, PROVIDER_MODEL_DEFAULTS, PROVIDER_MODELS, type ProviderModelSelection } from "../../shared/providerModels.js";
import type { ProviderId, SessionCostSummary, SessionSummary } from "../../shared/types.js";

export type ModelPickerSelection = ProviderModelSelection & { provider: ProviderId };

export const allModelOptions: ModelPickerSelection[] = (Object.entries(PROVIDER_MODELS) as Array<[ProviderId, typeof PROVIDER_MODELS[ProviderId]]>)
  .flatMap(([provider, models]) =>
    models.map((model) => ({
      provider,
      label: model.label,
      modelId: model.modelId,
      ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {})
    }))
  );

export function modelValue(model: Pick<ModelPickerSelection, "provider" | "modelId" | "reasoningEffort">): string {
  return model.reasoningEffort
    ? `${model.provider}:${model.modelId}:${model.reasoningEffort}`
    : `${model.provider}:${model.modelId}`;
}

export function optionKey(model: Pick<ProviderModelSelection, "modelId" | "reasoningEffort">): string {
  return model.reasoningEffort ? `${model.modelId}:${model.reasoningEffort}` : model.modelId;
}

export function effortLabel(reasoningEffort: NonNullable<ProviderModelSelection["reasoningEffort"]>): string {
  return `${reasoningEffort[0]?.toUpperCase() ?? ""}${reasoningEffort.slice(1)}`;
}

export function modelDefaultForProvider(provider: ProviderId): ProviderModelSelection {
  const model = PROVIDER_MODEL_DEFAULTS[provider];
  return {
    label: model.label,
    modelId: model.modelId,
    ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {})
  };
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

export function thinkingModelSlug(model: ProviderModelSelection): string {
  const id = model.modelId.toLowerCase().split(":")[0] ?? model.modelId;
  return id.replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
}

export function emptyCostSummary(sessionId: string): SessionCostSummary {
  return {
    sessionId,
    modelId: null,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    costUsd: 0
  };
}

export function costForBucket(
  bucket: keyof SessionCostSummary["tokens"],
  tokens: number,
  modelId: string | null
): number {
  if (!modelId || tokens <= 0) return 0;
  const empty = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return rendererCostOf({ ...empty, [bucket]: tokens }, modelId);
}
