import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Highlighter from "./highlighter.js";

// The main-thread fallback's Shiki: marks every token so a test can tell
// which path produced it.
vi.mock("./shikiCore.js", () => ({
  createArgmaxHighlighter: () =>
    Promise.resolve({
      codeToTokens: (code: string) => ({
        tokens: code.split("\n").map((line) => [{ content: `main:${line}`, color: "#111111" }]),
        grammarState: undefined,
      }),
    }),
}));

class FakeWorker extends EventTarget {
  static instances: FakeWorker[] = [];
  posted: unknown[] = [];
  terminated = false;
  constructor() {
    super();
    FakeWorker.instances.push(this);
  }
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
  failToLoad(): void {
    const event = new Event("error") as Event & { message: string };
    event.message = "module workers unsupported";
    this.dispatchEvent(event);
  }
}

async function loadHighlighter(): Promise<typeof Highlighter> {
  vi.resetModules();
  return import("./highlighter.js");
}

describe("requestHighlight", () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("tokenizes in the worker and caches a settled fence", async () => {
    const { peekHighlightedCode, requestHighlight } = await loadHighlighter();
    const done = vi.fn();
    requestHighlight("const x = 1;", "typescript", "dark", done);
    const worker = FakeWorker.instances[0];
    expect(worker.posted).toEqual([
      { type: "tokenize", id: 1, code: "const x = 1;", lang: "typescript", theme: "vitesse-dark" },
    ]);
    const lines = [[{ content: "const x = 1;", color: "#4d9375" }]];
    worker.reply({ type: "tokens", id: 1, lines });
    expect(done).toHaveBeenCalledWith(lines);
    expect(peekHighlightedCode("const x = 1;", "typescript", "dark")).toEqual(lines);
  });

  it("drops a cancelled request and tells the worker", async () => {
    const { requestHighlight } = await loadHighlighter();
    const done = vi.fn();
    const cancel = requestHighlight("a", "typescript", "light", done);
    const worker = FakeWorker.instances[0];
    cancel();
    expect(worker.posted.at(-1)).toEqual({ type: "cancel", id: 1 });
    worker.reply({ type: "tokens", id: 1, lines: [[{ content: "a" }]] });
    expect(done).not.toHaveBeenCalled();
  });

  it("finishes on the main thread when the worker cannot load", async () => {
    const { requestHighlight } = await loadHighlighter();
    const pending = vi.fn();
    const cancelled = vi.fn();
    requestHighlight("one", "typescript", "light", pending);
    const cancel = requestHighlight("two", "typescript", "light", cancelled);
    const worker = FakeWorker.instances[0];
    worker.failToLoad();
    cancel();
    expect(worker.terminated).toBe(true);

    await vi.waitFor(() =>
      expect(pending).toHaveBeenCalledWith([[{ content: "main:one", color: "#111111" }]]),
    );
    // Later requests skip the dead worker, and a cancel still holds after the move.
    const later = vi.fn();
    requestHighlight("three", "typescript", "light", later);
    await vi.waitFor(() => expect(later).toHaveBeenCalled());
    expect(FakeWorker.instances).toHaveLength(1);
    expect(cancelled).not.toHaveBeenCalled();
  });
});
