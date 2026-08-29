import { reasoningEffortsForModel, type ReasoningEffort } from "../../shared/providerModels.js";
import { allModelOptions, type ModelPickerSelection } from "./models.js";

/**
 * Persisted launcher default model (Settings → Agents → "Default model" and
 * the composer picker). App-global, not per project. Stored as provider +
 * modelId + effort; the label is rebuilt from the catalog on read so a renamed
 * model never shows a stale label, and a model that left the catalog falls
 * back to the built-in default.
 *
 * Reads tolerate missing/corrupt values by returning null.
 */
export const LAUNCH_MODEL_KEY = "argmax.launch.model";

export function readStoredLaunchModel(): ModelPickerSelection | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(LAUNCH_MODEL_KEY);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { provider, modelId, reasoningEffort } = parsed as Record<string, unknown>;
  const option = allModelOptions.find(
    (candidate) => candidate.provider === provider && candidate.modelId === modelId
  );
  if (!option) return null;
  const selection: ModelPickerSelection = {
    provider: option.provider,
    label: option.label,
    modelId: option.modelId
  };
  if (option.supportsReasoningEffort) {
    const allowed = reasoningEffortsForModel(option.provider, option.modelId);
    selection.reasoningEffort = allowed.includes(reasoningEffort as ReasoningEffort)
      ? (reasoningEffort as ReasoningEffort)
      : option.reasoningEffort;
  }
  return selection;
}

export function persistLaunchModel(model: ModelPickerSelection): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    LAUNCH_MODEL_KEY,
    JSON.stringify({
      provider: model.provider,
      modelId: model.modelId,
      ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {})
    })
  );
}
