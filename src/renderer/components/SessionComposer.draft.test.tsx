import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseSession, renderConversation } from "../../test/sessionConversationTestHarness.js";
import { attachmentProtocolUrl } from "../../shared/attachmentProtocol.js";
import type { ArgmaxApi } from "../../shared/types.js";
import type * as TauriBridgeModule from "../lib/tauriBridge.js";

const SCREENSHOT_PATH = "/attachments/session-a/shot.png";

// The harness installs its own window.argmax, so the transport flag is the one
// thing the attachment hook still needs told.
const remote = vi.hoisted(() => ({ bridge: false }));
vi.mock("../lib/tauriBridge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof TauriBridgeModule>();
  return { ...actual, isRemoteBridge: () => remote.bridge };
});

function prompt(): HTMLTextAreaElement {
  return screen.getByLabelText("Chat prompt");
}

/** Paste of a screenshot: a clipboard carrying one path-less image file. */
function pasteScreenshot(): void {
  const file = new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" });
  fireEvent.paste(prompt(), {
    clipboardData: {
      items: [{ kind: "file", type: "image/png", getAsFile: () => file }]
    }
  });
}

function attachedScreenshots(): string[] {
  const region = screen.queryByLabelText("Attached images");
  if (!region) return [];
  return Array.from(region.querySelectorAll("img")).map((image) => image.getAttribute("src") ?? "");
}

describe("SessionComposer unsent drafts", () => {
  beforeEach(() => {
    window.localStorage.clear();
    // Only the calls this surface makes on mount plus the one the paste needs.
    window.argmax = {
      attachments: {
        saveImage: vi.fn().mockResolvedValue({ filePath: SCREENSHOT_PATH, sizeBytes: 4 })
      },
      // Never settles: these tests are about the composer, and a PR list
      // landing mid-assertion is only an unwrapped state update.
      prs: { listForSession: vi.fn(() => new Promise(() => {})) }
    } as unknown as ArgmaxApi;
  });

  afterEach(() => {
    cleanup();
    remote.bridge = false;
  });

  it("brings the unsent text back when the session is opened again", () => {
    renderConversation(baseSession());
    fireEvent.change(prompt(), { target: { value: "half a thought" } });
    // Switching sessions unmounts the composer with the pane.
    cleanup();

    renderConversation(baseSession());
    expect(prompt().value).toBe("half a thought");
  });

  it("keeps each session's draft to itself", () => {
    renderConversation(baseSession());
    fireEvent.change(prompt(), { target: { value: "for session a" } });
    cleanup();

    renderConversation(baseSession({ id: "session-b" }));
    expect(prompt().value).toBe("");
  });

  it("forgets the draft once the message sends", async () => {
    const onSendSessionInput = vi.fn().mockResolvedValue(undefined);
    renderConversation(baseSession(), [], { onSendSessionInput });
    fireEvent.change(prompt(), { target: { value: "ship it" } });
    fireEvent.keyDown(prompt(), { key: "Enter" });

    await waitFor(() => expect(onSendSessionInput).toHaveBeenCalled());
    await waitFor(() => expect(prompt().value).toBe(""));
    cleanup();

    renderConversation(baseSession());
    expect(prompt().value).toBe("");
  });

  it("leaves the draft in place when the send fails", async () => {
    const onSendSessionInput = vi.fn().mockRejectedValue(new Error("provider offline"));
    renderConversation(baseSession(), [], { onSendSessionInput });
    fireEvent.change(prompt(), { target: { value: "retry me" } });
    fireEvent.keyDown(prompt(), { key: "Enter" });

    await waitFor(() => expect(onSendSessionInput).toHaveBeenCalled());
    cleanup();

    renderConversation(baseSession());
    expect(prompt().value).toBe("retry me");
  });

  it("explains that pasting an image needs the desktop app on the remote bridge", async () => {
    remote.bridge = true;
    renderConversation(baseSession());
    pasteScreenshot();

    // Plain English instead of the dispatcher's "attachments:save-image is
    // only available in the desktop app", and no doomed request.
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Attaching images needs the desktop app."
    );
    expect(window.argmax?.attachments.saveImage).not.toHaveBeenCalled();
    expect(attachedScreenshots()).toEqual([]);
  });

  it("brings a pasted screenshot back when the session is opened again", async () => {
    renderConversation(baseSession());
    pasteScreenshot();

    await waitFor(() => expect(attachedScreenshots()).toEqual([attachmentProtocolUrl(SCREENSHOT_PATH)]));
    cleanup();

    renderConversation(baseSession());
    expect(attachedScreenshots()).toEqual([attachmentProtocolUrl(SCREENSHOT_PATH)]);
  });

  it("keeps each session's screenshots to itself", async () => {
    renderConversation(baseSession());
    pasteScreenshot();

    await waitFor(() => expect(attachedScreenshots()).toHaveLength(1));
    cleanup();

    renderConversation(baseSession({ id: "session-b" }));
    expect(attachedScreenshots()).toEqual([]);
  });

  it("forgets the screenshot once the message sends", async () => {
    const onSendSessionInput = vi.fn().mockResolvedValue(undefined);
    renderConversation(baseSession(), [], { onSendSessionInput });
    pasteScreenshot();
    await waitFor(() => expect(attachedScreenshots()).toHaveLength(1));

    fireEvent.change(prompt(), { target: { value: "what is this" } });
    fireEvent.keyDown(prompt(), { key: "Enter" });

    await waitFor(() => expect(onSendSessionInput).toHaveBeenCalled());
    expect(onSendSessionInput.mock.calls[0]?.[1]).toBe(`what is this @${SCREENSHOT_PATH}`);
    expect(onSendSessionInput.mock.calls[0]?.[4]).toEqual([
      { filePath: SCREENSHOT_PATH, mimeType: "image/png", sizeBytes: 4 }
    ]);
    await waitFor(() => expect(attachedScreenshots()).toEqual([]));
    cleanup();

    renderConversation(baseSession());
    expect(attachedScreenshots()).toEqual([]);
  });

  it("leaves the screenshot in place when the send fails", async () => {
    const onSendSessionInput = vi.fn().mockRejectedValue(new Error("provider offline"));
    renderConversation(baseSession(), [], { onSendSessionInput });
    pasteScreenshot();
    await waitFor(() => expect(attachedScreenshots()).toHaveLength(1));

    fireEvent.change(prompt(), { target: { value: "retry me" } });
    fireEvent.keyDown(prompt(), { key: "Enter" });

    await waitFor(() => expect(onSendSessionInput).toHaveBeenCalled());
    cleanup();

    renderConversation(baseSession());
    expect(attachedScreenshots()).toEqual([attachmentProtocolUrl(SCREENSHOT_PATH)]);
  });
});
