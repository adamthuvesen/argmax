import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getBrowserRequest, subscribeBrowserRequest } from "../lib/browserPanel.js";
import { LINK_TARGET_KEY } from "../lib/linkTarget.js";
import type * as MermaidRuntime from "../lib/mermaidRuntime.js";
import { ATTACHMENT_PROTOCOL_SCHEME } from "../../shared/attachmentProtocol.js";
import { WORKSPACE_ASSET_PROTOCOL_SCHEME } from "../../shared/assetProtocol.js";
import { StreamingMarkdown } from "./StreamingMarkdown.js";

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

  it("reveals large streaming chunks at a steady cadence", () => {
    vi.useFakeTimers();
    const text = "A".repeat(120);

    const { container } = render(<StreamingMarkdown text={text} streaming />);

    const markdown = container.querySelector(".markdown");
    expect(markdown?.textContent).toBe("");

    act(() => {
      vi.advanceTimersByTime(32);
    });
    expect(markdown?.textContent).toBe("A".repeat(5));

    act(() => {
      vi.advanceTimersByTime(32);
    });
    expect(markdown?.textContent).toBe("A".repeat(10));

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it("spreads a large arriving block over a bounded window instead of crawling", () => {
    // Codex and OpenCode land the whole answer as one completed message. At
    // the floor cadence a 2000-character answer took thirteen seconds, and the
    // session state flipped long before that, dumping the rest in one block.
    vi.useFakeTimers();
    const text = "E".repeat(2000);

    const { container } = render(<StreamingMarkdown text={text} streaming />);
    const markdown = container.querySelector(".markdown");
    expect(markdown?.textContent).toBe("");

    act(() => {
      vi.advanceTimersByTime(32);
    });
    // 2000 / 40 ticks = 50 per tick.
    expect(markdown?.textContent).toBe("E".repeat(50));

    act(() => {
      vi.advanceTimersByTime(32 * 39);
    });
    expect(markdown?.textContent).toBe(text);
  });

  it("finishes typing out the remainder when the stream ends instead of dumping it", () => {
    vi.useFakeTimers();
    const text = "F".repeat(400);

    const { container, rerender } = render(<StreamingMarkdown text={text} streaming />);
    const markdown = container.querySelector(".markdown");
    act(() => {
      vi.advanceTimersByTime(32 * 4);
    });
    // 400 / 40 = 10 per tick.
    expect(markdown?.textContent).toBe("F".repeat(40));

    // The session state flipped to complete with 360 characters unrevealed.
    rerender(<StreamingMarkdown text={text} streaming={false} />);
    expect(markdown?.textContent).toBe("F".repeat(40));

    act(() => {
      vi.advanceTimersByTime(32);
    });
    // The remainder keeps the pace it was streaming at: never a snap.
    expect(markdown?.textContent).toBe("F".repeat(50));

    act(() => {
      vi.advanceTimersByTime(32 * 35);
    });
    expect(markdown?.textContent).toBe(text);
  });

  it("finishes a burst that ended mid-reveal within the same bounded window", () => {
    // Cursor delivers an answer as a burst of deltas and ends the turn at once.
    vi.useFakeTimers();
    const first = "G".repeat(400);
    const text = "G".repeat(2000);

    const { container, rerender } = render(<StreamingMarkdown text={first} streaming />);
    const markdown = container.querySelector(".markdown");
    act(() => {
      vi.advanceTimersByTime(32 * 2);
    });
    // 400 / 40 = 10 per tick.
    expect(markdown?.textContent).toBe("G".repeat(20));

    rerender(<StreamingMarkdown text={text} streaming={false} />);
    act(() => {
      vi.advanceTimersByTime(32);
    });
    // 1980 / 40 = 50 per tick: faster than before, bounded to ~1.3 s.
    expect(markdown?.textContent).toBe("G".repeat(70));
    act(() => {
      vi.advanceTimersByTime(32 * 40);
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
      vi.advanceTimersByTime(32 * 6);
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
    const text = "C".repeat(120);

    const first = render(<StreamingMarkdown text={text} streaming revealKey="session-a:t0:g0" />);
    act(() => {
      vi.advanceTimersByTime(32 * 4);
    });
    expect(first.container.querySelector(".markdown")?.textContent).toBe("C".repeat(20));
    // Switching to another session unmounts the pane; coming back mounts a new one.
    first.unmount();

    const second = render(<StreamingMarkdown text={text} streaming revealKey="session-a:t0:g0" />);
    expect(second.container.querySelector(".markdown")?.textContent).toBe("C".repeat(20));
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
      vi.advanceTimersByTime(32 * 4);
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
      vi.advanceTimersByTime(32 * 4);
    });
    expect(container.querySelector(".markdown")?.textContent).toBe(text);
  });

  it("catches up a live block that grew while the document was hidden", () => {
    vi.useFakeTimers();
    const first = "H".repeat(120);
    const { container, rerender } = render(
      <StreamingMarkdown text={first} streaming revealKey="session-hidden:g1" />
    );
    expect(container.querySelector(".markdown")?.textContent).toBe("");

    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    act(() => {
      vi.advanceTimersByTime(32);
    });
    expect(container.querySelector(".markdown")?.textContent).toBe(first);

    rerender(
      <StreamingMarkdown text={"H".repeat(200)} streaming revealKey="session-hidden:g1" />
    );
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    act(() => {
      vi.advanceTimersByTime(32 * 4);
    });
    // Already-arrived text stays; only the growth after becoming visible types.
    expect(container.querySelector(".markdown")?.textContent).toBe("H".repeat(140));
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

  it("renders completed text immediately", () => {
    const text = "Completed answers should not be delayed.";

    render(<StreamingMarkdown text={text} streaming={false} />);

    expect(screen.getByText(text)).toBeInTheDocument();
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

  it("renders the exact markdown formula example from user query", async () => {
    const text = [
      "\\tau (\"tau\") is the abstention threshold. It controls how far ahead the model's best family must be from its second-best family before we emit a label.",
      "",
      "\\[ \\text{margin} = P(\\text{best family}) - P(\\text{second-best family}) \\]",
      "",
      "The probabilities are family-level, prior-matched probabilities. \\tau is not \"17.5% confidence\" or an accuracy estimate."
    ].join("\n");

    const { container } = render(<StreamingMarkdown text={text} streaming={false} />);

    await waitFor(() => {
      expect(container.querySelector(".katex-display")).toBeInTheDocument();
    });
    const displayMath = container.querySelector(".katex-display");
    expect(displayMath?.textContent).toContain("margin");
    expect(displayMath?.textContent).toContain("best family");
    expect(displayMath?.textContent).toContain("second-best family");

    // Both instances of \tau in prose should be rendered as KaTeX tau symbols
    expect(container.textContent).toContain("τ");
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
