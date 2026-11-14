import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { TimelineEvent } from "../../shared/types.js";
import {
  baseSession,
  event,
  renderConversation,
  rerenderConversation,
} from "../../test/sessionConversationTestHarness.js";

/** One user turn plus one assistant reply, so each pair is a rendered item. */
function longTranscript(turns: number): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (let index = 0; index < turns; index += 1) {
    const at = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
    events.push(event(`u-${index}`, "user.message", `question ${index}`, at));
    events.push(event(`a-${index}`, "message.completed", `answer ${index}`, at));
  }
  return events;
}

/** One provider turn with more internal rows than the outer turn window sees. */
function giantTurn(steps: number): TimelineEvent[] {
  const events: TimelineEvent[] = [
    event("giant-user", "user.message", "inspect everything", "2026-01-01T00:00:00.000Z"),
  ];
  for (let index = 0; index < steps; index += 1) {
    const at = (offsetMs: number): string =>
      new Date(Date.UTC(2026, 0, 1, 0, 1, 0, index * 1_000 + offsetMs)).toISOString();
    events.push(
      event(`progress-${index}`, "message.delta", `progress ${index}`, at(0), { thinking: true }),
      event(`tool-${index}-start`, "command.started", "Read", at(100), {
        id: `tool-${index}`,
        name: "Read",
        input: { file_path: `src/${index}.ts` },
      }),
      event(`tool-${index}-end`, "command.completed", "tool_result", at(200), {
        tool_use_id: `tool-${index}`,
        content: `file ${index}`,
      }),
    );
  }
  return events;
}

describe("SessionConversation — render window", () => {
  afterEach(cleanup);

  it("mounts only the tail of a long transcript and offers the rest", () => {
    renderConversation(baseSession(), longTranscript(400));

    // The newest turn is on screen and the oldest is not: a 3,000-event session
    // must not put 3,000 live subtrees in the DOM.
    expect(screen.getByText("answer 399")).toBeTruthy();
    expect(screen.queryByText("answer 0")).toBeNull();
    expect(screen.getByRole("button", { name: /Show earlier messages/ })).toBeTruthy();
  });

  it("keeps a short transcript whole and shows no reveal control", async () => {
    renderConversation(baseSession(), longTranscript(10));

    expect(await screen.findByText("answer 0")).toBeTruthy();
    expect(screen.getByText("answer 9")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Show earlier messages/ })).toBeNull();
  });

  it("paints the latest turns first and fills the rest of the window after", async () => {
    renderConversation(baseSession(), longTranscript(60));

    // The first commit holds only the tail, so a long chat paints in one
    // short frame. The rest of the window mounts above it in later frames.
    expect(screen.getByText("answer 59")).toBeTruthy();
    expect(screen.getByText("question 59")).toBeTruthy();
    expect(screen.queryByText("answer 0")).toBeNull();

    // One step per frame; a loaded test machine draws frames slowly.
    expect(await screen.findByText("answer 0", undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.getAllByText(/^answer \d+$/)).toHaveLength(60);
    expect(screen.queryByRole("button", { name: /Show earlier messages/ })).toBeNull();
  });

  it("offers Show earlier only for items outside the full window while it fills", () => {
    renderConversation(baseSession(), longTranscript(60));
    expect(screen.queryByRole("button", { name: /Show earlier messages/ })).toBeNull();
    cleanup();

    // 800 items, a 120-item window: 680 lie outside it, whatever has mounted.
    renderConversation(baseSession(), longTranscript(400));
    expect(screen.getByRole("button", { name: "Show earlier messages (680)" })).toBeTruthy();
  });

  it("finishes the window, and only the window, when Show earlier is clicked while it fills", () => {
    renderConversation(baseSession(), longTranscript(400));

    fireEvent.click(screen.getByRole("button", { name: /Show earlier messages/ }));

    expect(screen.getByText("answer 340")).toBeTruthy();
    expect(screen.queryByText("answer 339")).toBeNull();
    expect(screen.getByText("answer 399")).toBeTruthy();
  });

  it("starts the fill again when the pane changes session in place", async () => {
    const { rerender } = renderConversation(baseSession(), longTranscript(60));
    expect(await screen.findByText("answer 0", undefined, { timeout: 5000 })).toBeTruthy();

    // Watch every commit: the first one for the new session must hold only its tail.
    let oldestEverMounted = false;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (within(node).queryAllByText("other answer 0").length > 0) oldestEverMounted = true;
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    const other = longTranscript(60).map((item) => ({
      ...item,
      id: `other-${item.id}`,
      sessionId: "session-other",
      message: `other ${item.message}`,
    }));
    rerenderConversation(rerender, baseSession({ id: "session-other" }), other);
    await Promise.resolve();
    observer.disconnect();

    expect(screen.getByText("other answer 59")).toBeTruthy();
    expect(oldestEverMounted).toBe(false);
  });

  it("completes the fill when the history load fails, so later rows do not evict the oldest", async () => {
    const options = { eventsBackfilled: false, historyLoadFailed: true };
    const { rerender } = renderConversation(baseSession(), longTranscript(25), options);
    expect(await screen.findByText("answer 0", undefined, { timeout: 5000 })).toBeTruthy();

    rerenderConversation(rerender, baseSession(), longTranscript(29), options);

    expect(screen.getByText("answer 0")).toBeTruthy();
    expect(screen.getByText("answer 28")).toBeTruthy();
  });

  it("reveals earlier turns when asked", async () => {
    renderConversation(baseSession(), longTranscript(400));
    await screen.findByText("answer 340", undefined, { timeout: 5000 });
    const earliestVisible = (): number => {
      const shown = screen
        .getAllByText(/^answer \d+$/)
        .map((node) => node.textContent ?? "")
        .flatMap((text) => {
          const match = /^answer (\d+)$/.exec(text);
          return match ? [Number(match[1])] : [];
        });
      return Math.min(...shown);
    };
    const before = earliestVisible();

    fireEvent.click(screen.getByRole("button", { name: /Show earlier messages/ }));

    // The window grew, so the transcript now reaches further back — and the
    // newest turn is still mounted, because the window is anchored to the end.
    expect(earliestVisible()).toBeLessThan(before);
    expect(screen.getByText("answer 399")).toBeTruthy();
  });

  it("bounds nested activity inside one giant turn without inventing turns", () => {
    renderConversation(baseSession(), giantTurn(80), {
      defaultToolCallsDisplay: "collapsed",
      defaultToolCallGroupsExpanded: false,
      thinkingDisplay: "preview",
    });

    fireEvent.click(screen.getByRole("button", { name: /Worked for/ }));
    expect(screen.getByRole("button", { name: "Read 79.ts" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Read 0.ts" })).toBeNull();
    expect(screen.getAllByTestId("turn-block")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: /Show earlier activity/ }));
    expect(screen.getByRole("button", { name: "Read 56.ts" })).toBeTruthy();
    expect(screen.getAllByTestId("turn-block")).toHaveLength(1);
  });
});
