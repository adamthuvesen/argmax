// @vitest-environment node
import { describe, expect, it } from "vitest";
import { mapProviderType, normalizeProviderEvent } from "./providerEventNormalizer.js";
import type { ProviderEvent } from "./providerTypes.js";

describe("normalizeProviderEvent", () => {
  it("maps Codex JSONL agent messages into normalized message events", () => {
    const events = normalizeProviderEvent(
      outputEvent('{"type":"item.completed","item":{"type":"agent_message","text":"All set."}}\n')
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "message.completed",
      message: "All set.",
      payload: {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: "All set."
        }
      }
    });
  });

  it("extracts Claude assistant message content instead of displaying the event type", () => {
    const events = normalizeProviderEvent(
      outputEvent(
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              {
                type: "text",
                text: "Hello from Claude."
              }
            ]
          }
        }) + "\n",
        "stdout"
      ),
      { provider: "claude" }
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "message.completed",
      message: "Hello from Claude."
    });
  });

  it("ignores Claude structural message events that do not contain text", () => {
    const events = normalizeProviderEvent(outputEvent('{"type":"message_start","message":{"role":"assistant"}}\n'), {
      provider: "claude"
    });

    expect(events).toEqual([]);
  });

  it("maps provider command events when structured output names them", () => {
    const events = normalizeProviderEvent(outputEvent('{"type":"command.started","message":"npm test"}\n'));

    expect(events[0]).toMatchObject({
      type: "command.started",
      message: "npm test"
    });
  });

  it("ignores structured lifecycle events that are not user-visible messages", () => {
    const events = normalizeProviderEvent(
      outputEvent('{"type":"thread.started","thread_id":"thread-1"}\n{"type":"turn.started"}\n{"type":"turn.completed"}\n')
    );

    expect(events).toEqual([]);
  });

  it("falls back to raw terminal messages for unparsed provider output", () => {
    const events = normalizeProviderEvent(outputEvent("plain terminal output\n"));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "message.delta",
      message: "plain terminal output",
      payload: {
        raw: true,
        stream: "stdout"
      }
    });
  });

  it("does not turn interactive PTY control streams into chat events", () => {
    const events = normalizeProviderEvent(outputEvent("\u001B[?25h\u001B[1;1HNice!\u001B[0m", "pty"));

    expect(events).toEqual([]);
  });

  it("normalizes stderr fallback as an error event", () => {
    const events = normalizeProviderEvent(outputEvent("\u001B[31mprovider warning\u001B[0m\n", "stderr"));

    expect(events[0]).toMatchObject({
      type: "error",
      message: "provider warning",
      payload: {
        raw: true,
        stream: "stderr"
      }
    });
  });

  it("emits both JSON and raw events when a chunk mixes parsed and unparsed lines", () => {
    const events = normalizeProviderEvent(
      outputEvent('{"type":"command.started","message":"npm test"}\nplain stderr-style line\n')
    );

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "command.started",
      message: "npm test"
    });
    expect(events[1]).toMatchObject({
      type: "message.delta",
      message: "plain stderr-style line",
      payload: {
        raw: true,
        stream: "stdout"
      }
    });
  });
});

describe("mapProviderType", () => {
  it("does not bucket agent.error_handled into the error type", () => {
    expect(mapProviderType("agent.error_handled", null, "claude")).toBeNull();
    expect(mapProviderType("agent.error_handled", null, "codex")).toBeNull();
  });

  it("maps Claude-named events only when provider is claude", () => {
    expect(mapProviderType("message_start", null, "claude")).toBe("message.delta");
    expect(mapProviderType("message_delta", null, "claude")).toBe("message.delta");
    expect(mapProviderType("message_stop", null, "claude")).toBe("message.completed");

    // Claude underscore keys do not leak when provider is codex.
    expect(mapProviderType("message_start", null, "codex")).toBeNull();
    expect(mapProviderType("message_stop", null, "codex")).toBeNull();
  });

  it("maps Codex-named events for codex", () => {
    expect(mapProviderType("message.delta", null, "codex")).toBe("message.delta");
    expect(mapProviderType("message.completed", null, "codex")).toBe("message.completed");
    expect(mapProviderType("command.started", null, "codex")).toBe("command.started");
  });

  it("returns null for unknown provider event names", () => {
    expect(mapProviderType("totally.unknown", null, "claude")).toBeNull();
    expect(mapProviderType("totally.unknown", null, "codex")).toBeNull();
  });
});

function outputEvent(message: string, stream: ProviderEvent["stream"] = "stdout"): ProviderEvent {
  return {
    sessionId: "session-1",
    type: "output",
    stream,
    message,
    createdAt: "2026-05-08T16:00:00.000Z"
  };
}
