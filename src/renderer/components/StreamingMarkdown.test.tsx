import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getBrowserRequest, subscribeBrowserRequest } from "../lib/browserPanel.js";
import { LINK_TARGET_KEY } from "../lib/linkTarget.js";
import type * as MermaidRuntime from "../lib/mermaidRuntime.js";
import { ATTACHMENT_PROTOCOL_SCHEME } from "../../shared/attachmentProtocol.js";
import { WORKSPACE_ASSET_PROTOCOL_SCHEME } from "../../shared/assetProtocol.js";
import { FRESH_RUN_FADE_MS } from "../lib/streamFreshRuns.js";
import { resetDrawnMermaidDiagramsForTests } from "../lib/mermaidRuntime.js";
import { StreamingMarkdown } from "./StreamingMarkdown.js";

const FRAME_MS = 16;

const renderMermaidDiagram = vi.hoisted(() =>
  vi.fn(() => Promise.resolve({ svg: `<svg data-testid="mermaid-svg"><title>flow</title></svg>` }))
);

vi.mock("../lib/mermaidRuntime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof MermaidRuntime>();
  return {
    ...actual,
    renderMermaidDiagram
  };
});

// Installing the real bridge at import time would arm a WebSocket; the flag is
// all this component reads from it.
const remote = vi.hoisted(() => ({ bridge: false }));
vi.mock("../lib/tauriBridge.js", () => ({
  isRemoteBridge: () => remote.bridge
}));

afterEach(() => {
  resetDrawnMermaidDiagramsForTests();
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  remote.bridge = false;
  window.localStorage.removeItem(LINK_TARGET_KEY);
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
});

