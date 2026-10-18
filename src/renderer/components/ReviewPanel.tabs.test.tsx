import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reviewStub } from "../../test/reviewFixture.js";
import { createBrowserTab, resetBrowserTabsForTests } from "../lib/browserPanel.js";
import type * as TauriBridge from "../lib/tauriBridge.js";
import type { ReviewTab, ReviewTabsController } from "../lib/reviewTabs.js";
import type { ReviewSideChatContext, ReviewSideChatSession } from "./ReviewSideChat.js";
import { ReviewPanel } from "./ReviewPanel.js";

vi.mock("../lib/tauriBridge.js", async (importOriginal) => ({
  ...await importOriginal<typeof TauriBridge>(),
  hostsBrowserSurface: () => true
}));
vi.mock("./BrowserPanel.js", () => ({
  BrowserPanel: ({ controlledTabId }: { controlledTabId: string }) => <div role="region" aria-label={`Browser surface ${controlledTabId}`} />
}));
vi.mock("../lib/highlighter.js", () => ({
  tokenizeLines: () => null,
  useHighlighterReady: () => true,
  useHighlightThemeAppearance: () => "light",
  langFromPath: () => null
}));

function controller(items: ReviewTab[], paneTabIds: ReviewTabsController["paneTabIds"]): ReviewTabsController {
  return {
    items, paneTabIds, activeIndex: 0, select: vi.fn(), close: vi.fn(), move: vi.fn(), split: vi.fn(),
    reopenClosed: vi.fn(), canReopen: true, openTool: vi.fn(), openBrowser: vi.fn(), openTerminal: vi.fn(), openSideChat: vi.fn(),
    selectBrowserTab: vi.fn(), selectTerminalTab: vi.fn()
  };
}

function sideChatContext(): ReviewSideChatContext {
  return {
    launch: vi.fn().mockResolvedValue({ sessionId: "child", workspaceId: "scratch" }),
    sessionsById: new Map(), workspacesById: new Map(),
    onCancelQueuedMessage: vi.fn(), onClearSession: vi.fn(), onSendQueuedMessageNow: vi.fn(),
    onSendSessionInput: vi.fn(), onTerminateSession: vi.fn()
  };
}

function SideChatTabsHarness({ context }: { context: ReviewSideChatContext }) {
  const [activeId, setActiveId] = useState("tool:side-chat");
  const tabs = controller([
    { id: "tool:changes", kind: "tool", mode: "changes" },
    { id: "tool:side-chat", kind: "tool", mode: "side-chat" }
  ], [activeId]);
  tabs.select = setActiveId;
  const mode = activeId === "tool:changes" ? "changes" : "side-chat";
  return <ReviewPanel sideChat={context} review={reviewStub({
    tabs, mode, layout: { modes: [mode], activeIndex: 0, ratio: .5 }
  })} />;
}

afterEach(() => { cleanup(); resetBrowserTabsForTests(); });

