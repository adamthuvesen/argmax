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
});

describe("<StreamingMarkdown />", () => {
  const workspace = {
    id: "workspace-1",
    path: "/Users/me/repo"
  } as Parameters<typeof StreamingMarkdown>[0]["workspace"];

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

  it("opens web links in the system browser by default, in the pane on ⌘-click", () => {
    const openPath = vi.fn().mockResolvedValue({ ok: true });
    (window as unknown as { argmax: unknown }).argmax = { system: { openPath } };
    const opened: string[] = [];
    const unsubscribe = subscribeBrowserRequest(() => {
      const request = getBrowserRequest();
      if (request) opened.push(request.url);
    });

    render(<StreamingMarkdown text="See [docs](https://example.com/docs)." streaming={false} />);
    const link = screen.getByRole("link", { name: "docs" });
    expect(link).toHaveAttribute("target", "_blank");

    // Plain click routes through system:open-path — the Tauri webview
    // swallows target="_blank", so the handler must open explicitly.
    fireEvent.click(link);
    expect(openPath).toHaveBeenCalledWith({ path: "https://example.com/docs" });
    expect(opened).toHaveLength(0);

    fireEvent.click(link, { metaKey: true });
    expect(opened).toEqual(["https://example.com/docs"]);
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

  it("renders LaTeX inline equations from \\( ... \\) and $ ... $ spans", async () => {
    const text = "\\(\\tau\\) is the threshold and $x + y = z$ is the sum.";

    const { container } = render(<StreamingMarkdown text={text} streaming={false} />);

    await waitFor(() => {
      expect(container.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(2);
    });
    expect(container.textContent).toContain("τ");
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
