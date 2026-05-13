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
      const sessionIds = this.deps.database.listRunningSessionIds();
      for (const sessionId of sessionIds) {
        await this.tickSession(sessionId);
      }
    } finally {
      this.inFlight = false;
    }
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
      console.warn("[argmax] gh-poller: launchFollowUp failed", {
        sessionId,
        prNumber: latest.prNumber,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
