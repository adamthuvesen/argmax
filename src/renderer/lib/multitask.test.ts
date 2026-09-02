// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { TimelineEvent } from "../../shared/types.js";
import {
  mergeMultitaskNotice,
  multitaskCommandPrompt,
  multitaskNoticeFor,
  MULTITASK_FINISHED,
  MULTITASK_LAUNCHED
} from "./multitask.js";

function event(type: string, payload: Record<string, unknown>, message = "row"): TimelineEvent {
  return {
    id: `${type}-1`,
    sessionId: "session-parent",
    type: type as TimelineEvent["type"],
    message,
    payload,
    createdAt: "2026-09-02T10:00:00.000Z",
    rowCursor: 1
  };
}

describe("multitaskNoticeFor", () => {
  it("reads a dispatch row, with no state until it finishes", () => {
    const notice = multitaskNoticeFor(
      event(MULTITASK_LAUNCHED, {
        childSessionId: "child-1",
        taskLabel: "Fix the README typo",
        prompt: "Fix the README typo",
        worktree: false
      })
    );

    expect(notice).toEqual({
      childSessionId: "child-1",
      taskLabel: "Fix the README typo",
      prompt: "Fix the README typo",
      worktree: false,
      state: null,
      answer: null
    });
  });

  it("falls back to the row's own message when the label is missing", () => {
    const notice = multitaskNoticeFor(event(MULTITASK_FINISHED, {}, "Side fix finished alongside"));
    expect(notice.taskLabel).toBe("Side fix finished alongside");
  });
});

describe("mergeMultitaskNotice", () => {
  it("completes the card in place instead of erasing what the dispatch said", () => {
    const launched = multitaskNoticeFor(
      event(MULTITASK_LAUNCHED, {
        childSessionId: "child-1",
        taskLabel: "Fix the README typo",
        prompt: "Fix the README typo",
        worktree: true
      })
    );
    const finished = multitaskNoticeFor(
      event(MULTITASK_FINISHED, {
        childSessionId: "child-1",
        taskLabel: "Fix the README typo",
        state: "complete",
        answer: "Fixed it."
      })
    );

    expect(mergeMultitaskNotice(launched, finished)).toEqual({
      childSessionId: "child-1",
      taskLabel: "Fix the README typo",
      // The finish row says nothing about these, and must not blank them.
      prompt: "Fix the README typo",
      worktree: true,
      state: "complete",
      answer: "Fixed it."
    });
  });
});

describe("multitaskCommandPrompt", () => {
  it("takes the prompt after the command", () => {
    expect(multitaskCommandPrompt("/multitask fix the README typo")).toBe("fix the README typo");
    expect(multitaskCommandPrompt("  /MultiTask   bump the version  ")).toBe("bump the version");
  });

  it("is not a command until something is asked for", () => {
    // The bare command is a draft mid-typing, not a dispatch with no prompt.
    expect(multitaskCommandPrompt("/multitask")).toBeNull();
    expect(multitaskCommandPrompt("/multitask   ")).toBeNull();
    expect(multitaskCommandPrompt("tell me about /multitask")).toBeNull();
    expect(multitaskCommandPrompt("/multitasking is hard")).toBeNull();
  });
});
