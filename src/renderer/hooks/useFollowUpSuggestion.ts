import { useEffect, useState } from "react";
import { PROVIDER_TITLE_MODEL } from "../../shared/providerModels.js";
import type { SessionSummary } from "../../shared/types.js";

/**
 * How long a session has to stay open before it is worth minting a suggestion.
 *
 * `suggestFollowUp` spawns a provider CLI, which is the most expensive thing a
 * session switch can do — measured 2026-09-10, clicking through ten chats at
 * roughly one per second took the machine from 16 helper processes to 115 and
 * the load average from 13 to 22, which is what a switch feels slow *from*.
 * Someone paging through the sidebar looking for a chat passes through most of
 * them, and a placeholder they never read is not worth a CLI boot.
 */
export const SETTLE_MS = 600;

/** Suggestions already minted, keyed by session and the turn they answer. */
const suggestions = new Map<string, string | null>();
/** Calls in flight, so two panes on one session share a single CLI run. */
const pending = new Map<string, Promise<string | null>>();
/** Bounds the cache; sessions are revisited in small working sets. */
const CACHE_LIMIT = 32;

function remember(key: string, suggestion: string | null): void {
  suggestions.set(key, suggestion);
  if (suggestions.size > CACHE_LIMIT) {
    const oldest = suggestions.keys().next().value;
    if (oldest !== undefined) suggestions.delete(oldest);
  }
}

/**
 * The reply the user would most plausibly send next, minted by the same cheap
 * helper model that names sessions (see `session:suggest-follow-up`) and shown
 * as the composer's placeholder.
 *
 * Only a finished turn gets one: mid-turn there is no settled last message to
 * answer, and a failed or cancelled run needs a decision the model cannot
 * guess. `completedAt` is the key rather than `lastActivityAt`, so a late PR or
 * check event on an idle session does not pay for a second CLI call — and it is
 * the cache key for the same reason, so switching back to a chat reuses the
 * suggestion its last turn already earned instead of spawning a CLI again.
 *
 * A failed call is deliberately not cached, so a transient CLI hiccup does not
 * strand the session on the static placeholder until its next turn ends.
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
    const api = window.argmax?.session;
    if (!api || !sessionId || !provider || !turnEndedAt) {
      setSuggestion(null);
      return;
    }
    const key = `${sessionId}:${turnEndedAt}`;
    const cached = suggestions.get(key);
    if (cached !== undefined) {
      setSuggestion(cached);
      return;
    }
    setSuggestion(null);

    let stale = false;
    const timer = window.setTimeout(() => {
      const call =
        pending.get(key) ??
        api
          .suggestFollowUp({ sessionId, provider, modelId: PROVIDER_TITLE_MODEL[provider] })
          .then((result) => {
            remember(key, result.suggestion);
            return result.suggestion;
          })
          .finally(() => {
            pending.delete(key);
          });
      pending.set(key, call);
      void call
        .then((result) => {
          if (!stale) setSuggestion(result);
        })
        .catch(() => undefined);
    }, SETTLE_MS);

    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [sessionId, provider, turnEndedAt]);

  return suggestion;
}
