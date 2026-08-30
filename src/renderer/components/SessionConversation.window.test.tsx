import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { TimelineEvent } from "../../shared/types.js";
import { baseSession, event, renderConversation } from "../../test/sessionConversationTestHarness.js";

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

  it("keeps a short transcript whole and shows no reveal control", () => {
    renderConversation(baseSession(), longTranscript(10));

    expect(screen.getByText("answer 0")).toBeTruthy();
    expect(screen.getByText("answer 9")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Show earlier messages/ })).toBeNull();
  });

  it("reveals earlier turns when asked", () => {
    renderConversation(baseSession(), longTranscript(400));
    const earliestVisible = (): number => {
      const shown = Array.from(document.querySelectorAll("*"))
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
});
