import { FileText, Folder, GitBranch, PanelRightClose, X } from "lucide-react";
import { useMemo, useRef, useState, type JSX, type MouseEvent as ReactMouseEvent } from "react";
import type { ReviewState } from "../hooks/useReviewState.js";
import { statusLabel, summarizeChangedFiles } from "../lib/changedFiles.js";
import { parseUnifiedDiff } from "../lib/diff.js";
import { ChangeCount } from "./ChangeCount.js";
import { DiffBlocks } from "./DiffBlocks.js";
import { FilePreview } from "./FilePreview.js";
import { WorkspaceTree } from "./WorkspaceTree.js";

export function ReviewPanel({
  onResizePanelMouseDown,
  review
}: {
  onResizePanelMouseDown?: (event: ReactMouseEvent) => void;
  review: ReviewState;
}): JSX.Element {
  const selectedFile = review.files.find((file) => file.path === review.selectedFilePath) ?? null;
  const totals = summarizeChangedFiles(review.files);
  const diffBlocks = useMemo(() => parseUnifiedDiff(review.diff?.content ?? ""), [review.diff?.content]);
  const [fileTabsHeight, setFileTabsHeight] = useState(168);
  const panelRef = useRef<HTMLElement>(null);

  const handleResizeMouseDown = (e: ReactMouseEvent): void => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = fileTabsHeight;
    // Cap so the diff area always gets at least 120px (toolbar ~80px + handle 5px + diff min).
    const maxH = (panelRef.current?.clientHeight ?? 800) - 160;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
    const onMove = (me: MouseEvent) => {
      // Minimum of ~80px gives the user at least two file tabs to scan.
      setFileTabsHeight(Math.max(80, Math.min(startH + me.clientY - startY, maxH)));
    };
    const onUp = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const isChanges = review.mode === "changes";
  const subtitle = isChanges
    ? `${review.files.length} files changed`
    : `${review.workspaceFiles.entries.length} files`;

  return (
    <aside className="review-panel" aria-label="Review panel" ref={panelRef}>
      {onResizePanelMouseDown ? (
        <div className="panel-col-resize-handle" aria-hidden="true" onMouseDown={onResizePanelMouseDown} />
      ) : null}
      <div className="review-toolbar">
        <div className="review-toolbar-titles">
          <div className="review-mode-tabs" role="tablist" aria-label="Review panel mode">
            <button
              role="tab"
              type="button"
              aria-label="Changes"
              aria-selected={isChanges}
              aria-pressed={isChanges}
              title="Changes"
              onClick={() => review.setMode("changes")}
            >
              <GitBranch size={14} aria-hidden="true" />
            </button>
            <button
              role="tab"
              type="button"
              aria-label="Files"
              aria-selected={!isChanges}
              aria-pressed={!isChanges}
              title="Files"
              onClick={() => review.setMode("files")}
            >
              <Folder size={14} aria-hidden="true" />
            </button>
          </div>
          <h2>
            {subtitle}
            {isChanges && review.files.length > 0 ? (
              <ChangeCount additions={totals.additions} deletions={totals.deletions} />
            ) : null}
          </h2>
        </div>
        <button className="small-icon" type="button" title="Close review" aria-label="Close review" onClick={review.closePanel}>
          <PanelRightClose size={18} />
        </button>
      </div>
      {isChanges ? (
        <div className="review-file-tabs" aria-label="Changed file list" style={{ height: fileTabsHeight }}>
          {review.files.map((file) => (
            <button
              aria-pressed={review.selectedFilePath === file.path}
              key={file.path}
              type="button"
              title={file.path}
              onClick={() => review.openFile(file.path)}
            >
              <FileText size={15} />
              <span>{file.path}</span>
              <ChangeCount additions={file.additions} deletions={file.deletions} />
            </button>
          ))}
        </div>
      ) : (
        <WorkspaceTree
          state={review.workspaceFiles}
          height={fileTabsHeight}
        />
      )}
      <div className="review-resize-handle" onMouseDown={handleResizeMouseDown} />
      <div className="review-diff">
        {isChanges ? (
          <>
            {selectedFile ? (
              <div className="review-diff-heading">
                <div>
                  <span className="changed-file-status">{statusLabel(selectedFile.status)}</span>
                  <strong>{selectedFile.path}</strong>
                  <ChangeCount additions={selectedFile.additions} deletions={selectedFile.deletions} />
                </div>
                <button className="small-icon" type="button" title="Close review" aria-label="Close review" onClick={review.closePanel}>
                  <X size={16} />
                </button>
              </div>
            ) : null}
            {review.diffState === "loading" ? <p className="review-empty">Loading diff...</p> : null}
            {review.diffState === "error" ? <p className="review-empty review-error">{review.diffError}</p> : null}
            {review.diffState === "ready" && diffBlocks.length === 0 ? <p className="review-empty">No textual diff.</p> : null}
            {review.diffState === "ready" && diffBlocks.length > 0 ? <DiffBlocks blocks={diffBlocks} /> : null}
          </>
        ) : (
          <FilePreview state={review.workspaceFiles} />
        )}
      </div>
    </aside>
  );
}
