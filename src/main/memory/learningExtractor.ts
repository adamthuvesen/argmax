import { createHash } from "node:crypto";
import type { TimelineEvent } from "../../shared/types.js";

/**
 * Narrowed to `"pitfall"` — the extractor's v1 heuristic only produces
 * recurring-failure candidates. The broader `"pitfall" | "convention" |
 * "command"` union lives on the persisted `Learning` type (persistence
 * layer) because the SQLite CHECK constraint and downstream UI accept all
 * three; the extractor will widen this union back when "convention" or
 * "command" heuristics land. (audit-2026-05-17 L12)
 */
export interface LearningCandidate {
  kind: "pitfall";
  summary: string;
  evidenceSessionId: string | null;
  evidenceEventId: string | null;
}

const MAX_CANDIDATES_PER_SESSION = 3;
const MIN_REPETITIONS = 2;
const MAX_SUMMARY_LENGTH = 240;
const COMMAND_KEY_PREFIX_CHARS = 120;

function detectError(payload: Record<string, unknown>): boolean {
  if (payload.is_error === true) return true;
  if (typeof payload.error === "string" && payload.error.length > 0) return true;
  if (typeof payload.exitCode === "number" && payload.exitCode !== 0) return true;
  return false;
}

function extractCommandKey(event: TimelineEvent): string | null {
  if (event.type !== "command.completed") return null;
  if (!detectError(event.payload)) return null;
  // Prefer an explicit tool name; fall back to the raw message text. Hash the
  // tail past COMMAND_KEY_PREFIX_CHARS so two failures sharing the first ~120
  // chars but differing afterwards don't collapse into one (R-044). The hash
  // suffix keeps the dedup bucket distinct without ballooning the persisted
  // summary length.
  const toolName = typeof event.payload.tool_name === "string" ? event.payload.tool_name : null;
  const message = (event.message ?? "").trim();
  const source = toolName ?? message;
  if (!source) return null;
  if (source.length <= COMMAND_KEY_PREFIX_CHARS) {
    return source.slice(0, MAX_SUMMARY_LENGTH);
  }
  const prefix = source.slice(0, COMMAND_KEY_PREFIX_CHARS);
  const tailHash = createHash("sha1").update(source.slice(COMMAND_KEY_PREFIX_CHARS)).digest("hex").slice(0, 8);
  return `${prefix}#${tailHash}`.slice(0, MAX_SUMMARY_LENGTH);
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
  // Highest-frequency buckets first — the cap intends to keep the strongest
  // signal, not the first-seen one (Map iteration is insertion-ordered).
  const sortedBuckets = Array.from(buckets.entries()).sort((a, b) => b[1].count - a[1].count);
  const candidates: LearningCandidate[] = [];
  for (const [key, bucket] of sortedBuckets) {
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
