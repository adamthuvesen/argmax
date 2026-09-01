import { useEffect, useState } from "react";
import { PROVIDER_TITLE_MODEL } from "../../shared/providerModels.js";
import type { SessionSummary } from "../../shared/types.js";

/**
 * The reply the user would most plausibly send next, minted by the same cheap
 * helper model that names sessions (see `session:suggest-follow-up`) and shown
 * as the composer's placeholder.
 *
 * Only a finished turn gets one: mid-turn there is no settled last message to
 * answer, and a failed or cancelled run needs a decision the model cannot
 * guess. `completedAt` is the key rather than `lastActivityAt`, so a late PR or
 * check event on an idle session does not pay for a second CLI call.
 *
 * `null` whenever the suggestion is in flight, unavailable, or the call failed
 * — every one of those means "keep the static placeholder".
 */
export function useFollowUpSuggestion(
  session: SessionSummary | null,
  enabled: boolean
): string | null {
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const sessionId = session?.id ?? null;
  const provider = session?.provider ?? null;
  const turnEndedAt = enabled && session?.state === "complete" ? session.completedAt : null;

  useEffect(() => {
    setSuggestion(null);
    const api = window.argmax?.session;
    if (!api || !sessionId || !provider || !turnEndedAt) return;
    let stale = false;
    void api
      .suggestFollowUp({ sessionId, provider, modelId: PROVIDER_TITLE_MODEL[provider] })
      .then((result) => {
        if (!stale) setSuggestion(result.suggestion);
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [sessionId, provider, turnEndedAt]);

  return suggestion;
}
