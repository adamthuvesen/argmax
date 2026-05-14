// @vitest-environment node
import { describe, expect, it } from "vitest";
import { extractProviderConversationId } from "./sessionPayloadCaps.js";

describe("extractProviderConversationId", () => {
  it("skips oversized JSON-like lines before parsing (audit-2026-05-14 M8)", () => {
    const hugeLine = `{"type":"thread.started","thread_id":"${"x".repeat(70_000)}"}`;
    const validLine = '{"type":"thread.started","thread_id":"thread-123"}';

    expect(extractProviderConversationId(`${hugeLine}\n${validLine}`, "codex")).toBe("thread-123");
  });
});
