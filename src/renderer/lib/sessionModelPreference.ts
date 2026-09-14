import {
  clampEffort,
  effortForModel,
  REASONING_EFFORTS,
  reasoningEffortsForModel,
  type ReasoningEffort
} from "../../shared/providerModels.js";
import { allModelOptions, type ModelPickerSelection } from "./models.js";

const SESSION_MODEL_KEY_PREFIX = "argmax.sessionModel.";

/** The model and effort the composer should use on the next turn in a chat. */
export function sessionModelKey(sessionId: string): string {
  return `${SESSION_MODEL_KEY_PREFIX}${sessionId}`;
}

/**
 * Read a chat's pending composer selection. The session row remains the
 * source of the active turn's settings, so this override is intentionally
 * separate: changing it while a provider is running must not touch that run.
 */
export function readStoredSessionModel(
  sessionId: string,
  fallback: ModelPickerSelection
): ModelPickerSelection {
  if (typeof window === "undefined") return fallback;

  try {
    const raw = window.localStorage.getItem(sessionModelKey(sessionId));
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return fallback;

    const stored = parsed as { provider?: unknown; modelId?: unknown; reasoningEffort?: unknown };
    const option = allModelOptions.find(
      (candidate) => candidate.provider === stored.provider && candidate.modelId === stored.modelId
    );
    if (!option) return fallback;

    if (!option.supportsReasoningEffort) {
      return { provider: option.provider, label: option.label, modelId: option.modelId };
    }

    const storedEffort = REASONING_EFFORTS.includes(stored.reasoningEffort as ReasoningEffort)
      ? (stored.reasoningEffort as ReasoningEffort)
      : undefined;
    const allowedEfforts = reasoningEffortsForModel(option.provider, option.modelId);
    const reasoningEffort =
      clampEffort(storedEffort ?? option.reasoningEffort, allowedEfforts) ??
      effortForModel(option.provider, option.modelId);

    return {
      provider: option.provider,
      label: option.label,
      modelId: option.modelId,
      ...(reasoningEffort ? { reasoningEffort } : {})
    };
  } catch {
    return fallback;
  }
}

/** Persist a chat's next-turn composer selection without affecting its live turn. */
export function writeStoredSessionModel(sessionId: string, model: ModelPickerSelection): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      sessionModelKey(sessionId),
      JSON.stringify({
        provider: model.provider,
        modelId: model.modelId,
        ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {})
      })
    );
  } catch {
    // Storage failure costs a restored picker choice, never the running turn.
  }
}
