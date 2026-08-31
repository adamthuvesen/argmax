import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseSession, event, renderConversation } from "../../test/sessionConversationTestHarness.js";
import type { ArgmaxApi } from "../../shared/types.js";

const EVENTS = [
  event("u1", "user.message", "compare the score distributions", "2026-05-12T15:00:00.000Z"),
  event("m1", "message.completed", "Day two looks reassuringly boring.", "2026-05-12T15:00:01.000Z")
];

function selectAssistantText(): void {
  const bubbleText = screen.getByText("Day two looks reassuringly boring.");
  const range = document.createRange();
  range.selectNodeContents(bubbleText);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  fireEvent(document, new Event("selectionchange"));
}

describe("SessionConversation selection annotations", () => {
  beforeEach(() => {
    // jsdom implements Range selection/toString but not layout measurement.
    Range.prototype.getBoundingClientRect = () =>
      ({ left: 40, top: 200, right: 240, bottom: 216, width: 200, height: 16, x: 40, y: 200, toJSON: () => ({}) });
    window.localStorage.clear();
    window.argmax = {
      prs: { listForSession: vi.fn(() => new Promise(() => {})) }
    } as unknown as ArgmaxApi;
  });

  afterEach(() => {
    window.getSelection()?.removeAllRanges();
    cleanup();
  });

  it("shows the selection toolbar over selected transcript text", () => {
    renderConversation(baseSession(), EVENTS);
    expect(screen.queryByRole("toolbar", { name: "Selection actions" })).toBeNull();

    selectAssistantText();
    expect(screen.getByRole("toolbar", { name: "Selection actions" })).toBeTruthy();
  });

  it("attaches the selection as an annotation chip and clears the selection", () => {
    renderConversation(baseSession(), EVENTS);
    selectAssistantText();

    fireEvent.click(screen.getByRole("button", { name: "Add selection to chat" }));

    expect(
      screen.getByLabelText("Annotation: Day two looks reassuringly boring.")
    ).toBeTruthy();
    expect(screen.queryByRole("toolbar", { name: "Selection actions" })).toBeNull();
    expect(window.getSelection()?.isCollapsed ?? true).toBe(true);
  });

  it("sends the quoted excerpt ahead of the typed message and clears the chip", async () => {
    const onSendSessionInput = vi.fn().mockResolvedValue(undefined);
    renderConversation(baseSession(), EVENTS, { onSendSessionInput });
    selectAssistantText();
    fireEvent.click(screen.getByRole("button", { name: "Add selection to chat" }));

    const prompt = screen.getByLabelText("Session prompt");
    fireEvent.change(prompt, { target: { value: "why is that good?" } });
    fireEvent.keyDown(prompt, { key: "Enter" });

    await waitFor(() => expect(onSendSessionInput).toHaveBeenCalled());
    expect(onSendSessionInput.mock.calls[0]?.[1]).toBe(
      "Regarding this excerpt from our conversation above:\n\n" +
        "> Day two looks reassuringly boring.\n\n" +
        "why is that good?"
    );
    await waitFor(() =>
      expect(screen.queryByLabelText("Annotation: Day two looks reassuringly boring.")).toBeNull()
    );
  });

  it("removes an annotation from its chip without sending", () => {
    renderConversation(baseSession(), EVENTS);
    selectAssistantText();
    fireEvent.click(screen.getByRole("button", { name: "Add selection to chat" }));

    fireEvent.click(screen.getByRole("button", { name: "Remove annotation" }));
    expect(screen.queryByLabelText(/^Annotation:/)).toBeNull();
  });

  it("opens a side chat seeded with the excerpt and recent context", async () => {
    const onOpenSideChat = vi.fn().mockResolvedValue(undefined);
    renderConversation(baseSession(), EVENTS, { onOpenSideChat });
    selectAssistantText();

    fireEvent.click(screen.getByRole("button", { name: "Ask about selection in side chat" }));

    await waitFor(() => expect(onOpenSideChat).toHaveBeenCalledTimes(1));
    const seed = onOpenSideChat.mock.calls[0]?.[0] as string;
    expect(seed).toContain("> Day two looks reassuringly boring.");
    expect(seed).toContain("User: compare the score distributions");
    expect(screen.queryByRole("toolbar", { name: "Selection actions" })).toBeNull();
    // The excerpt rides into the side chat, not onto this session's composer.
    expect(screen.queryByLabelText(/^Annotation:/)).toBeNull();
  });

  it("hides the side chat action when no side chat handler is wired", () => {
    renderConversation(baseSession(), EVENTS);
    selectAssistantText();

    expect(screen.getByRole("toolbar", { name: "Selection actions" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ask about selection in side chat" })).toBeNull();
  });

  it("opens the details popup seeded with the excerpt", async () => {
    const onOpenDetails = vi.fn().mockResolvedValue(undefined);
    renderConversation(baseSession(), EVENTS, { onOpenDetails });
    selectAssistantText();

    fireEvent.click(screen.getByRole("button", { name: "Explain selection in more detail" }));

    await waitFor(() => expect(onOpenDetails).toHaveBeenCalledTimes(1));
    const seed = onOpenDetails.mock.calls[0]?.[0] as string;
    expect(seed).toContain("> Day two looks reassuringly boring.");
    expect(seed).toContain("Explain this excerpt in more detail");
    expect(screen.queryByRole("toolbar", { name: "Selection actions" })).toBeNull();
  });

  it("hides the details action when no details handler is wired", () => {
    renderConversation(baseSession(), EVENTS);
    selectAssistantText();

    expect(screen.queryByRole("button", { name: "Explain selection in more detail" })).toBeNull();
  });

  it("turns a registered review comment into a chip and serializes it on send", async () => {
    const onSendSessionInput = vi.fn().mockResolvedValue(undefined);
    let sink: ((input: {
      filePath: string;
      line: number | null;
      lineText: string;
      comment: string;
    }) => void) | null = null;
    renderConversation(baseSession(), EVENTS, {
      onSendSessionInput,
      registerAnnotationSink: (next) => {
        sink = next;
      }
    });

    expect(sink).not.toBeNull();
    act(() => {
      sink?.({ filePath: "src/x.ts", line: 9, lineText: "let y = 0;", comment: "why mutable?" });
    });

    expect(screen.getByLabelText("Annotation: src/x.ts:9 — why mutable?")).toBeTruthy();

    const prompt = screen.getByLabelText("Session prompt");
    fireEvent.change(prompt, { target: { value: "fix it" } });
    fireEvent.keyDown(prompt, { key: "Enter" });

    await waitFor(() => expect(onSendSessionInput).toHaveBeenCalled());
    expect(onSendSessionInput.mock.calls[0]?.[1]).toBe(
      "Please address this review comment on the changes:\n\n" +
        "`src/x.ts:9`\n> let y = 0;\nwhy mutable?\n\n" +
        "fix it"
    );
  });

  it("sends a review comment with no typed message", async () => {
    const onSendSessionInput = vi.fn().mockResolvedValue(undefined);
    let sink: ((input: {
      filePath: string;
      line: number | null;
      lineText: string;
      comment: string;
    }) => void) | null = null;
    renderConversation(baseSession(), EVENTS, {
      onSendSessionInput,
      registerAnnotationSink: (next) => {
        sink = next;
      }
    });

    const send = screen.getByRole("button", { name: "Send follow-up" });
    expect(send.hasAttribute("disabled")).toBe(true);

    act(() => {
      sink?.({ filePath: "src/x.ts", line: 9, lineText: "let y = 0;", comment: "why mutable?" });
    });

    expect(send.hasAttribute("disabled")).toBe(false);
    fireEvent.click(send);

    await waitFor(() => expect(onSendSessionInput).toHaveBeenCalled());
    expect(onSendSessionInput.mock.calls[0]?.[1]).toBe(
      "Please address this review comment on the changes:\n\n" +
        "`src/x.ts:9`\n> let y = 0;\nwhy mutable?"
    );
  });

  it("ignores selections outside the transcript", () => {
    renderConversation(baseSession(), EVENTS);
    const prompt = screen.getByLabelText("Session prompt");
    fireEvent.change(prompt, { target: { value: "draft text" } });
    const range = document.createRange();
    range.selectNodeContents(prompt.parentElement as HTMLElement);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent(document, new Event("selectionchange"));

    expect(screen.queryByRole("toolbar", { name: "Selection actions" })).toBeNull();
  });
});
