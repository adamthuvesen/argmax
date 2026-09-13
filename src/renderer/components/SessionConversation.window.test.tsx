import { cleanup, fireEvent, screen } from "@testing-library/react";
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

/** One provider turn with more internal rows than the outer turn window sees. */
function giantTurn(steps: number): TimelineEvent[] {
  const events: TimelineEvent[] = [
    event("giant-user", "user.message", "inspect everything", "2026-01-01T00:00:00.000Z")
  ];
  for (let index = 0; index < steps; index += 1) {
    const at = (offsetMs: number): string =>
      new Date(Date.UTC(2026, 0, 1, 0, 1, 0, index * 1_000 + offsetMs)).toISOString();
    events.push(
      event(
        `progress-${index}`,
        "message.delta",
        `progress ${index}`,
        at(0),
        { thinking: true }
      ),
      event(
        `tool-${index}-start`,
        "command.started",
        "Read",
        at(100),
        { id: `tool-${index}`, name: "Read", input: { file_path: `src/${index}.ts` } }
      ),
      event(
        `tool-${index}-end`,
        "command.completed",
        "tool_result",
        at(200),
        { tool_use_id: `tool-${index}`, content: `file ${index}` }
      )
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

  it("bounds nested activity inside one giant turn without inventing turns", () => {
    renderConversation(baseSession(), giantTurn(80), {
      defaultToolCallsDisplay: "collapsed",
      defaultToolCallGroupsExpanded: false,
      thinkingDisplay: "preview"
    });

    fireEvent.click(screen.getByRole("button", { name: /Worked for/ }));
    expect(screen.getByRole("button", { name: "Read 79.ts" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Read 0.ts" })).toBeNull();
    expect(document.querySelectorAll(".turn-block")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: /Show earlier activity/ }));
    expect(screen.getByRole("button", { name: "Read 56.ts" })).toBeTruthy();
    expect(document.querySelectorAll(".turn-block")).toHaveLength(1);
  });
});
