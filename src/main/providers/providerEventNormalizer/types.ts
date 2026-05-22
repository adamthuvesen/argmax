import type { PersistTimelineEventInput } from "../../persistence/database.js";
import type { UsageCounts } from "../../../shared/providerModels.js";
import type { ProviderId } from "../../../shared/types.js";

export interface NormalizerSessionContext {
  /** Most-recent Codex `turn_context.model` seen for this session. */
  codexCurrentModel: string | null;
  /**
   * Model id passed to `--model` when launching the cursor session. Cursor's
   * stream-json reports `model` as a display name on `system/init` and not at
   * all on `result/success`, so we thread the canonical id through from launch
   * to feed `costOf()` when usage arrives.
   */
  cursorCurrentModel: string | null;
  /**
   * Cursor's `--stream-partial-output` emits each `assistant` row as a
   * *cumulative snapshot* of the message so far, not an incremental chunk.
   * We track the most recent snapshot per turn so we can derive a true
   * suffix-only delta — otherwise the renderer's chunk concatenation
   * produces "ExplExploring the repository..." style duplication.
   * Reset to `null` when the final cumulative row (no timestamp_ms) lands
   * as `message.completed`, signalling end of turn.
   */
  cursorAssistantText: string | null;
}

export function createNormalizerSessionContext(
  initial: { codexCurrentModel?: string; cursorCurrentModel?: string } = {}
): NormalizerSessionContext {
  return {
    codexCurrentModel: initial.codexCurrentModel ?? null,
    cursorCurrentModel: initial.cursorCurrentModel ?? null,
    cursorAssistantText: null
  };
}

export interface NormalizedUsage {
  modelId: string;
  tokens: UsageCounts;
  costUsd: number;
  eventId?: string;
}

export interface NormalizeProviderEventOptions {
  provider?: ProviderId;
  context?: NormalizerSessionContext;
}

export interface NormalizedProviderResult {
  events: PersistTimelineEventInput[];
  usages: NormalizedUsage[];
}
