import { describe, expect, it } from "vitest";
import type { TimelineEvent } from "../../shared/types.js";
import { coalesceAssistantGroups } from "./sessionTurnView.js";

function assistantEvent(
  id: string,
  type: "message.completed" | "message.delta" | "error",
  message: string,
  createdAt: string,
  payload: Record<string, unknown> = {}
): TimelineEvent {
  return {
    id,
    sessionId: "s1",
    type,
    message,
    payload,
    createdAt,
    rowCursor: 0
  };
}

describe("coalesceAssistantGroups", () => {
  it("drops a duplicate message.completed with the same text as the prior group", () => {
    const groups = coalesceAssistantGroups([
      assistantEvent("a1", "message.completed", "Hey!", "2026-05-12T15:00:01.000Z"),
      assistantEvent("a2", "message.completed", "Hey!", "2026-05-12T15:00:02.000Z")
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.text).toBe("Hey!");
  });

  it("keeps a thinking delta as its own group, separate from the answer", () => {
    // Extended-thinking arrives as a complete message.delta with
    // payload.thinking === true, followed by the answer's message.completed.
    // The thinking text must NOT be folded into the answer group — it renders
    // as a distinct, collapsible Thought block.
    const groups = coalesceAssistantGroups([
      assistantEvent("t1", "message.delta", "The user wants me to read files.", "2026-05-12T15:00:01.000Z", {
        thinking: true
      }),
      assistantEvent("a1", "message.completed", "Here's the answer.", "2026-05-12T15:00:02.000Z")
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      text: "The user wants me to read files.",
      thinking: true,
      streaming: false
    });
    expect(groups[1]).toMatchObject({ text: "Here's the answer.", streaming: false });
    expect(groups[1]?.thinking).toBeFalsy();
  });

  it("does not merge a thinking delta into a streaming answer delta", () => {
    // A thinking block followed by streaming answer deltas (no completion yet):
    // the answer deltas still coalesce into one streaming group, distinct from
    // the thinking group.
    const groups = coalesceAssistantGroups([
      assistantEvent("t1", "message.delta", "Let me think.", "2026-05-12T15:00:01.000Z", { thinking: true }),
      assistantEvent("a1", "message.delta", "Hello ", "2026-05-12T15:00:02.000Z"),
      assistantEvent("a2", "message.delta", "world", "2026-05-12T15:00:03.000Z")
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ text: "Let me think.", thinking: true });
    expect(groups[1]).toMatchObject({ text: "Hello world", streaming: true });
  });

  it("keeps streaming answer group ids stable when earlier deltas are capped away", () => {
    const beforeCap = coalesceAssistantGroups([
      assistantEvent("a1", "message.delta", "Hello ", "2026-05-12T15:00:01.000Z"),
      assistantEvent("a2", "message.delta", "world", "2026-05-12T15:00:02.000Z")
    ]);
    const afterCap = coalesceAssistantGroups([
      assistantEvent("a2", "message.delta", "world", "2026-05-12T15:00:02.000Z"),
      assistantEvent("a3", "message.delta", "!", "2026-05-12T15:00:03.000Z")
    ]);

    expect(afterCap[0]?.id).toBe(beforeCap[0]?.id);
  });

  it("re-keys only the group that followed a trimmed-away earlier group", () => {
    // The bounded event tail trims from the front. Dropping the first group
    // may re-key the group right behind it (its boundary event is gone), but
    // nothing after that: a positional key would shift every later group,
    // remounting the live bubble at the bottom, replaying its entrance
    // animation, and restarting its typed reveal from nothing.
    const t1 = assistantEvent("t1", "message.delta", "Let me think.", "2026-05-12T15:00:01.000Z", { thinking: true });
    const a1 = assistantEvent("a1", "message.delta", "Hello ", "2026-05-12T15:00:02.000Z");
    const t2 = assistantEvent("t2", "message.delta", "And more.", "2026-05-12T15:00:03.000Z", { thinking: true });
    const a2 = assistantEvent("a2", "message.delta", "world", "2026-05-12T15:00:04.000Z");
    const a3 = assistantEvent("a3", "message.delta", "!", "2026-05-12T15:00:05.000Z");
    const before = coalesceAssistantGroups([t1, a1, t2, a2]);
    const after = coalesceAssistantGroups([a1, t2, a2, a3]);

    expect(before).toHaveLength(4);
    expect(after).toHaveLength(3);
    expect(after[1]?.id).toBe(before[2]?.id);
    expect(after[2]?.id).toBe(before[3]?.id);
  });

  it("keeps a later group's id when an earlier group splits around a new tool call", () => {
    const events = [
      assistantEvent("a1", "message.delta", "Reading. ", "2026-05-12T15:00:01.000Z"),
      assistantEvent("a2", "message.delta", "Found it. ", "2026-05-12T15:00:03.000Z"),
      assistantEvent("t1", "message.delta", "Now summarize.", "2026-05-12T15:00:04.000Z", { thinking: true }),
      assistantEvent("a3", "message.delta", "Summary", "2026-05-12T15:00:05.000Z")
    ];
    const before = coalesceAssistantGroups(events);
    // A tool row lands with a timestamp between a1 and a2 (its own poll was
    // late), so the first answer splits in two.
    const after = coalesceAssistantGroups(events, { splitAt: ["2026-05-12T15:00:02.000Z"] });

    expect(before.map((group) => group.text)).toEqual(["Reading. Found it. ", "Now summarize.", "Summary"]);
    expect(after.map((group) => group.text)).toEqual(["Reading. ", "Found it. ", "Now summarize.", "Summary"]);
    expect(after[2]?.id).toBe(before[1]?.id);
    expect(after[3]?.id).toBe(before[2]?.id);
    expect(after[0]?.id).toBe(before[0]?.id);
  });

  it("folds streamed thinking_delta fragments into ONE growing group", () => {
    // With token streaming, reasoning arrives as many thinking_delta fragments.
    // They must accumulate into a single Thought group, not N tiny ones.
    const groups = coalesceAssistantGroups([
      assistantEvent("t1", "message.delta", "I need ", "2026-05-12T15:00:01.000Z", { thinking: true }),
      assistantEvent("t2", "message.delta", "to read ", "2026-05-12T15:00:02.000Z", { thinking: true }),
      assistantEvent("t3", "message.delta", "the docs.", "2026-05-12T15:00:03.000Z", { thinking: true })
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ text: "I need to read the docs.", thinking: true });
  });

  it("dedups the trailing complete thinking block against the fragments", () => {
    // The whole assistant message re-sends the FULL reasoning after the
    // fragments. Cumulative-aware append makes that a no-op, not a doubling.
    const groups = coalesceAssistantGroups([
      assistantEvent("t1", "message.delta", "I need ", "2026-05-12T15:00:01.000Z", { thinking: true }),
      assistantEvent("t2", "message.delta", "to read.", "2026-05-12T15:00:02.000Z", { thinking: true }),
      assistantEvent("t3", "message.delta", "I need to read.", "2026-05-12T15:00:03.000Z", { thinking: true })
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.text).toBe("I need to read.");
  });

  it("anchors a streamed answer group's lastActivityAt to its FINAL delta", () => {
    // The first delta can predate the turn's tool calls (Cursor streams from
    // the turn start). Ordering keys off lastActivityAt so the answer settles
    // below the tools rather than floating above them.
    const groups = coalesceAssistantGroups([
      assistantEvent("a1", "message.delta", "Hello ", "2026-05-12T15:00:01.000Z"),
      assistantEvent("a2", "message.delta", "world", "2026-05-12T15:00:05.000Z")
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      createdAt: "2026-05-12T15:00:01.000Z",
      lastActivityAt: "2026-05-12T15:00:05.000Z",
      text: "Hello world"
    });
  });

  it("splits assistant groups when a tool starts between streamed chunks", () => {
    const groups = coalesceAssistantGroups(
      [
        assistantEvent("a1", "message.delta", "Exploring the repo.", "2026-05-12T15:00:01.000Z"),
        assistantEvent("a2", "message.delta", "Here is the map.", "2026-05-12T15:00:05.000Z")
      ],
      { splitAt: ["2026-05-12T15:00:03.000Z"] }
    );

    expect(groups.map((group) => group.text)).toEqual(["Exploring the repo.", "Here is the map."]);
  });

  it("flushes the open buffer whenever the kind flips", () => {
    // thinking → answer → thinking yields three groups in order, never merged.
    const groups = coalesceAssistantGroups([
      assistantEvent("t1", "message.delta", "x", "2026-05-12T15:00:01.000Z", { thinking: true }),
      assistantEvent("a1", "message.delta", "y", "2026-05-12T15:00:02.000Z"),
      assistantEvent("t2", "message.delta", "z", "2026-05-12T15:00:03.000Z", { thinking: true })
    ]);

    expect(groups).toHaveLength(3);
    expect(groups[0]).toMatchObject({ text: "x", thinking: true });
    expect(groups[1]).toMatchObject({ text: "y", streaming: true });
    expect(groups[1]?.thinking).toBeFalsy();
    expect(groups[2]).toMatchObject({ text: "z", thinking: true });
  });

  it("coalesces consecutive error events into one log group", () => {
    const groups = coalesceAssistantGroups([
      assistantEvent("a1", "message.completed", "Done.", "2026-05-12T15:00:01.000Z"),
      assistantEvent("e1", "error", "first boom", "2026-05-12T15:00:02.000Z"),
      assistantEvent("e2", "error", "second boom", "2026-05-12T15:00:03.000Z")
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.text).toBe("Done.");
    expect(groups[0]?.error).toBeFalsy();
    expect(groups[1]).toMatchObject({
      text: "first boom\nsecond boom",
      error: true,
      streaming: false
    });
  });

  it("drops a blank error event", () => {
    const groups = coalesceAssistantGroups([
      assistantEvent("e1", "error", "   ", "2026-05-12T15:00:01.000Z")
    ]);
    expect(groups).toHaveLength(0);
  });

  it("drops MCP HTTP client teardown tracing error events", () => {
    const log =
      '2026-09-01T07:21:37.004170Z ERROR rmcp::transport::streamable_http_client: fail to delete session: invalid_refresh_token session_id="abc"';
    const groups = coalesceAssistantGroups([
      assistantEvent("a1", "message.completed", "Done.", "2026-05-12T15:00:01.000Z"),
      assistantEvent("e1", "error", log, "2026-05-12T15:00:02.000Z")
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.text).toBe("Done.");
    expect(groups[0]?.error).toBeFalsy();
  });

  it("drops Codex apply_patch tracing that leaked in as stdout deltas, including context lines", () => {
    const header =
      "2026-09-01T09:08:10.411255Z ERROR codex_core::tools::router: error=apply_patch verification failed: Failed to find expected lines in run_two_model_serving.py:";
    const groups = coalesceAssistantGroups([
      assistantEvent("a1", "message.completed", "Preregistration is written.", "2026-09-01T09:06:31.000Z"),
      assistantEvent("d1", "message.delta", header, "2026-09-01T09:08:10.411Z", { stream: "stdout" }),
      assistantEvent("d2", "message.delta", "point = points[tau]", "2026-09-01T09:08:10.411Z", {
        stream: "stdout"
      }),
      assistantEvent("d3", "message.delta", "interval_wrong, interval_correct = _exchange_counts(point, current)", "2026-09-01T09:08:10.411Z", {
        stream: "stdout"
      }),
      assistantEvent(
        "a2",
        "message.completed",
        "The preregistered runner is ready.",
        "2026-09-01T09:09:16.000Z"
      )
    ]);
    expect(groups.map((group) => group.text)).toEqual([
      "Preregistration is written.",
      "The preregistered runner is ready."
    ]);
    expect(groups.some((group) => group.error)).toBe(false);
  });

  it("lifts session-disconnect tracing that leaked in as a stdout delta into an error group", () => {
    const log =
      '2026-09-01T07:21:37.004170Z ERROR codex_core::session: stream disconnected session_id="abc"';
    const groups = coalesceAssistantGroups([
      assistantEvent("a1", "message.completed", "Done.", "2026-05-12T15:00:01.000Z"),
      assistantEvent("d1", "message.delta", log, "2026-05-12T15:00:02.000Z", { stream: "stdout" })
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[1]).toMatchObject({
      text: log,
      error: true,
      streaming: false
    });
  });

  it("joins continuation lines of kept tracing onto the error group", () => {
    const header =
      '2026-09-01T07:21:37.004170Z ERROR codex_core::session: stream disconnected session_id="abc"';
    const groups = coalesceAssistantGroups([
      assistantEvent("d1", "message.delta", header, "2026-05-12T15:00:01.000Z", { stream: "stdout" }),
      assistantEvent("d2", "message.delta", "retry scheduled", "2026-05-12T15:00:01.001Z", {
        stream: "stdout"
      })
    ]);
    expect(groups).toEqual([
      expect.objectContaining({
        text: `${header}\nretry scheduled`,
        error: true
      })
    ]);
  });

  it("joins completed fragments that continue the previous sentence", () => {
    const groups = coalesceAssistantGroups([
      assistantEvent("a1", "message.completed", "I'll", "2026-05-12T15:00:01.000Z"),
      assistantEvent(
        "a2",
        "message.completed",
        " read the core docs and skim the layout.",
        "2026-05-12T15:00:02.000Z"
      )
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      text: "I'll read the core docs and skim the layout.",
      createdAt: "2026-05-12T15:00:01.000Z",
      lastActivityAt: "2026-05-12T15:00:02.000Z"
    });
  });

  it("does not join a new sentence after a completed one", () => {
    const groups = coalesceAssistantGroups([
      assistantEvent(
        "a1",
        "message.completed",
        "Launching a read-only explore subagent to summarize this repository.",
        "2026-05-12T15:00:01.000Z"
      ),
      assistantEvent("a2", "message.completed", "I'll read the core docs.", "2026-05-12T15:00:02.000Z")
    ]);

    expect(groups.map((group) => group.text)).toEqual([
      "Launching a read-only explore subagent to summarize this repository.",
      "I'll read the core docs."
    ]);
  });
});
