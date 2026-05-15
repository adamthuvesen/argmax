import { logger } from "../../shared/logger.js";
import { errorMessage } from "../../shared/error.js";
import type { ArgmaxDatabase } from "../persistence/database.js";
import type { GhService } from "./ghService.js";
import type { NotificationService } from "../notifications/notificationService.js";
import type { GhPrRecord } from "../../shared/types.js";

export interface CheckFailureContext {
  sessionId: string;
  workspaceId: string;
  prNumber: number;
  headSha: string;
}

export type LaunchFollowUpFn = (context: CheckFailureContext) => Promise<void> | void;

export interface GhPollerDeps {
  database: ArgmaxDatabase;
  ghService: Pick<GhService, "refresh">;
  notifications?: NotificationService | null;
  launchFollowUp: LaunchFollowUpFn;
  intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 60_000;
/**
 * Audit-2026-05-14 M6 — `ghService.refresh()` returns existing cached rows
 * when `gh` fails or no PR is found. Without a freshness guard, an app restart
 * (which clears the in-memory `queued` dedup set) would re-trigger follow-ups
 * for old cached failure rows. A row is "fresh" if its `updatedAt` is within
 * 2× the poll interval — anything older is a cache hit, not a real refresh.
 */
const FRESHNESS_WINDOW_MULTIPLIER = 2;

/**
 * Stage 2 of the CI feedback loop (P8.02). Runs `ghService.refresh` against
 * every running session on an interval; when a session's most recent PR
 * transitions into a `failure` state, fires a notification and schedules a
 * follow-up session pre-filled with the failure context.
 *
 * Failure-state dedup is keyed on `(sessionId, prNumber, headSha)`: a new
 * commit (new headSha) earns a fresh follow-up; the same failed commit polled
 * over and over does not.
 */
export class GhPoller {
  private timer: NodeJS.Timeout | null = null;
  private readonly queued = new Set<string>();
  private inFlight = false;

  constructor(private readonly deps: GhPollerDeps) {}

  start(): void {
    if (this.timer) return;
    const intervalMs = this.deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    // Re-entrancy guard: a slow gh call must not pile up with the next tick.
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const sessionIds = this.listPollableSessionIds();
      for (const sessionId of sessionIds) {
        await this.tickSession(sessionId);
      }
    } finally {
      this.inFlight = false;
    }
  }

  private listPollableSessionIds(): string[] {
    const ids = new Set(this.deps.database.listRunningSessionIds());
    const rows = this.deps.database.connection
      .prepare("SELECT DISTINCT session_id AS id FROM gh_pr")
      .all() as Array<{ id: string }>;
    for (const row of rows) {
      ids.add(row.id);
    }
    return [...ids];
  }

  private async tickSession(sessionId: string): Promise<void> {
    let rows: GhPrRecord[];
    try {
      rows = await this.deps.ghService.refresh(sessionId);
    } catch {
      return;
    }
    if (rows.length === 0) return;
    // Sorted ASC by pr_number — most recent PR is the tail.
    const latest = rows[rows.length - 1];
    if (!latest || latest.lastSeenCheckState !== "failure") return;
    // Audit-2026-05-14 M6 — refresh() returns cached rows on gh failure or
    // when no PR is found. Require the row to be "fresh" (updated within the
    // last 2× poll-interval) before acting on it. Otherwise an app restart
    // would re-fire old failure follow-ups because the in-memory dedup set
    // resets but the persisted rows survive.
    const intervalMs = this.deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    const ageMs = Date.now() - Date.parse(latest.updatedAt);
    if (Number.isNaN(ageMs) || ageMs > intervalMs * FRESHNESS_WINDOW_MULTIPLIER) return;
    const dedupKey = `${sessionId}:${latest.prNumber}:${latest.headSha}`;
    if (this.queued.has(dedupKey)) return;
    this.queued.add(dedupKey);
    let session;
    try {
      session = this.deps.database.getSession(sessionId);
    } catch {
      return;
    }
    this.deps.notifications?.notifyCheckFailure(session, latest);
    try {
      await this.deps.launchFollowUp({
        sessionId,
        workspaceId: session.workspaceId,
        prNumber: latest.prNumber,
        headSha: latest.headSha
      });
    } catch (error) {
      logger.warn("gh.poller", "launchFollowUp failed", {
        sessionId,
        prNumber: latest.prNumber,
        error: errorMessage(error)
      });
    }
  }
}
