import type { JSX } from "react";
import type { WorkspaceFilesState } from "../hooks/useReviewState.js";

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function FilePreview({ state }: { state: WorkspaceFilesState }): JSX.Element {
  if (!state.selectedPath) {
    return <p className="review-empty">Select a file to preview.</p>;
  }
  if (state.previewState === "loading") {
    return <p className="review-empty">Loading file…</p>;
  }
  if (state.previewState === "error") {
    return <p className="review-empty review-error">{state.previewError}</p>;
  }
  const preview = state.preview;
  if (!preview) {
    return <p className="review-empty">No preview available.</p>;
  }
  if (preview.kind === "skipped") {
    const message =
      preview.reason === "binary"
        ? `Binary file${preview.size !== undefined ? ` (${formatBytes(preview.size)})` : ""} — not previewable.`
        : preview.reason === "too-large"
          ? `File too large to preview${preview.size !== undefined ? ` (${formatBytes(preview.size)})` : ""}.`
          : "Not a regular file.";
    return <p className="review-empty">{message}</p>;
  }
  const lines = preview.content.split("\n");
  return (
    <div className="file-preview" aria-label={`Preview of ${state.selectedPath}`}>
      <div className="file-preview-heading">
        <strong>{state.selectedPath}</strong>
        <span className="file-preview-size">{formatBytes(preview.size)}</span>
      </div>
      <pre className="file-preview-body">
        <code>
          {lines.map((line, index) => (
            <span className="file-preview-line" key={index}>
              <span className="file-preview-gutter">{index + 1}</span>
              <span className="file-preview-content">{line || " "}</span>
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
