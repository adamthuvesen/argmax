import type { TimelineEvent } from "../../shared/types.js";

export interface LearningCandidate {
  kind: "pitfall" | "convention" | "command";
  summary: string;
  evidenceSessionId: string | null;
  evidenceEventId: string | null;
}

const MAX_CANDIDATES_PER_SESSION = 3;
const MIN_REPETITIONS = 2;
const MAX_SUMMARY_LENGTH = 240;

function detectError(payload: Record<string, unknown>): boolean {
  if (payload.is_error === true) return true;
  if (typeof payload.error === "string" && payload.error.length > 0) return true;
  if (typeof payload.exitCode === "number" && payload.exitCode !== 0) return true;
  return false;
}

function extractCommandKey(event: TimelineEvent): string | null {
  if (event.type !== "command.completed") return null;
  if (!detectError(event.payload)) return null;
  // Prefer an explicit tool name; fall back to the raw message text (capped).
  const toolName = typeof event.payload.tool_name === "string" ? event.payload.tool_name : null;
  const message = (event.message ?? "").trim();
  const key = toolName ?? message;
  if (!key) return null;
  return key.slice(0, MAX_SUMMARY_LENGTH);
}

/**
 * Extracts up to MAX_CANDIDATES_PER_SESSION learning candidates from a
 * session's timeline events.
 *
 * v1 heuristic: any tool/command that produced an error in MIN_REPETITIONS+
 * events becomes a "pitfall" learning. The earliest matching event is recorded
 * as evidence so a future UI can deep-link into the session.
 *
 * This is deliberately conservative — synthesizing too many low-signal
 * learnings would dilute the project knowledge surface. Better heuristics
 * (import-path corrections, lint-rule mentions, command transcripts) can land
 * incrementally without changing the call contract.
 */
export function extractLearningCandidates(events: readonly TimelineEvent[]): LearningCandidate[] {
  const buckets = new Map<string, { count: number; firstEvent: TimelineEvent }>();
  for (const event of events) {
    const key = extractCommandKey(event);
    if (!key) continue;
    const existing = buckets.get(key);
    if (existing) {
      existing.count++;
    } else {
      buckets.set(key, { count: 1, firstEvent: event });
    }
  }
  const candidates: LearningCandidate[] = [];
  for (const [key, bucket] of buckets) {
    if (bucket.count < MIN_REPETITIONS) continue;
    candidates.push({
      kind: "pitfall",
      summary: `Recurring failure: ${key} (×${bucket.count})`,
      evidenceSessionId: bucket.firstEvent.sessionId,
      evidenceEventId: bucket.firstEvent.id
    });
    if (candidates.length >= MAX_CANDIDATES_PER_SESSION) break;
  }
  return candidates;
}
