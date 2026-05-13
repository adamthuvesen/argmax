// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createNormalizerSessionContext,
  mapProviderType,
  normalizeProviderEvent,
  normalizeProviderEventWithUsage
} from "./providerEventNormalizer.js";
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

  it("maps Codex item tool events into visible command events", () => {
    const events = normalizeProviderEvent(
      outputEvent(
        [
          '{"type":"item.started","item":{"id":"ws_1","type":"web_search","query":"","action":{"type":"other"}}}',
          '{"type":"item.completed","item":{"id":"ws_1","type":"web_search","query":"pizza recipe","action":{"type":"search","query":"pizza recipe","queries":["pizza recipe"]}}}'
        ].join("\n") + "\n"
      ),
      { provider: "codex" }
    );

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "command.started",
      message: "web_search",
      payload: {
        id: "ws_1",
        type: "web_search",
        name: "web_search",
        input: {},
        providerEventType: "item.started"
      }
    });
    expect(events[1]).toMatchObject({
      type: "command.completed",
      message: "web_search",
      payload: {
        id: "ws_1",
        input: {
          query: "pizza recipe",
          queries: ["pizza recipe"]
        },
        providerEventType: "item.completed"
      }
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

  it("skips JSON.parse on lines over the size cap and emits a truncation marker", () => {
    // 1 MiB + 1 byte of pure `x` — `tryParseJsonObject` would just return null
    // here, but we want the cap to short-circuit BEFORE the parse attempt so
    // the main process can't be blocked by a malicious multi-MiB blob.
    const oversized = "x".repeat(1_048_577);
    const events = normalizeProviderEvent(outputEvent(`${oversized}\n`));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "error",
      payload: { truncated: true, droppedBytes: oversized.length }
    });
    expect(events[0]?.message).toContain("too large to parse");
    // The huge payload must not be embedded back into the event message.
    expect((events[0]?.message ?? "").length).toBeLessThan(200);
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

describe("detectPermissionGate (replayed from __fixtures__)", () => {
  it("emits approval.requested for a Claude SDKPermissionDeniedMessage", () => {
    const fixtureLine = readFixture("claude_permission_denied.jsonl");
    const events = normalizeProviderEvent(outputEvent(`${fixtureLine}\n`), { provider: "claude" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "approval.requested",
      message: "Bash",
      payload: {
        command: "Bash",
        reason: "Ask mode requires user approval for Bash",
        riskLevel: "high",
        toolUseId: "toolu_01ABC123"
      }
    });
  });

  it("emits approval.requested for a Codex item/commandExecution/requestApproval", () => {
    const fixtureLine = readFixture("codex_command_approval_request.jsonl");
    const events = normalizeProviderEvent(outputEvent(`${fixtureLine}\n`), { provider: "codex" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "approval.requested",
      message: "rm -rf /tmp/build",
      payload: {
        command: "rm -rf /tmp/build",
        reason: "Clean build artifacts",
        riskLevel: "high"
      }
    });
  });

  it("emits approval.requested for a Codex item/fileChange/requestApproval", () => {
    const fixtureLine = readFixture("codex_file_change_approval_request.jsonl");
    const events = normalizeProviderEvent(outputEvent(`${fixtureLine}\n`), { provider: "codex" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "approval.requested",
      message: "Apply file changes",
      payload: {
        command: "Apply file changes",
        reason: "Apply generated patch",
        riskLevel: "high"
      }
    });
  });

  it("ignores non-approval events (no false positives)", () => {
    const events = normalizeProviderEvent(
      outputEvent('{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}\n'),
      { provider: "codex" }
    );
    expect(events.some((event) => event.type === "approval.requested")).toBe(false);
  });
});

function readFixture(name: string): string {
  const here = fileURLToPath(new URL(".", import.meta.url));
  return readFileSync(`${here}/__fixtures__/${name}`, "utf8").trim();
}

function outputEvent(message: string, stream: ProviderEvent["stream"] = "stdout"): ProviderEvent {
  return {
    sessionId: "session-1",
    type: "output",
    stream,
    message,
    createdAt: "2026-05-08T16:00:00.000Z"
  };
}

describe("normalizeProviderEventWithUsage — Claude usage extraction", () => {
  const claudeAssistantWithUsage =
    JSON.stringify({
      type: "assistant",
      message: {
        id: "msg-1",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "Hello." }],
        usage: {
          input_tokens: 100,
          output_tokens: 40,
          cache_read_input_tokens: 500,
          cache_creation_input_tokens: 200
        }
      }
    }) + "\n";

  it("extracts usage from a Claude assistant event", () => {
    const result = normalizeProviderEventWithUsage(outputEvent(claudeAssistantWithUsage), {
      provider: "claude"
    });
    expect(result.usages).toHaveLength(1);
    expect(result.usages[0]).toMatchObject({
      modelId: "claude-sonnet-4-6",
      tokens: { input: 100, output: 40, cacheRead: 500, cacheWrite: 200 },
      eventId: "msg-1"
    });
    // 100*3/M + 40*15/M + 500*0.3/M + 200*3.75/M
    // = 0.0003 + 0.0006 + 0.00015 + 0.00075 = 0.0018
    expect(result.usages[0]?.costUsd).toBeCloseTo(0.0018, 9);
  });

  it("emits a visible message event alongside the usage", () => {
    const result = normalizeProviderEventWithUsage(outputEvent(claudeAssistantWithUsage), {
      provider: "claude"
    });
    expect(result.events.some((e) => e.message === "Hello.")).toBe(true);
  });

  it("ignores Claude assistant events with zero usage totals", () => {
    const line =
      JSON.stringify({
        type: "assistant",
        message: {
          id: "m9",
          model: "claude-sonnet-4-6",
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0
          }
        }
      }) + "\n";
    const result = normalizeProviderEventWithUsage(outputEvent(line), { provider: "claude" });
    expect(result.usages).toEqual([]);
  });
});

