import { afterEach, describe, expect, it, vi } from "vitest";
import type { WindowSnapshotAttach } from "../../shared/types.js";
import { resetToastForTests, toastSnapshot } from "../state/toast.js";
import {
  UNCLAIMED_TTL_MS,
  createWindowSnapshotInbox,
  startWindowSnapshotInbox,
  windowSnapshotLabel
} from "./windowSnapshotInbox.js";

function snapshot(app = "Safari", title: string | null = "Docs"): WindowSnapshotAttach {
  return {
    attachment: { filePath: `/tmp/${app}.png`, mimeType: "image/png", sizeBytes: 12 },
    source: { appName: app, bundleId: null, windowTitle: title, capturedAt: "2026-10-04T00:00:00.000Z" }
  };
}

afterEach(resetToastForTests);

describe("window snapshot inbox", () => {
  it("offers a capture to the newest composer and stops at the first that claims it", () => {
    const inbox = createWindowSnapshotInbox();
    const grid = vi.fn(() => true);
    const launcher = vi.fn(() => true);
    inbox.subscribe(grid);
    inbox.subscribe(launcher);

    inbox.deliver(snapshot());

    expect(launcher).toHaveBeenCalledTimes(1);
    expect(grid).not.toHaveBeenCalled();
  });

  it("asks the next composer when the newest one is not the active one, and attaches once", () => {
    const inbox = createWindowSnapshotInbox();
    const active = vi.fn(() => true);
    const background = vi.fn(() => false);
    inbox.subscribe(active);
    inbox.subscribe(background);

    inbox.deliver(snapshot());

    expect(background).toHaveBeenCalledTimes(1);
    expect(active).toHaveBeenCalledTimes(1);
    expect(inbox.unclaimedCount()).toBe(0);
  });

  it("keeps a capture taken with no composer mounted and gives it to the next one, once", () => {
    const inbox = createWindowSnapshotInbox();
    inbox.deliver(snapshot("Mail"));
    expect(inbox.unclaimedCount()).toBe(1);

    const first = vi.fn(() => true);
    inbox.subscribe(first);
    expect(first).toHaveBeenCalledTimes(1);
    expect(inbox.unclaimedCount()).toBe(0);

    const second = vi.fn(() => true);
    inbox.subscribe(second);
    expect(second).not.toHaveBeenCalled();
  });

  it("keeps a capture when a composer declines it, and bounds how many wait", () => {
    const inbox = createWindowSnapshotInbox();
    inbox.subscribe(() => false);
    for (const app of ["A", "B", "C", "D"]) inbox.deliver(snapshot(app));
    expect(inbox.unclaimedCount()).toBe(3);

    const seen: string[] = [];
    inbox.subscribe((captured) => {
      seen.push(captured.source.appName);
      return true;
    });
    expect(seen).toEqual(["B", "C", "D"]);
  });

  it("drops a capture nobody claimed within a minute, and keeps a fresher one", () => {
    let clock = 1_000_000;
    const inbox = createWindowSnapshotInbox(() => clock);
    inbox.deliver(snapshot("Old"));
    clock += UNCLAIMED_TTL_MS - 1;
    inbox.deliver(snapshot("Fresh"));
    expect(inbox.unclaimedCount()).toBe(2);

    clock += 2; // Old is now a minute and a millisecond old; Fresh is 2 ms old.
    const seen: string[] = [];
    inbox.subscribe((captured) => {
      seen.push(captured.source.appName);
      return true;
    });

    expect(seen).toEqual(["Fresh"]);
    expect(inbox.unclaimedCount()).toBe(0);
  });

  it("offers nothing to a composer that mounts after every waiting capture expired", () => {
    let clock = 0;
    const inbox = createWindowSnapshotInbox(() => clock);
    inbox.deliver(snapshot());
    clock += UNCLAIMED_TTL_MS + 1;

    const claim = vi.fn(() => true);
    inbox.subscribe(claim);

    expect(claim).not.toHaveBeenCalled();
    expect(inbox.unclaimedCount()).toBe(0);
  });

  it("stops offering to a composer that unmounted", () => {
    const inbox = createWindowSnapshotInbox();
    const claim = vi.fn(() => true);
    const unsubscribe = inbox.subscribe(claim);
    unsubscribe();
    inbox.deliver(snapshot());
    expect(claim).not.toHaveBeenCalled();
    expect(inbox.unclaimedCount()).toBe(1);
  });
});

describe("startWindowSnapshotInbox", () => {
  it("routes attach events to the inbox and failures to an error toast", () => {
    let attach: (value: WindowSnapshotAttach) => void = () => undefined;
    let fail: (value: { code: string; message: string; action: string | null }) => void = () => undefined;
    const unsubscribe = vi.fn();
    const deliver = vi.fn();
    const stop = startWindowSnapshotInbox(
      {
        onAttach: (listener) => {
          attach = listener;
          return unsubscribe;
        },
        onFailed: (listener) => {
          fail = listener;
          return unsubscribe;
        }
      },
      { deliver }
    );

    attach(snapshot());
    expect(deliver).toHaveBeenCalledWith(snapshot());

    fail({ code: "screen-recording-denied", message: "Screen Recording is off for Argmax.", action: null });
    expect(toastSnapshot()).toEqual({ kind: "error", message: "Screen Recording is off for Argmax." });

    stop();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });

  it("names a snapshot by app and window", () => {
    expect(windowSnapshotLabel(snapshot("Safari", "Docs"))).toBe("Safari — Docs");
    expect(windowSnapshotLabel(snapshot("Finder", null))).toBe("Finder");
  });
});
