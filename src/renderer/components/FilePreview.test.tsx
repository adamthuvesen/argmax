import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FilePreview } from "./FilePreview.js";
import type { WorkspaceFilesState } from "../hooks/useReviewState.js";

// CodeMirror leans on browser APIs (focus, range selection) that jsdom only
// partially supports. We exercise the React-side contract — dirty marker,
// stale banner, callback wiring — rather than CodeMirror's own DOM.
vi.mock("@uiw/react-codemirror", () => ({
  default: ({ value, onChange, "aria-label": ariaLabel }: {
    value: string;
    onChange: (next: string) => void;
    "aria-label"?: string;
  }) => (
    <textarea
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}));

function makeState(overrides: Partial<WorkspaceFilesState> = {}): WorkspaceFilesState {
  return {
    entries: [],
    listState: "ready",
    listError: null,
    selectedPath: "src/index.ts",
    preview: { kind: "text", content: "export const ok = true;\n", size: 24, mtimeMs: 1000 },
    previewState: "ready",
    previewError: null,
    openFile: () => undefined,
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
});