describe("<StreamingMarkdown />", () => {
  const workspace = {
    id: "workspace-1",
    path: "/Users/me/repo"
  } as Parameters<typeof StreamingMarkdown>[0]["workspace"];

  it("preserves code scroll elements across workspace and callback updates", () => {
    const text = "```\nlong output\n```";
    const { rerender } = render(
      <StreamingMarkdown text={text} streaming={false} workspace={workspace} />
    );
    const code = screen.getByText("long output");
    const pre = code.closest("pre")!;
    pre.scrollLeft = 120;

    rerender(
      <StreamingMarkdown text={text} streaming={false} workspace={{ ...workspace! }} onOpenFile={vi.fn()} />
    );

    expect(screen.getByText("long output").closest("pre")).toBe(pre);
    expect(pre.scrollLeft).toBe(120);
  });

  it("uses the latest file callback without replacing the link", () => {
    const text = "Open [the app](src/renderer/App.tsx).";
    const previous = vi.fn();
    const current = vi.fn();
    const { rerender } = render(
      <StreamingMarkdown text={text} streaming={false} workspace={workspace} onOpenFile={previous} />
    );
    const link = screen.getByRole("button", { name: "Open src/renderer/App.tsx" });
    rerender(
      <StreamingMarkdown text={text} streaming={false} workspace={workspace} onOpenFile={current} />
    );
    expect(screen.getByRole("button", { name: "Open src/renderer/App.tsx" })).toBe(link);
    fireEvent.click(link);
    expect(previous).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledWith("src/renderer/App.tsx", { line: null, preferIde: false });
  });

  it.each([
    ["/Users/adamthuvesen/dev/menti/dbt-transform-remove-pqa", "/Users/adamthuvesen/dev/menti/dbt-transform-remove-pqa", undefined],
    ["docs/", "docs/", "/Users/me/repo"],
    ["LICENSE", "LICENSE", "/Users/me/repo"],
    ["/tmp/my%20worktree", "/tmp/my worktree", undefined]
  ])("opens local link %s without navigating the app", (href, expectedPath, cwd) => {
    const openPath = vi.fn().mockResolvedValue({ ok: true });
    (window as unknown as { argmax: unknown }).argmax = { system: { openPath } };
    const onOpenFile = vi.fn();
    render(
      <StreamingMarkdown
        text={`Open [its own worktree](${href}).`}
        streaming={false}
        workspace={workspace}
        onOpenFile={onOpenFile}
      />
    );
    const link = screen.getByRole("link", { name: "its own worktree" });
    expect(fireEvent.click(link)).toBe(false);
    expect(openPath).toHaveBeenCalledWith({ path: expectedPath, cwd });
    expect(fireEvent.click(link, { ctrlKey: true })).toBe(false);
    expect(openPath).toHaveBeenCalledTimes(2);
    expect(onOpenFile).not.toHaveBeenCalled();
    delete (window as { argmax?: unknown }).argmax;
  });

  it("renders workspace and managed attachment images through guarded protocols", () => {
    const { container } = render(
      <StreamingMarkdown
        text={[
          "![workspace](scratch/lane.png)",
          "![attachment](</Users/me/Library/Application Support/com.argmax.rs/local-state/attachments/s/shot.png>)"
        ].join("\n\n")}
        streaming={false}
        workspace={workspace}
      />
    );

    const sources = Array.from(container.querySelectorAll("img")).map((image) => image.src);
    expect(sources.some((source) => source.startsWith(`${WORKSPACE_ASSET_PROTOCOL_SCHEME}://`))).toBe(true);
    expect(sources.some((source) => source.startsWith(`${ATTACHMENT_PROTOCOL_SCHEME}://`))).toBe(true);
  });

  it("preserves an explicit managed attachment URL for image rendering", () => {
    const source = `${ATTACHMENT_PROTOCOL_SCHEME}://file/attachments/session/shot.png`;
    render(<StreamingMarkdown text={`![attachment](${source})`} streaming={false} workspace={workspace} />);

    expect(screen.getByRole("img", { name: "attachment" })).toHaveAttribute("src", source);
  });

  it("keeps unsafe URL schemes stripped while allowing managed images", () => {
    render(
      <StreamingMarkdown
        text="[bad](javascript:alert(1)) ![bad image](javascript:alert(1))"
        streaming={false}
        workspace={workspace}
      />
    );

    expect(screen.getByText("bad").closest("a")).toHaveAttribute("href", "");
    expect(screen.queryByRole("img", { name: "bad image" })).not.toBeInTheDocument();
  });

  it("falls back to a file chip when a local image cannot load", () => {
    render(
      <StreamingMarkdown
        text="![lane](/tmp/lane.png)"
        streaming={false}
        workspace={workspace}
      />
    );

    fireEvent.error(screen.getByRole("img", { name: "lane" }));
    expect(screen.getByRole("button", { name: "Open /tmp/lane.png" })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "lane" })).not.toBeInTheDocument();
  });

  it("draws a remote image as a link instead of fetching it", () => {
    const { container } = render(
      <StreamingMarkdown
        text="![chart](https://tracker.example.com/p.png?secret=abc)"
        streaming={false}
        workspace={workspace}
      />
    );

    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("link", { name: "tracker.example.com" })).toHaveAttribute(
      "href",
      "https://tracker.example.com/p.png?secret=abc"
    );
  });

  it("normalizes absolute workspace file links before opening them", () => {
    const onOpenFile = vi.fn();
    render(
      <StreamingMarkdown
        text="Open [the app](/Users/me/repo/src/renderer/App.tsx)."
        streaming={false}
        workspace={workspace}
        onOpenFile={onOpenFile}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Open src/renderer/App.tsx" }));
    expect(onOpenFile).toHaveBeenCalledWith("src/renderer/App.tsx", {
      line: null,
      preferIde: false
    });
  });

  it("writes a streaming block out word by word over successive frames", () => {
    vi.useFakeTimers();
    const text = "word ".repeat(60).trim();

    const { container } = render(<StreamingMarkdown text={text} streaming />);
    const markdown = container.querySelector(".markdown");
    expect(markdown?.textContent).toBe("");

    const seen: string[] = [];
    for (let frame = 0; frame < 20; frame += 1) {
      act(() => {
        vi.advanceTimersByTime(FRAME_MS);
      });
      seen.push(markdown?.textContent ?? "");
    }
    // It grows a little every few frames, never shrinks, and never shows half
    // a word.
    expect(new Set(seen).size).toBeGreaterThan(5);
    for (const [index, prefix] of seen.entries()) {
      expect(text.startsWith(prefix)).toBe(true);
      if (index > 0) expect(prefix.length).toBeGreaterThanOrEqual(seen[index - 1].length);
      if (prefix) expect(prefix.endsWith("word")).toBe(true);
    }
    expect(seen.at(-1)!.length).toBeLessThan(text.length);

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    act(() => {
      vi.advanceTimersByTime(FRESH_RUN_FADE_MS + 100);
    });
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it("keeps a quarter second of arrived text in hand while delivery keeps up", () => {
    // Deltas arrive every 50 ms at ~400 characters a second, like a Claude
    // answer. The reveal should trail delivery by about REVEAL_LAG_S, not by
    // the whole backlog.
    vi.useFakeTimers();
    const words = Array.from({ length: 400 }, (_, index) => `w${index % 10}`);
    let text = "";
    const { container, rerender } = render(<StreamingMarkdown text={text} streaming />);
    const markdown = container.querySelector(".markdown");
    for (let tick = 0; tick < 40; tick += 1) {
      text = words.slice(0, (tick + 1) * 7).join(" ");
      rerender(<StreamingMarkdown text={text} streaming />);
      act(() => {
        vi.advanceTimersByTime(50);
      });
    }
    const shown = markdown?.textContent?.length ?? 0;
    const behind = text.length - shown;
    // ~420 characters a second, so a quarter second is ~105 characters.
    expect(behind).toBeGreaterThan(20);
    expect(behind).toBeLessThan(260);
  });

  it("marks what each frame reveals so it fades up, and settles once it has", () => {
    vi.useFakeTimers();
    const text = "fade ".repeat(80).trim();

    const { container } = render(<StreamingMarkdown text={text} streaming />);
    act(() => {
      vi.advanceTimersByTime(FRAME_MS * 3);
    });

    const runs = [...container.querySelectorAll(".stream-fresh")];
    // Reveals within one merge window share a run: a handful of fading spans,
    // not one per frame.
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.length).toBeLessThanOrEqual(2);
    // Each run carries when it was revealed: the fade is anchored to that, not
    // to the span, which changes hands as the markdown is re-parsed.
    expect(Number(runs[0]?.getAttribute("data-at"))).toBeGreaterThan(0);

    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    act(() => {
      vi.advanceTimersByTime(FRESH_RUN_FADE_MS + 100);
    });
    expect(container.querySelectorAll(".stream-fresh")).toHaveLength(0);
  });

  it("leaves an unpaced block — a live thought — unmarked", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <StreamingMarkdown text={"A".repeat(120)} streaming paced={false} />
    );
    rerender(<StreamingMarkdown text={"A".repeat(240)} streaming paced={false} />);
    act(() => {
      vi.advanceTimersByTime(FRAME_MS * 4);
    });
    expect(container.querySelectorAll(".stream-fresh")).toHaveLength(0);
  });

  it("does not mark a block that is being restored into the pane", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <StreamingMarkdown text={"A".repeat(120)} streaming restoring />
    );
    rerender(<StreamingMarkdown text={"A".repeat(240)} streaming restoring />);
    act(() => {
      vi.advanceTimersByTime(FRAME_MS * 4);
    });
    expect(container.querySelectorAll(".stream-fresh")).toHaveLength(0);
  });

  it("drives every revealing block from one shared animation frame", () => {
    vi.useFakeTimers();
    const requestSpy = vi.spyOn(window, "requestAnimationFrame");
    const cancelSpy = vi.spyOn(window, "cancelAnimationFrame");

    const first = render(<StreamingMarkdown text={"a ".repeat(120)} streaming />);
    const second = render(<StreamingMarkdown text={"b ".repeat(120)} streaming />);
    expect(requestSpy).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(FRAME_MS * 4);
    });
    // One request per frame for both blocks.
    expect(requestSpy.mock.calls.length).toBeLessThanOrEqual(6);
    expect(first.container.querySelector(".markdown")?.textContent).not.toBe("");
    expect(second.container.querySelector(".markdown")?.textContent).not.toBe("");

    // The loop outlives one block and stops with the last.
    first.unmount();
    expect(cancelSpy).not.toHaveBeenCalled();
    second.unmount();
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });

  it("never cuts a surrogate pair through stream growth and completion", () => {
    vi.useFakeTimers();
    const first = "😀".repeat(120);
    const grown = `${first}${"🧠".repeat(80)}`;

    const { container, rerender } = render(<StreamingMarkdown text={first} streaming />);
    const markdown = container.querySelector(".markdown");
    const wellFormed = (): boolean => {
      const value = markdown?.textContent ?? "";
      return value.length % 2 === 0 && [...value].every((char) => char === "😀" || char === "🧠");
    };
    for (let frame = 0; frame < 10; frame += 1) {
      act(() => {
        vi.advanceTimersByTime(FRAME_MS);
      });
      expect(wellFormed()).toBe(true);
    }
    rerender(<StreamingMarkdown text={grown} streaming />);
    for (let frame = 0; frame < 10; frame += 1) {
      act(() => {
        vi.advanceTimersByTime(FRAME_MS);
      });
      expect(wellFormed()).toBe(true);
    }
    rerender(<StreamingMarkdown text={grown} streaming={false} />);
    expect(wellFormed()).toBe(true);
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(markdown?.textContent).toBe(grown);
  });

  it("sweeps a large arriving block in within a bounded window instead of crawling", () => {
    // Codex and OpenCode land the whole answer as one completed message.
    vi.useFakeTimers();
    const text = "sweep ".repeat(400).trim();

    const { container } = render(<StreamingMarkdown text={text} streaming />);
    const markdown = container.querySelector(".markdown");
    expect(markdown?.textContent).toBe("");

    act(() => {
      vi.advanceTimersByTime(300);
    });
    const partial = markdown?.textContent?.length ?? 0;
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(text.length);

    act(() => {
      vi.advanceTimersByTime(1_300);
    });
    expect(markdown?.textContent).toBe(text);
  });

  it("finishes writing out the remainder when the stream ends instead of dumping it", () => {
    vi.useFakeTimers();
    const text = "tail ".repeat(160).trim();

    const { container, rerender } = render(<StreamingMarkdown text={text} streaming />);
    const markdown = container.querySelector(".markdown");
    act(() => {
      vi.advanceTimersByTime(FRAME_MS * 6);
    });
    const before = markdown?.textContent?.length ?? 0;
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThan(text.length);

    // The session state flipped to complete with most of the block unrevealed.
    rerender(<StreamingMarkdown text={text} streaming={false} />);
    expect(markdown?.textContent?.length).toBe(before);

    act(() => {
      vi.advanceTimersByTime(FRAME_MS);
    });
    // The remainder keeps writing: never a snap.
    const next = markdown?.textContent?.length ?? 0;
    expect(next).toBeGreaterThanOrEqual(before);
    expect(next).toBeLessThan(text.length);

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(markdown?.textContent).toBe(text);
  });

  it("shows an unpaced streaming block in full as it arrives", () => {
    // `paced={false}` keeps the committed/tail split of a streaming block but
    // drops the typewriter: the Thought block uses it so a reasoning burst
    // neither trails the cadence nor re-parses the whole buffer per delta.
    vi.useFakeTimers();
    const text = "B".repeat(120);

    const { container } = render(<StreamingMarkdown text={text} streaming paced={false} />);

    expect(container.querySelector(".markdown")?.textContent).toBe(text);
    vi.useRealTimers();
  });

  it("keeps completed blocks formatted while a later block is still streaming", () => {
    vi.useFakeTimers();
    // A finished heading, then a paragraph still being typed. The committed
    // prefix ("# Title\n\n") must render as a real heading even before the
    // trailing paragraph finishes.
    const text = "# Title\n\nStreaming the rest of the answer now, one chunk at a time.";

    render(<StreamingMarkdown text={text} streaming />);

    act(() => {
      // Reveal past the heading and into the paragraph, but not to the end.
      vi.advanceTimersByTime(FRAME_MS * 30);
    });

    expect(screen.getByRole("heading", { name: "Title" })).toBeInTheDocument();
  });

  it.each(["```", "~~~", "````not-a-close", "    ````", "\t````"])(
    "keeps %s inside a longer code fence while streaming",
    (innerFence) => {
      const text = ["````markdown", innerFence, "", "# This is code", "", "Still code"].join("\n");
      render(<StreamingMarkdown text={text} streaming paced={false} />);

      expect(screen.queryByRole("heading", { name: "This is code" })).not.toBeInTheDocument();
      expect(screen.getAllByRole("button", { name: "Copy code" })).toHaveLength(1);
      expect(screen.getByText("Still code").closest("code")).not.toBeNull();
    }
  );

  it("resumes where it left off when the pane remounts mid-stream", () => {
    vi.useFakeTimers();
    const text = "resume ".repeat(40).trim();

    const first = render(<StreamingMarkdown text={text} streaming revealKey="session-a:t0:g0" />);
    act(() => {
      vi.advanceTimersByTime(FRAME_MS * 6);
    });
    const shown = first.container.querySelector(".markdown")?.textContent ?? "";
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(text.length);
    // Switching to another session unmounts the pane; coming back mounts a new one.
    first.unmount();

    const second = render(<StreamingMarkdown text={text} streaming revealKey="session-a:t0:g0" />);
    expect(second.container.querySelector(".markdown")?.textContent).toBe(shown);
  });

  it("types out a block it has never revealed before", () => {
    vi.useFakeTimers();
    const text = "D".repeat(120);

    const { container } = render(
      <StreamingMarkdown text={text} streaming revealKey="session-a:t0:unseen" />
    );

    expect(container.querySelector(".markdown")?.textContent).toBe("");
  });

  it("shows already-arrived text in full when the pane is restoring", () => {
    const text = "R".repeat(120);

    const { container } = render(
      <StreamingMarkdown text={text} streaming restoring revealKey="session-restore:g0" />
    );

    expect(container.querySelector(".markdown")?.textContent).toBe(text);
  });

  it("does not restart the reveal when restore ends", () => {
    vi.useFakeTimers();
    const text = "S".repeat(120);

    const { container, rerender } = render(
      <StreamingMarkdown text={text} streaming restoring revealKey="session-restore:g1" />
    );
    expect(container.querySelector(".markdown")?.textContent).toBe(text);

    rerender(
      <StreamingMarkdown text={text} streaming restoring={false} revealKey="session-restore:g1" />
    );
    expect(container.querySelector(".markdown")?.textContent).toBe(text);
    act(() => {
      vi.advanceTimersByTime(FRAME_MS * 16);
    });
    expect(container.querySelector(".markdown")?.textContent).toBe(text);
  });

  it("shows a streaming block in full when it mounts while the document is hidden", () => {
    vi.useFakeTimers();
    const text = "H".repeat(120);
    Object.defineProperty(document, "hidden", { configurable: true, value: true });

    const { container } = render(
      <StreamingMarkdown text={text} streaming revealKey="session-hidden:g0" />
    );

    expect(container.querySelector(".markdown")?.textContent).toBe(text);

    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    act(() => {
      vi.advanceTimersByTime(FRAME_MS * 16);
    });
    expect(container.querySelector(".markdown")?.textContent).toBe(text);
  });

  it("catches up a live block that grew while the document was hidden", () => {
    vi.useFakeTimers();
    const first = "hidden ".repeat(20).trim();
    const { container, rerender } = render(
      <StreamingMarkdown text={first} streaming revealKey="session-hidden:g1" />
    );
    expect(container.querySelector(".markdown")?.textContent).toBe("");

    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    act(() => {
      vi.advanceTimersByTime(FRAME_MS);
    });
    expect(container.querySelector(".markdown")?.textContent).toBe(first);

    const grown = `${first} ${"more ".repeat(20).trim()}`;
    rerender(<StreamingMarkdown text={grown} streaming revealKey="session-hidden:g1" />);
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    act(() => {
      vi.advanceTimersByTime(FRAME_MS * 2);
    });
    // Already-arrived text stays; only the growth after becoming visible writes.
    const shown = container.querySelector(".markdown")?.textContent ?? "";
    expect(shown.startsWith(first)).toBe(true);
    expect(shown.length).toBeLessThan(grown.length);
  });

  it("boxes a table in its own sideways scroller", () => {
    // A bare table grows past the column and hands the overflow to the
    // transcript's scroller, so the whole conversation slides sideways.
    const table = ["| a | b |", "| - | - |", "| 1 | 2 |"].join("\n");

    const { container } = render(<StreamingMarkdown text={table} streaming={false} />);

    const scroller = container.querySelector(".markdown > .markdown-table-scroll");
    expect(scroller?.firstElementChild?.tagName).toBe("TABLE");
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("keeps reference link definitions in the same streaming markdown document", () => {
    render(
      <StreamingMarkdown
        text={["Read [the documentation][docs].", "", "[docs]: https://example.com/docs"].join("\n")}
        streaming
        paced={false}
      />
    );

    expect(screen.getByRole("link", { name: "the documentation" })).toHaveAttribute(
      "href",
      "https://example.com/docs"
    );
  });

  it("preserves loose and nested list structure while streaming", () => {
    render(
      <StreamingMarkdown
        text={[
          "- outer item",
          "",
          "  continuation paragraph",
          "  - nested item",
          "",
          "    > nested quote"
        ].join("\n")}
        streaming
        paced={false}
      />
    );

    expect(screen.getAllByRole("list")).toHaveLength(2);
    expect(screen.getByText("continuation paragraph")).toBeInTheDocument();
    expect(screen.getByRole("blockquote")).toHaveTextContent("nested quote");
  });

  it("keeps the code node stable when a stream becomes completed", () => {
    const text = ["```ts", "const answer = 42;", "```"].join("\n");
    const { container, rerender } = render(
      <StreamingMarkdown text={text} streaming paced={false} />
    );
    const code = container.querySelector("code");
    expect(code).toBeInTheDocument();

    rerender(<StreamingMarkdown text={text} streaming={false} paced={false} />);

    expect(container.querySelector("code")).toBe(code);
  });

  it.each([
    ["https://example.com/docs", "https://example.com/docs"],
    ["HTTPS://example.com/docs", "HTTPS://example.com/docs"],
    ["//example.com/docs", "https://example.com/docs"]
  ])("routes web link %s through the configured browser", (href, expectedUrl) => {
    const openPath = vi.fn().mockResolvedValue({ ok: true });
    (window as unknown as { argmax: unknown }).argmax = { system: { openPath } };
    const opened: string[] = [];
    const unsubscribe = subscribeBrowserRequest(() => {
      const request = getBrowserRequest();
      if (request) opened.push(request.url);
    });

    render(<StreamingMarkdown text={`See [docs](${href}).`} streaming={false} />);
    const link = screen.getByRole("link", { name: "docs" });
    expect(link).toHaveAttribute("target", "_blank");

    // Plain click routes through system:open-path — the Tauri webview
    // swallows target="_blank", so the handler must open explicitly.
    fireEvent.click(link);
    expect(openPath).toHaveBeenCalledWith({ path: expectedUrl });
    expect(opened).toHaveLength(0);

    fireEvent.click(link, { metaKey: true });
    expect(opened).toEqual([expectedUrl]);
    expect(openPath).toHaveBeenCalledTimes(1);
    unsubscribe();
    delete (window as { argmax?: unknown }).argmax;
  });

  it("leaves web links to the browser on the remote bridge", () => {
    remote.bridge = true;
    const openPath = vi.fn().mockResolvedValue({ ok: true });
    (window as unknown as { argmax: unknown }).argmax = { system: { openPath } };
    const opened: string[] = [];
    const unsubscribe = subscribeBrowserRequest(() => {
      const request = getBrowserRequest();
      if (request) opened.push(request.url);
    });

    render(<StreamingMarkdown text="See [docs](https://example.com/docs)." streaming={false} />);
    const link = screen.getByRole("link", { name: "docs" });
    const clicked = fireEvent.click(link);

    // Both desktop routes would open the link on the host, so the phone gets
    // the anchor's own navigation: nothing intercepted, default not prevented.
    expect(openPath).not.toHaveBeenCalled();
    expect(opened).toHaveLength(0);
    expect(clicked).toBe(true);
    unsubscribe();
    delete (window as { argmax?: unknown }).argmax;
  });

  it("opens web links in the pane when the link target preference is argmax", () => {
    window.localStorage.setItem(LINK_TARGET_KEY, "argmax");
    const opened: string[] = [];
    const unsubscribe = subscribeBrowserRequest(() => {
      const request = getBrowserRequest();
      if (request) opened.push(request.url);
    });

    render(<StreamingMarkdown text="See [docs](https://example.com/docs)." streaming={false} />);
    const link = screen.getByRole("link", { name: "docs" });

    fireEvent.click(link);
    expect(opened).toEqual(["https://example.com/docs"]);

    // ⌘-click flips back to the system browser.
    fireEvent.click(link, { metaKey: true });
    expect(opened).toHaveLength(1);
    unsubscribe();
  });

  it("does not smooth streaming text for reduced-motion users", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: true,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn()
    });
    const text = "B".repeat(120);

    render(<StreamingMarkdown text={text} streaming />);

    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it("renders LaTeX display equations from \\[ ... \\] and $$ ... $$ blocks", async () => {
    const text = [
      "Here is the abstention equation:",
      "\\[ \\text{margin} = P(\\text{best family}) - P(\\text{second-best family}) \\]",
      "And in double dollars:",
      "$$E = mc^2$$"
    ].join("\n\n");

    const { container } = render(<StreamingMarkdown text={text} streaming={false} />);

    // Math renders through the lazy KaTeX chunk (see MathMarkdown.tsx), so the
    // first paint is the plain fallback and the formatted equations land once
    // the chunk resolves.
    await waitFor(() => {
      expect(container.querySelectorAll(".katex-display").length).toBe(2);
    });
    const katexDisplays = container.querySelectorAll(".katex-display");
    expect(katexDisplays[0]?.textContent).toContain("margin");
    expect(katexDisplays[1]?.textContent).toContain("E=mc");
  });

  it.each([
    ["\\(\\tau\\) is the threshold and $x + y = z$ is the sum.", 2, "τ"],
    ["Price $50 ($2x + 1$ after adjustment).", 1, "$50"],
    ["Price $50 ($x$ after adjustment).", 1, "$50"]
  ])("renders inline equations alongside prose: %s", async (text, count, prose) => {
    const { container } = render(<StreamingMarkdown text={text} streaming={false} />);

    await waitFor(() => {
      expect(container.querySelectorAll(".katex").length).toBe(count);
    });
    expect(container.textContent).toContain(prose);
  });

  it("safely handles currency amounts without breaking into math mode", () => {
    const text = "Prices are $10 for standard and $20 for pro tier.";

    const { container } = render(<StreamingMarkdown text={text} streaming={false} />);

    expect(container.querySelectorAll(".katex").length).toBe(0);
    expect(container.textContent).toContain("$10");
    expect(container.textContent).toContain("$20");
  });

  it("renders per-unit prices and shell variables as prose, not equations", async () => {
    const text = [
      "Standard pricing is $1.25/1M in and $4.25/1M out, vs ~$5/$25 for Opus 5.",
      "Export $PATH and $HOME before running."
    ].join("\n\n");

    const { container } = render(<StreamingMarkdown text={text} streaming={false} />);

    await waitFor(() => {
      expect(container.textContent).toContain("$1.25/1M in and $4.25/1M out");
    });
    expect(container.querySelectorAll(".katex").length).toBe(0);
    expect(container.textContent).toContain("~$5/$25 for Opus 5");
    expect(container.textContent).toContain("Export $PATH and $HOME");
  });

  it("preserves code blocks containing dollar signs and LaTeX slashes", () => {
    const text = [
      "```bash",
      "PRICE=$50",
      "echo \"\\[ preserved \\]\"",
      "```"
    ].join("\n");

    const { container } = render(<StreamingMarkdown text={text} streaming={false} />);

    expect(container.querySelectorAll(".katex").length).toBe(0);
    expect(container.textContent).toContain("PRICE=$50");
    expect(container.textContent).toContain("\\[ preserved \\]");
  });

  it("lifts glued tracing logs out of assistant prose into an Error block", () => {
    const log = '2026-09-01T07:21:37.004170Z ERROR codex_core::session: stream disconnected session_id="abc"';
    const text = `After that PR-description correction, I would consider it ready for colleague review.\n${log}`;

    render(<StreamingMarkdown text={text} streaming={false} />);

    expect(
      screen.getByText("After that PR-description correction, I would consider it ready for colleague review.")
    ).toBeInTheDocument();
    const block = screen.getByRole("status", { name: "Error" });
    expect(block).toBeInTheDocument();
    expect(block.textContent).toContain("stream disconnected");
    expect(block.textContent).toContain('session_id="abc"');
  });

  it("strips MCP HTTP client teardown tracing from assistant prose", () => {
    const log =
      '2026-09-01T07:21:37.004170Z ERROR rmcp::transport::streamable_http_client: fail to delete session: invalid_refresh_token session_id="abc"';
    const text = `The other eight tasks were stable across both latest runs.\n${log}`;

    render(<StreamingMarkdown text={text} streaming={false} />);

    expect(screen.getByText("The other eight tasks were stable across both latest runs.")).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Error" })).not.toBeInTheDocument();
    expect(screen.queryByText(/invalid_refresh_token/)).not.toBeInTheDocument();
  });

  it("renders nothing when the dump is only MCP HTTP client tracing", () => {
    const log =
      '2026-09-01T07:21:37.004170Z ERROR rmcp::transport::streamable_http_client: fail to delete session: invalid_refresh_token session_id="abc"';
    const { container } = render(<StreamingMarkdown text={log} streaming={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a mermaid fence as a diagram instead of a labelled code block", async () => {
    const text = ["```mermaid", "flowchart LR", "  A --> B", "```"].join("\n");

    render(<StreamingMarkdown text={text} streaming={false} />);

    await waitFor(() => {
      expect(screen.getByTestId("mermaid-svg")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Diagram")).toBeInTheDocument();
    expect(screen.queryByText("mermaid")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy code" })).not.toBeInTheDocument();
    expect(renderMermaidDiagram).toHaveBeenCalledWith("flowchart LR\n  A --> B");
  });
});
