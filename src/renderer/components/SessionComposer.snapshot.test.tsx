import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { baseSession, renderConversation } from "../../test/sessionConversationTestHarness.js";
import { readDraft } from "../lib/composerDrafts.js";
import { windowSnapshotInbox } from "../lib/windowSnapshotInbox.js";
import { drainWindowSnapshotInbox, type SnapshotPayload } from "../../test/windowSnapshotInboxTestUtil.js";

const capture: SnapshotPayload = {
  attachment: { filePath: "/attachments/window-snapshots/safari.png", mimeType: "image/png", sizeBytes: 12 },
  source: {
    appName: "Safari",
    bundleId: "com.apple.Safari",
    windowTitle: "Docs",
    capturedAt: "2026-10-04T08:00:00Z"
  }
};

describe("SessionComposer window capture", () => {
  beforeEach(() => {
    window.localStorage.clear();
    drainWindowSnapshotInbox();
  });
  afterEach(cleanup);

  it("attaches a capture to the focused composer's draft, like a pasted image, and takes focus", () => {
    renderConversation(baseSession());

    act(() => windowSnapshotInbox.deliver(capture));

    const region = screen.getByLabelText("Attached images");
    expect(region.querySelectorAll("img")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "View window capture: Safari — Docs" })).toBeInTheDocument();
    expect(readDraft("session-a").attachments).toEqual([capture.attachment]);
    expect(screen.getByLabelText("Chat prompt")).toHaveFocus();
  });

  it("does not take a capture in a pane that is not focused, and gives it to the one that is", () => {
    renderConversation(baseSession({ id: "session-hidden" }), [], { isFocused: false });
    expect(screen.queryByLabelText("Attached images")).toBeNull();

    act(() => windowSnapshotInbox.deliver(capture));

    expect(readDraft("session-hidden").attachments).toEqual([]);
    expect(screen.queryByLabelText("Attached images")).toBeNull();
  });

  it("attaches a capture only once, even if it is delivered twice", () => {
    renderConversation(baseSession());

    act(() => windowSnapshotInbox.deliver(capture));
    act(() => windowSnapshotInbox.deliver(capture));

    expect(readDraft("session-a").attachments).toHaveLength(1);
  });
});
