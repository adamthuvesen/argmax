import { describe, expect, it } from "vitest";
import type { TimelineEvent } from "../../shared/types.js";
import { decodeTimelineEvent } from "./canonicalTimeline.js";

function event(
  type: string,
  payload: Record<string, unknown> = {},
  overrides: Partial<TimelineEvent> = {}
): TimelineEvent {
  return {
    id: "event-1",
    sessionId: "session-1",
    type,
    message: "hello",
    payload,
    createdAt: "2026-09-05T10:00:00.000Z",
    ...overrides
  };
}

describe("decodeTimelineEvent", () => {
  it.each([
    {
      provider: "Claude",
      raw: event("command.started", { id: "toolu_1", name: "Bash", providerInvocationId: "run-1" }),
      expected: { phase: "started", toolUseId: "toolu_1", name: "Bash", invocationId: "run-1", running: true }
    },
    {
      provider: "Codex",
      raw: event("command.completed", { id: "item-1", name: "item.tool", server: "argmax", tool: "session_list" }),
      expected: { phase: "completed", toolUseId: "item-1", name: "mcp__argmax__session_list", outcome: "succeeded", running: false }
    },
    {
      provider: "Cursor",
      raw: event("command.started", { call_id: "call-1", name: "other", input: { _toolName: "taskToolCall" }, status: "in_progress" }),
      expected: { phase: "started", toolUseId: "call-1", name: "taskToolCall", running: true }
    },
    {
      provider: "OpenCode",
      raw: event("command.completed", { call_id: "call-2", name: "bash", status: "failed" }),
      expected: { phase: "completed", toolUseId: "call-2", name: "bash", outcome: "failed", running: false }
    },
    {
      provider: "Grok Build",
      raw: event("command.completed", { tool_use_id: "tool-3", id: "result-3", name: "Read" }),
      expected: { phase: "completed", toolUseId: "tool-3", name: "Read", outcome: "succeeded", running: false }
    }
  ])("normalizes $provider tool routing", ({ raw, expected }) => {
    expect(decodeTimelineEvent(raw)).toMatchObject({ kind: "tool", ...expected });
  });

  it("normalizes message linkage and leaves Cursor cumulative text lazy", () => {
    const raw = event("message.delta", {
      type: "assistant",
      item_type: "agent_message",
      sender_thread_id: "thread-child",
      agentModelId: "gpt-6-astra",
      agentReasoningEffort: "high",
      message: { content: [{ text: "whole " }, { text: "answer" }] }
    });
    const decoded = decodeTimelineEvent(raw);

    expect(decoded).toMatchObject({
      kind: "message",
      role: "assistant",
      phase: "delta",
      content: "answer",
      childProse: true,
      providerThreadId: "thread-child",
      agentModelId: "gpt-6-astra",
      agentReasoningEffort: "high"
    });
    expect(decoded.kind === "message" ? decoded.cumulativeText : null).toBe("whole answer");
    const descriptor = Object.getOwnPropertyDescriptor(decoded, "cumulativeText");
    expect(typeof descriptor?.get).toBe("function");
  });

  it("keeps lifecycle and multitask notice details typed", () => {
    expect(decodeTimelineEvent(event("session.compacted", { preTokens: 40_000, postTokens: 8_000 }))).toMatchObject({
      kind: "lifecycle",
      name: "compacted",
      preTokens: 40_000,
      postTokens: 8_000
    });
    expect(decodeTimelineEvent(event("session.provider-changed", { from: "claude", provider: "codex", modelLabel: "Astra" }))).toMatchObject({
      kind: "lifecycle",
      name: "provider-changed",
      from: "Claude",
      to: "Codex",
      modelLabel: "Astra"
    });
    expect(decodeTimelineEvent(event("session.moved", {
      direction: "destination",
      sourceSessionId: "source",
      destinationSessionId: "destination",
      destinationWorkspaceId: "workspace",
      sourceProjectName: "Argmax",
      destinationProjectName: "Dotfiles",
      checkoutMode: "shared"
    }))).toMatchObject({
      kind: "lifecycle",
      name: "moved",
      direction: "destination",
      sourceSessionId: "source",
      destinationSessionId: "destination",
      destinationWorkspaceId: "workspace",
      checkoutMode: "shared"
    });
    expect(decodeTimelineEvent(event("session.archive-requested", {
      workspaceId: "workspace-1",
      removesWorktree: true
    }))).toMatchObject({
      kind: "lifecycle",
      name: "archive-requested",
      workspaceId: "workspace-1",
      removesWorktree: true
    });
    expect(decodeTimelineEvent(event("multitask.finished", {
      childSessionId: "child",
      taskLabel: "Review",
      state: "complete",
      answer: "Done"
    }))).toMatchObject({
      kind: "multitask",
      phase: "finished",
      childSessionId: "child",
      taskLabel: "Review",
      state: "complete",
      answer: "Done"
    });
  });

  it("normalizes approval correlation without coupling it to the approval table", () => {
    expect(decodeTimelineEvent(event("permission.blocked", {
      provider: "cursor",
      providerInvocationId: "run-2",
      providerRequestId: "request-2",
      toolUseId: "tool-2",
      command: "rm output.log",
      riskLevel: "high"
    }))).toMatchObject({
      kind: "approval",
      phase: "blocked",
      provider: "cursor",
      providerInvocationId: "run-2",
      providerRequestId: "request-2",
      toolUseId: "tool-2",
      command: "rm output.log",
      riskLevel: "high"
    });
  });

  it("marks payload truncation errors without treating lookalike text as a marker", () => {
    expect(decodeTimelineEvent(event("error", { truncatedEventId: "large-event" }, {
      message: "event payload truncated"
    }))).toMatchObject({ kind: "error", isPayloadTruncation: true });
    expect(decodeTimelineEvent(event("error", {}, {
      message: "event payload truncated"
    }))).toMatchObject({ kind: "error", isPayloadTruncation: false });
  });

  it("preserves legacy unknown events and rejects malformed payloads without throwing", () => {
    const future = event("session.teleported", { destination: "Mars" });
    expect(decodeTimelineEvent(future)).toMatchObject({
      kind: "unknown",
      reason: "unsupported-type",
      raw: future
    });

    const malformed = event("message.delta");
    malformed.payload = null as unknown as Record<string, unknown>;
    expect(decodeTimelineEvent(malformed)).toMatchObject({
      kind: "unknown",
      reason: "invalid-payload",
      raw: malformed
    });
  });

  it("returns the same decoded object for the same raw object", () => {
    const raw = event("message.completed");
    expect(decodeTimelineEvent(raw)).toBe(decodeTimelineEvent(raw));
  });

  it("retains one reference to multi-megabyte raw data instead of copying it", () => {
    const largeInput = "x".repeat(4 * 1024 * 1024);
    const payload = { id: "large-tool", name: "Bash", input: { command: largeInput } };
    const raw = event("command.started", payload, { message: largeInput });
    const decoded = decodeTimelineEvent(raw);

    expect(decoded.raw).toBe(raw);
    expect(decoded.raw.payload).toBe(payload);
    expect(decoded.raw.message).toBe(largeInput);
    expect(Object.hasOwn(decoded, "payload")).toBe(false);
  });
});
