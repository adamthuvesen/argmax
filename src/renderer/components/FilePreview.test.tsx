import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FilePreview } from "./FilePreview.js";
import { resolveMarkdownImageSrc } from "../lib/markdownImageSrc.js";
import type { WorkspaceFilesState } from "../hooks/useReviewState.js";
import { WORKSPACE_ASSET_PROTOCOL_SCHEME } from "../../shared/assetProtocol.js";

function makeState(overrides: Partial<WorkspaceFilesState> = {}): WorkspaceFilesState {
  return {
    entries: [],
    listState: "ready",
    listError: null,
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
  it("renders the editor for text files", () => {
    render(<FilePreview state={makeState()} />);
    expect(screen.getByLabelText("Editor for src/index.ts")).toBeInTheDocument();
  });

  it("marks only the no-selection prompt as preview-width responsive", () => {
    const { rerender } = render(<FilePreview state={makeState({ selectedPath: null, activeTabPath: null })} />);
    expect(screen.getByText("Select a file to preview.")).toHaveClass("review-empty-preview");

    rerender(<FilePreview state={makeState()} />);
    expect(screen.getByLabelText("Editor for src/index.ts")).toBeInTheDocument();
    expect(screen.queryByText("Select a file to preview.")).not.toBeInTheDocument();
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

  it("calls saveFile from the header save button when the file is dirty", () => {
    const saveFile = vi.fn().mockResolvedValue(undefined);
    render(<FilePreview state={makeState({ isDirty: true, saveFile })} />);
    fireEvent.click(screen.getByRole("button", { name: "Save file" }));
    expect(saveFile).toHaveBeenCalled();
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
