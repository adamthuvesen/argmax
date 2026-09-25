import { describe, expect, it } from "vitest";

import type { TimelineEvent } from "../../shared/types.js";
import { multitaskPendingQuestion } from "./multitaskAsk.js";

function event(id: string, type: string, createdAt: string, message: string, payload: Record<string, unknown>): TimelineEvent {
  return { id, sessionId: "child", type, message, payload, createdAt };
}

const asked = event("ask-start", "command.started", "2026-09-26T10:00:01.000Z", "AskUserQuestion", {
  id: "toolu_ask",
  name: "AskUserQuestion",
  input: {
    questions: [
      { question: "Should this go under fixes or improvements?", header: "Section", options: [{ label: "Fixes" }, { label: "Improvements" }] }
    ]
  }
});

describe("multitaskPendingQuestion", () => {
  it("quotes the question the chat stopped on", () => {
    expect(multitaskPendingQuestion([asked])).toBe("Should this go under fixes or improvements?");
  });

  it("has nothing to quote once the question is answered", () => {
    const answered = event("ask-end", "command.completed", "2026-09-26T10:00:05.000Z", "tool_result", {
      tool_use_id: "toolu_ask",
      content: "Fixes"
    });
    expect(multitaskPendingQuestion([asked, answered])).toBeNull();
  });

  it("ignores every other running tool", () => {
    const read = event("read-start", "command.started", "2026-09-26T10:00:01.000Z", "Read", {
      id: "toolu_read",
      name: "Read",
      input: { file_path: "a.ts" }
    });
    expect(multitaskPendingQuestion([read])).toBeNull();
    expect(multitaskPendingQuestion([])).toBeNull();
  });
});
