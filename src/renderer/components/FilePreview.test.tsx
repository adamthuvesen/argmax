import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readBundledCss } from "../styles/readBundledCss.js";
import { FilePreview } from "./FilePreview.js";
import { resolveMarkdownImageSrc } from "../lib/markdownImageSrc.js";
import { createBrowserTab, getBrowserRequest, getBrowserTabs, resetBrowserTabsForTests, subscribeBrowserRequest } from "../lib/browserPanel.js";
import { LINK_TARGET_KEY } from "../lib/linkTarget.js";
import type { WorkspaceFilesState } from "../hooks/useReviewState.js";
import { WORKSPACE_ASSET_PROTOCOL_SCHEME } from "../../shared/assetProtocol.js";

function makeState(overrides: Partial<WorkspaceFilesState> = {}): WorkspaceFilesState {
  return {
    entries: [],
    listState: "ready",
    listError: null,
    refreshList: () => undefined,
    tabs: [],
    activeTabPath: "src/index.ts",
    selectedPath: "src/index.ts",
    rootPath: "/tmp/argmax-test-root",
    preview: { kind: "text", content: "export const ok = true;\n", size: 24, mtimeMs: 1000 },
    previewState: "ready",
    previewError: null,
    openFile: () => undefined,
    selectTab: () => undefined,
    closeTab: () => undefined,
    dirtyClosePrompt: null,
    saveDirtyTabAndClose: () => Promise.resolve(),
    discardDirtyTabAndClose: () => undefined,
    cancelDirtyTabClose: () => undefined,
    buffer: "export const ok = true;\n",
    isDirty: false,
    diskMtimeMs: 1000,
    externalChange: false,
    saveState: "idle",
    saveError: null,
    canEdit: true,
    editFile: () => undefined,
    saveFile: () => Promise.resolve(),
    reloadFile: () => undefined,
    dismissExternalChange: () => undefined,
    ...overrides
  };
}

