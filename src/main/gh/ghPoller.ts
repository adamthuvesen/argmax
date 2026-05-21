import { BoundedSet } from "../../shared/boundedSet.js";
import { logger } from "../../shared/logger.js";
import { errorMessage } from "../../shared/error.js";
import type { ArgmaxDatabase } from "../persistence/database.js";
import type { GhService } from "./ghService.js";
import type { NotificationService } from "../notifications/notificationService.js";
import type { GhPrRecord } from "../../shared/types.js";
import { listOpenGhPrSessionIds, markGhPrNotified } from "../persistence/gh.js";
import { GH_POLL_INTERVAL_MS } from "../constants/timeouts.js";

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

const DEFAULT_INTERVAL_MS = GH_POLL_INTERVAL_MS;
/**
 * Bound on concurrent `gh pr view` calls per tick. Without it, the loop runs
 * sequentially so a single slow `gh` (15s default timeout) holds the re-
 * entrancy guard for 15s × N sessions — far past the 60s tick, effectively
 * stopping polling. With concurrency, slow calls don't head-of-line block
 * faster ones. (audit-2026-05-17 H10)
 */
const TICK_CONCURRENCY = 4;

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
  // Bounded so a long-running app with frequent CI rebase/force-push cycles
  // doesn't grow the dedup ledger without limit. 500 keys covers thousands of
  // PR/commit pairs before the oldest entry rotates out.
  private readonly queued = new BoundedSet<string>(500);
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
      // Bounded-concurrency fanout — one stuck `gh` no longer holds the
      // remaining sessions hostage. (audit-2026-05-17 H10)
      for (let i = 0; i < sessionIds.length; i += TICK_CONCURRENCY) {
        const chunk = sessionIds.slice(i, i + TICK_CONCURRENCY);
        await Promise.all(chunk.map((id) => this.tickSession(id)));
      }
    } finally {
      this.inFlight = false;
    }
  }

  private listPollableSessionIds(): string[] {
    const ids = new Set(this.deps.database.listRunningSessionIds());
    // Exclude sessions whose recorded gh_pr is closed/merged — they don't
    // need re-polling. Legacy rows where pr_state is NULL keep getting
    // polled (the next refresh fills the column). (audit-2026-05-17 H5)
    for (const id of listOpenGhPrSessionIds(this.deps.database.connection)) {
      ids.add(id);
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
    // Persisted dedup via notified_at survives app restart and is invariant
    // to poll-interval changes (unlike the prior heuristic freshness
    // window). The in-memory `queued` set still short-circuits the common
    // case without a DB write per tick. (audit-2026-05-17 L9)
    const dedupKey = `${sessionId}:${latest.prNumber}:${latest.headSha}`;
    if (this.queued.has(dedupKey)) return;
    if (latest.notifiedAt) {
      // Persisted notification recorded for this exact head_sha — already
      // fired in a prior process; keep the in-memory set primed too.
      this.queued.add(dedupKey);
      return;
    }
    let session;
    try {
      session = this.deps.database.getSession(sessionId);
    } catch {
      return;
    }
    this.queued.add(dedupKey);
    this.deps.notifications?.notifyCheckFailure(session, latest);
    try {
      await this.deps.launchFollowUp({
        sessionId,
        workspaceId: session.workspaceId,
        prNumber: latest.prNumber,
        headSha: latest.headSha
      });
      markGhPrNotified(
        this.deps.database.connection,
        sessionId,
        latest.prNumber,
        latest.headSha,
        new Date().toISOString()
      );
    } catch (error) {
      logger.warn("gh.poller", "launchFollowUp failed", {
        sessionId,
        prNumber: latest.prNumber,
        error: errorMessage(error)
      });
      this.queued.delete(dedupKey);
    }
  }
}