describe("shared review tabs", () => {
  it("preserves the browser surface when expanding and restoring", () => {
    const browser = createBrowserTab("chat", "https://example.com");
    const tabs = controller([{ id: "browser", kind: "browser", browserTabId: browser.id }], ["browser"]);
    const review = reviewStub({ tabs, browserScopeId: "chat", mode: "browser", layout: { modes: ["browser"], activeIndex: 0, ratio: .5 } });
    function Harness() {
      const [expanded, setExpanded] = useState(false);
      return <ReviewPanel review={review} isExpanded={expanded} onToggleExpanded={() => setExpanded(!expanded)} />;
    }
    render(<Harness />);
    const surface = screen.getByRole("region", { name: `Browser surface ${browser.id}` });
    fireEvent.click(screen.getByRole("button", { name: "Expand panel" }));
    expect(screen.getByRole("button", { name: "Restore panel size" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("region", { name: `Browser surface ${browser.id}` })).toBe(surface);
    fireEvent.click(screen.getByRole("button", { name: "Restore panel size" }));
    expect(screen.getByRole("region", { name: `Browser surface ${browser.id}` })).toBe(surface);
  });

  it("renders two browser resources from the same scope with one shared strip", () => {
    const first = createBrowserTab("chat", "https://example.com/one");
    const second = createBrowserTab("chat", "https://example.com/two");
    const tabs = controller([
      { id: "one", kind: "browser", browserTabId: first.id },
      { id: "two", kind: "browser", browserTabId: second.id }
    ], ["one", "two"]);
    render(<ReviewPanel review={reviewStub({
      tabs, browserScopeId: "chat", browserOwner: false,
      layout: { modes: ["browser", "browser"], activeIndex: 0, ratio: .5 }, mode: "browser"
    })} />);
    expect(screen.getByRole("region", { name: `Browser surface ${first.id}` })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: `Browser surface ${second.id}` })).toBeInTheDocument();
    expect(screen.getAllByRole("tablist")).toHaveLength(1);
    expect(screen.getByRole("tablist", { name: "Workspace tabs" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close https://example.com/two" }));
    expect(tabs.close).toHaveBeenCalledWith("two");
  });

  it("keeps a dirty-file close prompt visible while Changes has focus", () => {
    const tabs = controller([{ id: "tool:changes", kind: "tool", mode: "changes" }], ["tool:changes"]);
    const base = reviewStub();
    const cancel = vi.fn();
    render(<ReviewPanel review={reviewStub({ tabs, workspaceFiles: {
      ...base.workspaceFiles,
      tabs: [{ path: "src/config.ts", isDirty: true, saveState: "idle", externalChange: false }],
      dirtyClosePrompt: { path: "src/config.ts", saveError: null },
      cancelDirtyTabClose: cancel
    } })} />);
    expect(screen.getByRole("alert", { name: "Unsaved changes in src/config.ts" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancel).toHaveBeenCalledOnce();
    expect(screen.queryByRole("tablist", { name: "Open files" })).not.toBeInTheDocument();
  });

  it("routes close and reopen shortcuts once through the shared controller", () => {
    const tabs = controller([{ id: "tool:changes", kind: "tool", mode: "changes" }], ["tool:changes"]);
    render(<ReviewPanel review={reviewStub({ tabs })} />);
    const tab = screen.getByRole("tab", { name: "Changes" });
    fireEvent.keyDown(tab, { key: "w", metaKey: true });
    expect(tabs.close).toHaveBeenCalledExactlyOnceWith("tool:changes");
    fireEvent.keyDown(tab, { key: "T", metaKey: true, shiftKey: true });
    expect(tabs.reopenClosed).toHaveBeenCalledOnce();
  });

  it("shows the new-tab tools and browser input without a file tree or suggestions", () => {
    const tabs = controller([{ id: "tool:new", kind: "tool", mode: "new" }], ["tool:new"]);
    render(<ReviewPanel sideChat={sideChatContext()} review={reviewStub({
      tabs, mode: "new", layout: { modes: ["new"], activeIndex: 0, ratio: .5 }
    })} />);
    expect(screen.getByRole("heading", { name: "Tools" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Suggested" })).not.toBeInTheDocument();
    expect(screen.queryByRole("separator", { name: "Resize file list width" })).not.toBeInTheDocument();
    expect(screen.queryByRole("contentinfo", { name: "File status" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Side chat" }));
    expect(tabs.openTool).toHaveBeenCalledWith("side-chat");
    fireEvent.change(screen.getByRole("textbox", { name: "Search or enter a URL" }), { target: { value: "example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Open address" }));
    expect(tabs.openBrowser).toHaveBeenCalledWith("https://example.com");
    fireEvent.keyDown(screen.getByRole("tab", { name: "New tab" }), { key: "t", metaKey: true });
    expect(tabs.openTool).toHaveBeenCalledWith("new");
  });

  it("attaches a launched side chat to its original form tab", async () => {
    const tabs = controller([{ id: "tool:side-chat", kind: "tool", mode: "side-chat" }], ["tool:side-chat"]);
    const sideChat = sideChatContext();
    render(<ReviewPanel sideChat={sideChat} review={reviewStub({
      tabs, mode: "side-chat", layout: { modes: ["side-chat"], activeIndex: 0, ratio: .5 }
    })} />);
    expect(sideChat.launch).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: "Side chat message" }), { target: { value: "Explore this idea" } });
    fireEvent.click(screen.getByRole("button", { name: "Start side chat" }));
    await waitFor(() => expect(tabs.openSideChat).toHaveBeenCalledWith("child", "scratch", "tool:side-chat"));
  });


  it("preserves an unsent side-chat draft across ordinary tab switches", () => {
    render(<SideChatTabsHarness context={sideChatContext()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Side chat message" }), { target: { value: "Keep this draft" } });
    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
    expect(screen.queryByRole("textbox", { name: "Side chat message" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Side chat" }));
    expect(screen.getByRole("textbox", { name: "Side chat message" })).toHaveValue("Keep this draft");
  });

  it("clears a form draft when its tab is removed", () => {
    const form: ReviewTab = { id: "tool:side-chat", kind: "tool", mode: "side-chat" };
    const changes: ReviewTab = { id: "tool:changes", kind: "tool", mode: "changes" };
    const sideChat = sideChatContext();
    const view = (open: boolean) => <ReviewPanel sideChat={sideChat} review={reviewStub({
      tabs: controller(open ? [changes, form] : [changes], [open ? form.id : changes.id]),
      mode: open ? "side-chat" : "changes",
      layout: { modes: [open ? "side-chat" : "changes"], activeIndex: 0, ratio: .5 }
    })} />;
    const { rerender } = render(view(true));
    fireEvent.change(screen.getByRole("textbox", { name: "Side chat message" }), { target: { value: "Discard this draft" } });
    rerender(view(false));
    rerender(view(true));
    expect(screen.getByRole("textbox", { name: "Side chat message" })).toHaveValue("");
  });


  it("preserves an in-flight launch and its error while switching tabs", async () => {
    const context = sideChatContext();
    let fail!: (error: Error) => void;
    context.launch = vi.fn(() => new Promise<ReviewSideChatSession>((_resolve, reject) => { fail = reject; }));
    render(<SideChatTabsHarness context={context} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Side chat message" }), { target: { value: "Keep my question" } });
    fireEvent.click(screen.getByRole("button", { name: "Start side chat" }));
    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
    fireEvent.click(screen.getByRole("tab", { name: "Side chat" }));
    expect(screen.getByRole("button", { name: "Start side chat" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("textbox", { name: "Side chat message" }).closest("form")!);
    expect(context.launch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
    await act(async () => {
      fail(new Error("Provider unavailable"));
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("tab", { name: "Side chat" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Provider unavailable");
    expect(screen.getByRole("textbox", { name: "Side chat message" })).toHaveValue("Keep my question");
    expect(screen.getByRole("button", { name: "Start side chat" })).toBeEnabled();
  });

});