describe("FilePreview", () => {
  it.each([
    ["https://example.com/docs", "system", {}, "system"],
    ["http://example.com/docs", "argmax", {}, "argmax"],
    ["HTTPS://example.com/docs", "system", { metaKey: true }, "argmax"],
    ["//example.com/docs", "system", { ctrlKey: true }, "argmax"],
    ["https://example.com/docs", "argmax", { metaKey: true }, "system"],
    ["https://example.com/docs", "argmax", { ctrlKey: true }, "system"]
  ])("routes preview link %s with preference %s and modifiers %j to %s", (href, preference, modifiers, destination) => {
    const originalApi = Object.getOwnPropertyDescriptor(window, "argmax");
    const originalPreference = localStorage.getItem(LINK_TARGET_KEY);
    const openPath = vi.fn().mockResolvedValue({ ok: true });
    Object.defineProperty(window, "argmax", { configurable: true, value: { system: { openPath } } });
    localStorage.setItem(LINK_TARGET_KEY, preference);
    const opened: string[] = [];
    const unsubscribe = subscribeBrowserRequest(() => {
      const request = getBrowserRequest();
      if (request) opened.push(request.url);
    });
    try {
      resetBrowserTabsForTests();
      const existingTab = createBrowserTab("https://example.com/already-open");
      const content = `[docs](${href})`;
      render(<FilePreview state={makeState({
        selectedPath: "README.md",
        buffer: content,
        preview: { kind: "text", content, size: content.length, mtimeMs: 1 }
      })} />);
      const link = screen.getByRole("link", { name: "docs" });
      expect(fireEvent.click(link, modifiers)).toBe(false);
      const expectedUrl = href.startsWith("//") ? `https:${href}` : href;
      if (destination === "system") {
        expect(openPath).toHaveBeenCalledExactlyOnceWith({ path: expectedUrl });
        expect(opened).toEqual([]);
      } else {
        expect(opened).toEqual([expectedUrl]);
        expect(openPath).not.toHaveBeenCalled();
        const newTabId = getBrowserRequest()?.tabId;
        expect(newTabId).toBeDefined();
        expect(newTabId).not.toBe(existingTab.id);
        expect(getBrowserTabs()).toEqual([
          existingTab,
          expect.objectContaining({ id: newTabId, url: expectedUrl })
        ]);
        fireEvent.click(link, modifiers);
        expect(getBrowserTabs()).toHaveLength(3);
        expect(getBrowserRequest()?.tabId).not.toBe(newTabId);
      }
    } finally {
      unsubscribe();
      resetBrowserTabsForTests();
      if (originalApi) Object.defineProperty(window, "argmax", originalApi);
      else Reflect.deleteProperty(window, "argmax");
      if (originalPreference === null) localStorage.removeItem(LINK_TARGET_KEY);
      else localStorage.setItem(LINK_TARGET_KEY, originalPreference);
    }
  });

  it("renders the editor for text files", () => {
    render(<FilePreview state={makeState()} />);
    expect(screen.getByLabelText("Editor for src/index.ts")).toBeInTheDocument();
  });

  it("does not show file size metadata", () => {
    render(<FilePreview state={makeState()} />);
    expect(screen.queryByText("24 B")).not.toBeInTheDocument();
  });

  it("shows the shortcut legend with no selection and yields to the editor once a file opens", () => {
    const { rerender } = render(<FilePreview state={makeState({ selectedPath: null, activeTabPath: null })} />);
    expect(screen.getByLabelText("No file selected")).toBeInTheDocument();
    expect(screen.getByText("Select a file to preview")).toBeInTheDocument();
    expect(screen.getByText("Find a file")).toBeInTheDocument();

    rerender(<FilePreview state={makeState()} />);
    expect(screen.getByLabelText("Editor for src/index.ts")).toBeInTheDocument();
    expect(screen.queryByLabelText("No file selected")).not.toBeInTheDocument();
  });

  it("shows the dirty marker only when isDirty is true", () => {
    const { rerender } = render(<FilePreview state={makeState({ isDirty: false })} />);
    expect(screen.queryByLabelText("Unsaved changes")).not.toBeInTheDocument();
    rerender(<FilePreview state={makeState({ isDirty: true })} />);
    expect(screen.getByLabelText("Unsaved changes")).toBeInTheDocument();
  });

  it("calls editFile when the buffer changes", () => {
    const editFile = vi.fn();
    render(<FilePreview state={makeState({ editFile })} />);
    const editor = screen.getByLabelText("Editor for src/index.ts");
    fireEvent.change(editor, { target: { value: "export const ok = false;\n" } });
    expect(editFile).toHaveBeenCalledWith("export const ok = false;\n");
  });

  it("marks the source editor read-only when file editing is unavailable", () => {
    render(<FilePreview state={makeState({ canEdit: false })} />);
    const editor = screen.getByLabelText("Editor for src/index.ts");
    expect(editor).toHaveAttribute("data-readonly", "true");
  });

  it("surfaces the stale banner with both actions when dirty and externally changed", () => {
    const reloadFile = vi.fn();
    const dismissExternalChange = vi.fn();
    render(
      <FilePreview
        state={makeState({
          isDirty: true,
          externalChange: true,
          reloadFile,
          dismissExternalChange
        })}
      />
    );
    expect(screen.getByLabelText("File changed on disk")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Reload from disk"));
    expect(reloadFile).toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Keep my edits and overwrite on save"));
    expect(dismissExternalChange).toHaveBeenCalled();
  });

  it("hides the Keep-my-edits action when the buffer isn't dirty", () => {
    render(
      <FilePreview
        state={makeState({
          isDirty: false,
          externalChange: true
        })}
      />
    );
    expect(screen.getByLabelText("Reload from disk")).toBeInTheDocument();
    expect(screen.queryByLabelText("Keep my edits and overwrite on save")).not.toBeInTheDocument();
  });

  it("renders the read-only message for binary previews and skips the editor", () => {
    render(
      <FilePreview
        state={makeState({
          preview: { kind: "skipped", reason: "binary", size: 4096 },
          buffer: null
        })}
      />
    );
    expect(screen.getByText(/Binary file/)).toBeInTheDocument();
    expect(screen.queryByText("4.0 KB")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Editor for src/index.ts")).not.toBeInTheDocument();
  });

  it("surfaces saveError as an alert", () => {
    render(
      <FilePreview
        state={makeState({
          saveError: "disk full"
        })}
      />
    );
    expect(screen.getByRole("alert")).toHaveTextContent("disk full");
  });

  it("rewrites a relative README image into an argmax-asset:// URL", () => {
    render(
      <FilePreview
        state={makeState({
          selectedPath: "README.md",
          rootPath: "/Users/me/repo",
          preview: { kind: "text", content: "![logo](docs/assets/logo.png)\n", size: 30, mtimeMs: 1 },
          buffer: "![logo](docs/assets/logo.png)\n"
        })}
      />
    );
    const img = screen.getByRole("img", { name: "logo" });
    const src = img.getAttribute("src") ?? "";
    expect(src.startsWith(`${WORKSPACE_ASSET_PROTOCOL_SCHEME}://file`)).toBe(true);
    expect(src).toContain("Users");
    expect(src).toContain("repo");
    expect(src).toContain("docs");
    expect(src).toContain("logo.png");
  });

  it("shows an image file instead of the binary message", () => {
    render(
      <FilePreview
        state={makeState({
          selectedPath: "docs/design/fox.png",
          activeTabPath: "docs/design/fox.png",
          rootPath: "/Users/me/repo",
          preview: { kind: "skipped", reason: "binary", size: 4096 },
          buffer: null
        })}
      />
    );
    const img = screen.getByRole("img", { name: "docs/design/fox.png" });
    expect(img.getAttribute("src")).toBe(
      `${WORKSPACE_ASSET_PROTOCOL_SCHEME}://file/Users/me/repo/docs/design/fox.png`
    );
    expect(screen.queryByText(/Binary file/)).not.toBeInTheDocument();
    expect(screen.getByText("4.0 KB")).toBeInTheDocument();
  });

  it("shows an image that was skipped for size, and toggles it to actual size", () => {
    render(
      <FilePreview
        state={makeState({
          selectedPath: "sheet.png",
          activeTabPath: "sheet.png",
          preview: { kind: "skipped", reason: "too-large", size: 4_000_000 },
          buffer: null
        })}
      />
    );
    expect(screen.queryByText(/File too large/)).not.toBeInTheDocument();
    const frame = screen.getByLabelText("View image at actual size");
    fireEvent.click(frame);
    expect(screen.getByLabelText("Fit image to the panel")).toBeInTheDocument();
  });

  it("keeps the not-a-regular-file message for an image path that is a symlink", () => {
    render(
      <FilePreview
        state={makeState({
          selectedPath: "link.png",
          activeTabPath: "link.png",
          preview: { kind: "skipped", reason: "not-a-file" },
          buffer: null
        })}
      />
    );
    expect(screen.getByText("Not a regular file.")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("renders an SVG as a picture by default and swaps to its source on demand", () => {
    render(
      <FilePreview
        state={makeState({
          selectedPath: "assets/icon.svg",
          activeTabPath: "assets/icon.svg",
          rootPath: "/Users/me/repo",
          preview: { kind: "text", content: "<svg/>", size: 6, mtimeMs: 1 },
          buffer: "<svg/>"
        })}
      />
    );
    expect(screen.getByRole("img", { name: "assets/icon.svg" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Editor for assets/icon.svg")).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("View SVG source"));
    expect(screen.getByLabelText("Editor for assets/icon.svg")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "assets/icon.svg" })).not.toBeInTheDocument();
  });

  it("caps every markdown preview block at one centered measure", () => {
    const cssPath = resolve(dirname(fileURLToPath(import.meta.url)), "../styles.css");
    const css = readBundledCss(cssPath);

    const container = /\.file-preview-markdown\s*\{(?<body>[^}]+)\}/i.exec(css);
    const measure = /--file-preview-measure:\s*(?<px>\d+)px/i.exec(container?.groups?.body ?? "");
    expect(Number(measure?.groups?.px ?? 0)).toBe(840);

    // The cap lands on all top-level children, not just prose, so short fenced
    // code and tables stop spanning the review pane.
    const blocks = /\.file-preview-markdown\.markdown\s*>\s*\*\s*\{(?<body>[^}]+)\}/i.exec(css);
    expect(blocks?.groups?.body).toMatch(/max-width:\s*var\(--file-preview-measure\)/i);
    expect(blocks?.groups?.body).toMatch(/margin-inline:\s*auto/i);
  });
});

describe("resolveMarkdownImageSrc", () => {
  it("passes through absolute http(s) and data URLs untouched", () => {
    expect(resolveMarkdownImageSrc("https://example.com/x.png", "/repo", "README.md")).toBe(
      "https://example.com/x.png"
    );
    expect(resolveMarkdownImageSrc("data:image/png;base64,AAA", "/repo", "README.md")).toBe(
      "data:image/png;base64,AAA"
    );
  });

  it("joins relative paths against the directory of the markdown file", () => {
    const resolved = resolveMarkdownImageSrc("assets/logo.png", "/repo", "docs/intro.md");
    expect(resolved).toBe(`${WORKSPACE_ASSET_PROTOCOL_SCHEME}://file/repo/docs/assets/logo.png`);
  });

  it("collapses ./ and ../ segments correctly", () => {
    const resolved = resolveMarkdownImageSrc("../img/logo.png", "/repo", "docs/intro.md");
    expect(resolved).toBe(`${WORKSPACE_ASSET_PROTOCOL_SCHEME}://file/repo/img/logo.png`);
  });

  it("treats a leading slash as relative to the repository root", () => {
    const resolved = resolveMarkdownImageSrc("/banner.png", "/repo", "docs/intro.md");
    expect(resolved).toBe(`${WORKSPACE_ASSET_PROTOCOL_SCHEME}://file/repo/banner.png`);
  });

  it("returns undefined when traversal escapes the root", () => {
    expect(resolveMarkdownImageSrc("../../../etc/passwd.png", "/repo", "README.md")).toBeUndefined();
  });

  it("returns the original src when there is no rootPath or selectedPath", () => {
    expect(resolveMarkdownImageSrc("logo.png", null, "README.md")).toBe("logo.png");
    expect(resolveMarkdownImageSrc("logo.png", "/repo", null)).toBe("logo.png");
  });
});
