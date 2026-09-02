import {
  DEFAULT_REASONING_EFFORT,
  effortForModel,
  REASONING_EFFORTS,
  type ReasoningEffort
} from "../../shared/providerModels.js";
import { allModelOptions, type ModelPickerSelection } from "./models.js";

/**
 * Persisted launcher default model (Settings → Agents → "Default model" and
 * the composer picker). App-global, not per project. Stored as provider +
 * modelId; the label is rebuilt from the catalog on read so a renamed model
 * never shows a stale label, and a model that left the catalog falls back to
 * the built-in default.
 *
 * Reads tolerate missing/corrupt values by returning null.
 */
export const LAUNCH_MODEL_KEY = "argmax.launch.model";

/**
 * Persisted app-global default reasoning effort (Settings → Agents → "Default
 * effort"). Kept apart from the model so it survives a trip through a model
 * that can't offer it: picking Grok Build, whose ladder stops at Extra High,
 * shows Medium without overwriting a stored Max. See {@link effortForModel}.
 */
export const DEFAULT_EFFORT_KEY = "argmax.launch.effort";

export function readStoredDefaultEffort(): ReasoningEffort {
  if (typeof window === "undefined") return DEFAULT_REASONING_EFFORT;
  const raw = window.localStorage.getItem(DEFAULT_EFFORT_KEY);
  return REASONING_EFFORTS.includes(raw as ReasoningEffort)
    ? (raw as ReasoningEffort)
    : DEFAULT_REASONING_EFFORT;
}

export function persistDefaultEffort(effort: ReasoningEffort): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(DEFAULT_EFFORT_KEY, effort);
}

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
  const { provider, modelId } = parsed as Record<string, unknown>;
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
    selection.reasoningEffort = effortForModel(option.provider, option.modelId, readStoredDefaultEffort());
  }
  return selection;
}

export function persistLaunchModel(model: ModelPickerSelection): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    LAUNCH_MODEL_KEY,
    JSON.stringify({ provider: model.provider, modelId: model.modelId })
  );
  // An effort that isn't what this model resolves to under the current default
  // is an explicit choice, so it becomes the new app-wide default. An effort
  // that only differs because the model can't offer the stored one is a
  // fallback, and must not overwrite the preference.
  if (
    model.reasoningEffort &&
    model.reasoningEffort !== effortForModel(model.provider, model.modelId, readStoredDefaultEffort())
  ) {
    persistDefaultEffort(model.reasoningEffort);
  }
}
