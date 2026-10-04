import type { PendingMessage, SessionSummary } from "../../shared/types.js";
import type { ModelPickerSelection } from "./models.js";

/**
 * The picker selection a queued follow-up was composed under, for taking it
 * back to edit. A row carries the provider (when it was bound for another one),
 * the model and the effort. A row that names no model was queued before a model
 * could be picked, and leaves the picker where it is; a row with no provider
 * runs on the chat's own, as every legacy row always did.
 */
export function selectionOfQueuedMessage(
  entry: Pick<PendingMessage, "provider" | "modelLabel" | "modelId" | "reasoningEffort">,
  session: Pick<SessionSummary, "provider"> | null
): ModelPickerSelection | null {
  const provider = entry.provider ?? session?.provider;
  if (!provider || !entry.modelId || !entry.modelLabel) return null;
  return {
    provider,
    label: entry.modelLabel,
    modelId: entry.modelId,
    ...(entry.reasoningEffort ? { reasoningEffort: entry.reasoningEffort } : {})
  };
}
