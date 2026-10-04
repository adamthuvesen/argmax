import { describe, expect, expectTypeOf, it } from "vitest";
import type { BridgeTransport } from "./tauriBridge.js";
import type { HealthPingOutput } from "../../shared/bindings.js";
import { rawOutput, routine, pickedFolder, pendingMessage } from "./bridgeDecoders.js";
import type { PendingMessage, Routine } from "../../shared/bindings.js";

// This body is checked by tsc. It is not invoked with a live transport.
export function checkChannelTypes(transport: BridgeTransport) {
  const ping = transport.invoke("health:ping");
  expectTypeOf(ping).toEqualTypeOf<Promise<HealthPingOutput>>();
  // @ts-expect-error A session command requires its input.
  void transport.invoke("providers:terminate");
  // @ts-expect-error A channel fixes the input schema.
  void transport.invoke("providers:terminate", { workspaceId: "workspace" });
  // @ts-expect-error A channel fixes its response, not the caller.
  void transport.invoke<number>("health:ping");
  // @ts-expect-error A terminal exit subscription does not emit strings.
  transport.subscribe("terminal:exit", (payload: string) => payload);
}

describe("bridge contract boundaries", () => {
  it("rejects invalid stored enum values instead of claiming narrowed types", () => {
    const row = { provider: "unsupported" } as Routine;
    expect(() => routine(row)).toThrow("routine.provider");
    expect(() => rawOutput({ id: "r", sessionId: "s", content: "x", stream: "binary", createdAt: "now", rowCursor: null })).toThrow("output.stream");
  });
  it("keeps a queued follow-up's provider and reads a missing one as the chat's own", () => {
    const row: PendingMessage = {
      id: "m1", sessionId: "s1", content: "next", agentMode: "auto", fastMode: false,
      attachments: [], agentReferences: [], queuedAt: "now"
    };
    expect(pendingMessage({ ...row, provider: "codex" }).provider).toBe("codex");
    expect(pendingMessage({ ...row, provider: null }).provider).toBeUndefined();
    expect(pendingMessage(row).provider).toBeUndefined();
    expect(() => pendingMessage({ ...row, provider: "unsupported" as never })).toThrow("pendingMessage.provider");
  });
  it("requires a selected folder to carry a project", () => {
    expect(() => pickedFolder({ cancelled: false })).toThrow("no project");
    expect(pickedFolder({ cancelled: true })).toEqual({ cancelled: true });
  });
});