describe("normalizeProviderEventWithUsage — Codex usage extraction", () => {
  const turnContextLine =
    JSON.stringify({
      timestamp: "2026-04-20T12:49:05.000Z",
      type: "turn_context",
      payload: { model: "gpt-5.4", cwd: "/repo" }
    }) + "\n";
  const tokenCountLine =
    JSON.stringify({
      timestamp: "2026-04-20T12:49:10.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 200,
            cached_input_tokens: 50,
            output_tokens: 60,
            reasoning_output_tokens: 10,
            total_tokens: 320
          }
        }
      }
    }) + "\n";

  it("threads the model id forward from a prior turn_context", () => {
    const context = createNormalizerSessionContext();
    normalizeProviderEventWithUsage(outputEvent(turnContextLine), { provider: "codex", context });
    expect(context.codexCurrentModel).toBe("gpt-5.4");

    const result = normalizeProviderEventWithUsage(outputEvent(tokenCountLine), {
      provider: "codex",
      context
    });
    expect(result.usages).toHaveLength(1);
    expect(result.usages[0]).toMatchObject({
      modelId: "gpt-5.4",
      // 200 - 50 cached = 150 non-cached input
      tokens: { input: 150, output: 60, cacheRead: 50, cacheWrite: 0 }
    });
  });

  it("uses 'unknown' when no prior turn_context has been seen", () => {
    const context = createNormalizerSessionContext();
    const result = normalizeProviderEventWithUsage(outputEvent(tokenCountLine), {
      provider: "codex",
      context
    });
    expect(result.usages).toHaveLength(1);
    expect(result.usages[0]?.modelId).toBe("unknown");
    expect(result.usages[0]?.costUsd).toBe(0);
  });

  it("ignores Codex token_count rows with zero totals", () => {
    const context = createNormalizerSessionContext();
    context.codexCurrentModel = "gpt-5.4";
    const zero =
      JSON.stringify({
        timestamp: "2026-04-20T12:49:10.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 0,
              output_tokens: 0,
              cached_input_tokens: 0,
              reasoning_output_tokens: 0
            }
          }
        }
      }) + "\n";
    const result = normalizeProviderEventWithUsage(outputEvent(zero), {
      provider: "codex",
      context
    });
    expect(result.usages).toEqual([]);
  });
});
