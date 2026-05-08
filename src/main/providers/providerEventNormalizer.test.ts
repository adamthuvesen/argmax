// @vitest-environment node
import { describe, expect, it } from "vitest";
import { normalizeProviderEvent } from "./providerEventNormalizer.js";
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

  it("maps provider command events when structured output names them", () => {
    const events = normalizeProviderEvent(outputEvent('{"type":"command.started","message":"npm test"}\n'));

    expect(events[0]).toMatchObject({
      type: "command.started",
      message: "npm test"
    });
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

  it("normalizes stderr fallback as an error event", () => {
    const events = normalizeProviderEvent(outputEvent("provider warning\n", "stderr"));

    expect(events[0]).toMatchObject({
      type: "error",
      message: "provider warning",
      payload: {
        raw: true,
        stream: "stderr"
      }
    });
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
