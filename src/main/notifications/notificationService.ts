import { Notification } from "electron";
import { BoundedMap, BoundedSet } from "../../shared/boundedSet.js";
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
  private readonly lastNotifiedState = new BoundedMap<string, SessionState>(2000);
  // Bounded to mirror ghPoller.queued — same dedup tuple shape, same growth
  // pressure on long-running sessions.
  private readonly notifiedCheckKeys = new BoundedSet<string>(500);

  constructor(private readonly deps: NotificationServiceDeps) {}

  setEnabled(value: boolean): void {
    this.enabled = value;
  }

  /**
   * Fire-once-per-(session, pr, headSha) notification for a PR check failure.
   * Same focus / supported / enabled gating as `notify`. The dedup key is
   * stamped only after the gates pass — otherwise a failure observed while
   * the window is focused would permanently silence the alert for that
   * (session, pr, headSha) tuple.
   */
  notifyCheckFailure(session: SessionSummary, pr: GhPrRecord): void {
    if (!this.enabled) return;
    const dedupKey = `${session.id}:${pr.prNumber}:${pr.headSha}`;
    if (this.notifiedCheckKeys.has(dedupKey)) return;
    if (this.deps.isWindowFocused()) return;
    if (!this.platformSupported()) return;
    this.notifiedCheckKeys.add(dedupKey);
    const options: NotificationFire = {
      title: `PR #${pr.prNumber} checks failed`,
      body: `${session.modelLabel} — open Argmax to queue a follow-up.`
    };
    this.fireOptions(options);
  }

  notify(session: SessionSummary): void {
    if (!this.enabled) return;
    if (!NOTIFY_STATES.has(session.state)) return;
    const previous = this.lastNotifiedState.get(session.id);
    if (previous === session.state) return;
    this.lastNotifiedState.set(session.id, session.state);
    if (this.deps.isWindowFocused()) return;
    if (!this.platformSupported()) return;
    this.fireOptions(this.buildOptions(session));
  }

  private platformSupported(): boolean {
    const probe = this.deps.isSupported ?? (() => Notification.isSupported());
    return probe();
  }

  private fireOptions(options: NotificationFire): void {
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
