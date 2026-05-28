import { describe, expect, it, vi } from "vitest";
import type { GhPrRecord, SessionSummary } from "../../../shared/types.js";
import { NotificationService } from "../notificationService.js";

function makePr(overrides: Partial<GhPrRecord> = {}): GhPrRecord {
  return {
    sessionId: "session-1",
    prNumber: 42,
    headSha: "deadbeef",
    lastSeenCheckState: "failure",
    updatedAt: "2026-05-18T00:00:00.000Z",
    prState: "OPEN",
    notifiedAt: null,
    ...overrides
  };
}

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "session-1",
    workspaceId: "workspace-1",
    provider: "claude",
    modelLabel: "Claude Haiku 4.5",
    modelId: "claude-haiku-4-5",
    permissionMode: "auto-approve",
    providerConversationId: null,
    prompt: "Build the thing",
    state: "complete",
    attention: "normal",
    startedAt: "2026-05-01T00:00:00.000Z",
    completedAt: "2026-05-01T00:01:00.000Z",
    lastActivityAt: "2026-05-01T00:01:00.000Z",
    ...overrides
  };
}

describe("NotificationService", () => {
  it("fires on terminal state with unfocused window", () => {
    const fire = vi.fn<(options: { title: string; body: string }) => void>();
    const service = new NotificationService({
      isWindowFocused: () => false,
      isSupported: () => true,
      fire
    });
    service.notify(makeSession({ state: "complete" }));
    expect(fire).toHaveBeenCalledTimes(1);
    const call = fire.mock.calls[0]?.[0];
    expect(call?.title).toBe("Session complete");
    expect(call?.body).toContain("Claude Haiku 4.5");
  });

  it("suppresses when the window is focused", () => {
    const fire = vi.fn();
    const service = new NotificationService({
      isWindowFocused: () => true,
      isSupported: () => true,
      fire
    });
    service.notify(makeSession({ state: "complete" }));
    expect(fire).not.toHaveBeenCalled();
  });

  it("suppresses when Notification.isSupported() is false", () => {
    const fire = vi.fn();
    const service = new NotificationService({
      isWindowFocused: () => false,
      isSupported: () => false,
      fire
    });
    service.notify(makeSession({ state: "complete" }));
    expect(fire).not.toHaveBeenCalled();
  });

  it("does not fire on non-terminal states", () => {
    const fire = vi.fn();
    const service = new NotificationService({
      isWindowFocused: () => false,
      isSupported: () => true,
      fire
    });
    service.notify(makeSession({ state: "running" }));
    service.notify(makeSession({ state: "cancelled" }));
    service.notify(makeSession({ state: "waiting" }));
    expect(fire).not.toHaveBeenCalled();
  });

  it("dedupes repeated calls for the same terminal state", () => {
    const fire = vi.fn();
    const service = new NotificationService({
      isWindowFocused: () => false,
      isSupported: () => true,
      fire
    });
    const summary = makeSession({ state: "complete" });
    service.notify(summary);
    service.notify(summary);
    service.notify(summary);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("fires once for complete then once for failed if the state changes", () => {
    const fire = vi.fn<(options: { title: string; body: string }) => void>();
    const service = new NotificationService({
      isWindowFocused: () => false,
      isSupported: () => true,
      fire
    });
    service.notify(makeSession({ state: "complete" }));
    service.notify(makeSession({ state: "failed" }));
    expect(fire).toHaveBeenCalledTimes(2);
    expect(fire.mock.calls[0]?.[0].title).toBe("Session complete");
    expect(fire.mock.calls[1]?.[0].title).toBe("Session failed");
  });

  it("can be disabled at runtime", () => {
    const fire = vi.fn();
    const service = new NotificationService({
      isWindowFocused: () => false,
      isSupported: () => true,
      fire
    });
    service.setEnabled(false);
    service.notify(makeSession({ state: "complete" }));
    expect(fire).not.toHaveBeenCalled();
  });

  it("re-notifies after forget(sessionId)", () => {
    const fire = vi.fn();
    const service = new NotificationService({
      isWindowFocused: () => false,
      isSupported: () => true,
      fire
    });
    const summary = makeSession({ state: "complete" });
    service.notify(summary);
    service.forget(summary.id);
    service.notify(summary);
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it("notifyCheckFailure does not stamp the dedup key when the window is focused", () => {
    const fire = vi.fn();
    let focused = true;
    const service = new NotificationService({
      isWindowFocused: () => focused,
      isSupported: () => true,
      fire
    });
    const session = makeSession();
    const pr = makePr();
    service.notifyCheckFailure(session, pr);
    expect(fire).not.toHaveBeenCalled();
    // User backgrounds the app; the same failure should now reach them.
    focused = false;
    service.notifyCheckFailure(session, pr);
    expect(fire).toHaveBeenCalledTimes(1);
    const fired = fire.mock.calls[0]?.[0] as { title: string; body: string } | undefined;
    expect(fired?.title).toBe("PR #42 checks failed");
    // A second call with the same dedup key stays suppressed.
    service.notifyCheckFailure(session, pr);
    expect(fire).toHaveBeenCalledTimes(1);
  });
});
