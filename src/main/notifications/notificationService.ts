import { Notification } from "electron";
import { BoundedSet } from "../../shared/boundedSet.js";
import type { GhPrRecord, SessionState, SessionSummary } from "../../shared/types.js";

const NOTIFY_STATES: ReadonlySet<SessionState> = new Set(["complete", "failed"]);

export interface NotificationFire {
  title: string;
  body: string;
}

export interface NotificationServiceDeps {
  isWindowFocused: () => boolean;
  isSupported?: () => boolean;
  fire?: (options: NotificationFire) => void;
}

export class NotificationService {
  private enabled = true;
  private readonly lastNotifiedState = new Map<string, SessionState>();
  // Bounded to mirror ghPoller.queued — same dedup tuple shape, same growth
  // pressure on long-running sessions.
  private readonly notifiedCheckKeys = new BoundedSet<string>(500);

  constructor(private readonly deps: NotificationServiceDeps) {}

  setEnabled(value: boolean): void {
    this.enabled = value;
  }

  /**
   * Fire-once-per-(session, pr, headSha) notification for a PR check failure.
   * Same focus / supported / enabled gating as `notify`.
   */
  notifyCheckFailure(session: SessionSummary, pr: GhPrRecord): void {
    if (!this.enabled) return;
    const dedupKey = `${session.id}:${pr.prNumber}:${pr.headSha}`;
    if (this.notifiedCheckKeys.has(dedupKey)) return;
    this.notifiedCheckKeys.add(dedupKey);
    if (this.deps.isWindowFocused()) return;
    if (this.deps.isSupported && !this.deps.isSupported()) return;
    if (!this.deps.isSupported && !Notification.isSupported()) return;
    const options: NotificationFire = {
      title: `PR #${pr.prNumber} checks failed`,
      body: `${session.modelLabel} — open Argmax to queue a follow-up.`
    };
    if (this.deps.fire) {
      this.deps.fire(options);
      return;
    }
    new Notification(options).show();
  }

  notify(session: SessionSummary): void {
    if (!this.enabled) return;
    if (!NOTIFY_STATES.has(session.state)) return;
    const previous = this.lastNotifiedState.get(session.id);
    if (previous === session.state) return;
    this.lastNotifiedState.set(session.id, session.state);
    if (this.deps.isWindowFocused()) return;
    if (this.deps.isSupported && !this.deps.isSupported()) return;
    if (!this.deps.isSupported && !Notification.isSupported()) return;
    const options = this.buildOptions(session);
    if (this.deps.fire) {
      this.deps.fire(options);
      return;
    }
    new Notification(options).show();
  }

  forget(sessionId: string): void {
    this.lastNotifiedState.delete(sessionId);
  }

  private buildOptions(session: SessionSummary): NotificationFire {
    if (session.state === "complete") {
      return {
        title: "Session complete",
        body: `${session.modelLabel} finished — open Argmax to review.`
      };
    }
    return {
      title: "Session failed",
      body: `${session.modelLabel} exited with an error. Open Argmax for details.`
    };
  }
}
