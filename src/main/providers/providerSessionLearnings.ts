import type { ArgmaxDatabase } from "../persistence/database.js";
import type { TimelineEvent } from "../../shared/types.js";
import { logger } from "../../shared/logger.js";
import { errorMessage } from "../../shared/error.js";
import { extractLearningCandidates } from "../memory/learningExtractor.js";

/** Cap the synthesis input. The learning extractor is bucket-based and
 *  doesn't need every event ever — a session with tens of thousands of
 *  events used to load the entire timeline into main memory on every
 *  session-complete. 5,000 events is enough to cover any plausible recent
 *  history while keeping peak memory bounded. */
const SYNTHESIS_EVENT_CAP = 5_000;

/**
 * Walk a completed session's timeline in pages, capping at
 * SYNTHESIS_EVENT_CAP. Per-page slicing keeps peak memory at the cap
 * exactly — without it a 500-row page that lands past the cap would push
 * then slice, briefly holding cap+page-size events in RAM.
 */
function listAllSessionEvents(database: ArgmaxDatabase, sessionId: string): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  let eventCursor = 0;
  while (events.length < SYNTHESIS_EVENT_CAP) {
    const page = database.listSessionEventsSince({
      sessionId,
      eventCursor,
      rawOutputCursor: Number.MAX_SAFE_INTEGER
    });
    if (page.events.length === 0 || page.eventCursor <= eventCursor) {
      return events;
    }
    const remaining = SYNTHESIS_EVENT_CAP - events.length;
    if (page.events.length <= remaining) {
      events.push(...page.events);
    } else {
      events.push(...page.events.slice(0, remaining));
      return events;
    }
    eventCursor = page.eventCursor;
  }
  return events;
}

/**
 * Extract and persist learning candidates from a completed session's timeline.
 * Best-effort: a failing insert (e.g. project was archived mid-flight) is
 * swallowed so the session-complete pipeline can't fail.
 */
export function synthesizeLearnings(
  database: ArgmaxDatabase,
  sessionId: string,
  workspaceId: string
): void {
  try {
    const workspace = database.getWorkspace(workspaceId);
    const events = listAllSessionEvents(database, sessionId);
    const candidates = extractLearningCandidates(events);
    for (const candidate of candidates) {
      database.insertLearning({
        projectId: workspace.projectId,
        kind: candidate.kind,
        summary: candidate.summary,
        evidenceSessionId: candidate.evidenceSessionId,
        evidenceEventId: candidate.evidenceEventId
      });
    }
  } catch (error) {
    logger.warn("providers.memory", "synthesizeLearnings failed", {
      error: errorMessage(error)
    });
  }
}

/**
 * Bump the `hits` counter on each learning id touched by a session, marking
 * `last_seen_at`. Run inside a transaction so partial failure rolls back
 * cleanly. Best-effort: a failing update is swallowed so the session-complete
 * pipeline can't fail.
 */
export function bumpInjectedLearningHits(
  database: ArgmaxDatabase,
  ids: readonly string[]
): void {
  try {
    const now = new Date().toISOString();
    const stmt = database.connection.prepare(
      "UPDATE learnings SET hits = hits + 1, last_seen_at = ? WHERE id = ?"
    );
    database.connection.transaction(() => {
      for (const id of ids) {
        stmt.run(now, id);
      }
    })();
  } catch (error) {
    logger.warn("providers.memory", "bumpInjectedLearningHits failed", {
      error: errorMessage(error),
      batchSize: ids.length,
      ids: ids.slice(0, 16)
    });
  }
}
