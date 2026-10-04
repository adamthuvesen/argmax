import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { TimelineEvent as WireTimelineEvent } from "../../shared/bindings.js";
import type { TimelineEvent } from "../../shared/types.js";
import { decodeTimelineEvent, decodeWireTimelineEvent } from "./canonicalTimeline.js";
import { projectMoveNoticeFor } from "./projectMove.js";

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
  it("uses the Rust semantic contract for the shared provider fixtures", () => {
    const fixtures = JSON.parse(readFileSync(
      new URL("../../shared/timelineSemanticFixtures.json", import.meta.url), "utf8"
    )) as TimelineEvent[];
    expect(decodeTimelineEvent(fixtures[0])).toMatchObject({
      kind: "tool", toolUseId: "toolu_1", invocationId: "turn-1", outcome: "failed"
    });
    expect(decodeTimelineEvent(fixtures[1])).toMatchObject({
      kind: "message", providerThreadId: "child-thread", parentToolUseId: "tool-1", childProse: true
    });
    expect(decodeTimelineEvent(fixtures[2])).toMatchObject({
      kind: "tool", toolUseId: "item-2", outcome: "cancelled"
    });
    expect(decodeTimelineEvent(fixtures[3])).toMatchObject({
      kind: "agent", phase: "completed", providerChildSessionId: "child-1", agentRunId: "tool-2"
    });
    expect(decodeTimelineEvent(fixtures[4])).toMatchObject({
      kind: "multitask", phase: "launched", childSessionId: "child-2", taskLabel: "Explore"
    });
    expect(decodeTimelineEvent(fixtures[5])).toMatchObject({
      kind: "error", code: "delivery-failed", operation: "send"
    });

    const authoritative = { ...fixtures[0], payload: { name: "Bash", id: "wrong", status: "completed" } };
    expect(decodeTimelineEvent(authoritative)).toMatchObject({ toolUseId: "toolu_1", outcome: "failed" });

    const absentIdentity = structuredClone(fixtures[0]);
    if (absentIdentity.semantic?.event.kind !== "tool") throw new Error("tool fixture missing semantics");
    absentIdentity.semantic.event.toolUseId = null;
    absentIdentity.semantic.context.parentToolUseId = null;
    absentIdentity.payload = { id: "wrong", parent_tool_use_id: "wrong-parent" };
    expect(decodeTimelineEvent(absentIdentity)).toMatchObject({ toolUseId: null, parentToolUseId: null });

    const unknown = structuredClone(fixtures[1]);
    if (!unknown.semantic) throw new Error("message fixture missing semantics");
    unknown.semantic.event = { kind: "unknown", reason: "unsupported-type" };
    expect(decodeTimelineEvent(unknown)).toMatchObject({ kind: "unknown", reason: "unsupported-type" });

    const cumulative = structuredClone(fixtures[1]);
    if (cumulative.semantic?.event.kind !== "message") throw new Error("message fixture missing semantics");
    cumulative.semantic.event.cumulativeText = "host normalized";
    cumulative.payload = { type: "assistant", message: { content: [{ text: "raw protocol" }] } };
    expect(decodeTimelineEvent(cumulative)).toMatchObject({ kind: "message", cumulativeText: "host normalized" });
  });

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
    // A checkout move names the directory, not the project — both project
    // names are the same one, so "Argmax → Argmax" is all the other branch
    // could render.
    const attached = projectMoveNoticeFor(
      event("session.moved", {
        direction: "destination",
        sourceSessionId: "source",
        destinationSessionId: "destination",
        destinationWorkspaceId: "workspace",
        sourceProjectName: "Argmax",
        destinationProjectName: "Argmax",
        destinationPath: "/repo/worktrees/feature",
        checkoutMode: "attached"
      })
    );
    expect(attached).toMatchObject({ from: null, to: "feature", checkoutMode: "attached" });
    // The payload rows written before the archive stopped reporting a removal
    // still carry `removesWorktree`; an unknown payload key is ignored, not a
    // row that fails to decode.
    expect(decodeTimelineEvent(event("session.archive-requested", {
      workspaceId: "workspace-1",
      retainsWorktree: true,
      removesWorktree: false
    }))).toMatchObject({
      kind: "lifecycle",
      name: "archive-requested",
      workspaceId: "workspace-1"
    });
    expect(decodeTimelineEvent(event("session.archive-requested", {
      workspaceId: "workspace-1",
      removesWorktree: false
    }))).not.toHaveProperty("removesWorktree");
    expect(decodeTimelineEvent(event("session.note", { operation: "workspace.archive" }))).toMatchObject({
      kind: "lifecycle",
      name: "note",
      operation: "workspace.archive"
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

  it("keeps an invalid wire payload readable as diagnostic JSON", () => {
    const wire = { ...event("message.completed"), payload: ["unexpected", 42], rowCursor: null } as WireTimelineEvent;
    const decoded = decodeWireTimelineEvent(wire);
    expect(decoded.payload).toEqual({ __argmaxInvalidPayload: true, rawPayload: ["unexpected", 42] });
    expect(decodeTimelineEvent(decoded)).toMatchObject({ kind: "unknown", reason: "invalid-payload" });
    expect(JSON.parse(JSON.stringify(decoded.payload))).toEqual({ __argmaxInvalidPayload: true, rawPayload: ["unexpected", 42] });
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
