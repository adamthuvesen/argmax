import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { windowSnapshotInbox } from "../lib/windowSnapshotInbox.js";
import { drainWindowSnapshotInbox, type SnapshotPayload } from "../../test/windowSnapshotInboxTestUtil.js";
import { resetToastForTests, toastSnapshot } from "../state/toast.js";
import { useWindowSnapshotAttach } from "./useWindowSnapshotAttach.js";

const snapshot = (name: string): SnapshotPayload => ({
  attachment: { filePath: `/attachments/window-snapshots/${name}.png`, mimeType: "image/png", sizeBytes: 9 },
  source: { appName: "Safari", bundleId: "com.apple.Safari", windowTitle: name, capturedAt: "2026-10-04T08:00:00Z" }
});

function Composer({
  active,
  onAttach,
  floating = false
}: {
  active: boolean;
  onAttach: (s: SnapshotPayload) => void;
  floating?: boolean;
}): null {
  useWindowSnapshotAttach(active, onAttach, floating);
  return null;
}

describe("useWindowSnapshotAttach", () => {
  beforeEach(() => drainWindowSnapshotInbox());
  afterEach(() => {
    cleanup();
    resetToastForTests();
  });

  it("attaches a capture to the composer in use", () => {
    const onAttach = vi.fn();
    render(<Composer active onAttach={onAttach} />);

    act(() => windowSnapshotInbox.deliver(snapshot("a")));

    expect(onAttach).toHaveBeenCalledWith(snapshot("a"));
  });

  it("leaves a capture alone in a composer that is not in use, even one mounted later", () => {
    const inUse = vi.fn();
    const hidden = vi.fn();
    render(<Composer active onAttach={inUse} />);
    // Mounted after, and so the newest: still not the one the user is in.
    render(<Composer active={false} onAttach={hidden} />);

    act(() => windowSnapshotInbox.deliver(snapshot("a")));

    expect(inUse).toHaveBeenCalledOnce();
    expect(hidden).not.toHaveBeenCalled();
  });

  it("keeps a capture taken with no composer in use for the next one, once", () => {
    const first = vi.fn();
    const { rerender } = render(<Composer active={false} onAttach={first} />);
    act(() => windowSnapshotInbox.deliver(snapshot("held")));
    expect(first).not.toHaveBeenCalled();

    rerender(<Composer active onAttach={first} />);
    expect(first).toHaveBeenCalledOnce();
    expect(first).toHaveBeenCalledWith(snapshot("held"));

    rerender(<Composer active={false} onAttach={first} />);
    rerender(<Composer active onAttach={first} />);
    expect(first).toHaveBeenCalledOnce();
  });

  it("gives the capture to a floating composer (More details popup, Multitask dock), even when the chat beside it re-subscribed last", () => {
    const floating = vi.fn();
    const chat = vi.fn();
    const popup = render(<Composer active floating onAttach={floating} />);
    // The chat finishes a send and re-subscribes: now the newest listener.
    const { rerender } = render(<Composer active={false} onAttach={chat} />);
    rerender(<Composer active onAttach={chat} />);

    act(() => windowSnapshotInbox.deliver(snapshot("a")));
    expect(floating).toHaveBeenCalledOnce();
    expect(chat).not.toHaveBeenCalled();

    popup.unmount();
    act(() => windowSnapshotInbox.deliver(snapshot("b")));
    expect(chat).toHaveBeenCalledWith(snapshot("b"));
  });

  it("does not let a floating composer that is not in use hold the chat back", () => {
    const chat = vi.fn();
    render(<Composer active={false} floating onAttach={vi.fn()} />);
    render(<Composer active onAttach={chat} />);

    act(() => windowSnapshotInbox.deliver(snapshot("a")));
    expect(chat).toHaveBeenCalledOnce();
  });

  it("stops listening when the composer unmounts", () => {
    const onAttach = vi.fn();
    const { unmount } = render(<Composer active onAttach={onAttach} />);
    unmount();

    act(() => windowSnapshotInbox.deliver(snapshot("a")));

    expect(onAttach).not.toHaveBeenCalled();
  });

  it("rejects a capture in an image type the composer cannot send, with a toast", () => {
    const onAttach = vi.fn();
    render(<Composer active onAttach={onAttach} />);
    const tiff = snapshot("a");
    tiff.attachment.mimeType = "image/tiff";

    act(() => windowSnapshotInbox.deliver(tiff));

    expect(onAttach).not.toHaveBeenCalled();
    expect(toastSnapshot()?.kind).toBe("error");
  });
});
