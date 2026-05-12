import { Notification } from "electron";
import type { SessionState, SessionSummary } from "../../shared/types.js";

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

  constructor(private readonly deps: NotificationServiceDeps) {}

  setEnabled(value: boolean): void {
    this.enabled = value;
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
