import { Columns2, FileText, Folder, GitBranch, GitCommitHorizontal, PanelRightClose, Rows3, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type JSX, type MouseEvent as ReactMouseEvent } from "react";
import type { ReviewState } from "../hooks/useReviewState.js";
import { statusLabel, summarizeChangedFiles } from "../lib/changedFiles.js";
import { parseUnifiedDiff } from "../lib/diff.js";
import type { CommitPreparation, PrepareCommitInput, WorkspaceSummary } from "../../shared/types.js";
import { ChangeCount } from "./ChangeCount.js";
import { CommitDialog } from "./CommitDialog.js";
import { DiffBlocks, type DiffView } from "./DiffBlocks.js";
import { FilePreview } from "./FilePreview.js";
import { WorkspaceTree } from "./WorkspaceTree.js";

const DIFF_VIEW_KEY = "argmax.diffView";
const LEFT_COL_WIDTH_KEY = "argmax.reviewPanel.leftColumnWidth";
const LEFT_COL_MIN = 200;
const LEFT_COL_MAX = 600;
const LEFT_COL_DEFAULT = 280;

function readStoredDiffView(): DiffView {
  if (typeof window === "undefined") return "unified";
  const raw = window.localStorage.getItem(DIFF_VIEW_KEY);
  return raw === "side-by-side" ? "side-by-side" : "unified";
}

function readStoredLeftColumnWidth(): number {
  if (typeof window === "undefined") return LEFT_COL_DEFAULT;
  const raw = window.localStorage.getItem(LEFT_COL_WIDTH_KEY);
  if (!raw) return LEFT_COL_DEFAULT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return LEFT_COL_DEFAULT;
  return Math.max(LEFT_COL_MIN, Math.min(LEFT_COL_MAX, parsed));
}

export function ReviewPanel({
  onResizePanelMouseDown,
  review,
  workspace,
  onPrepareCommit
}: {
  onResizePanelMouseDown?: (event: ReactMouseEvent) => void;
  review: ReviewState;
  workspace?: WorkspaceSummary | null;
  onPrepareCommit?: (input: PrepareCommitInput) => Promise<CommitPreparation>;
}): JSX.Element {
  const selectedFile = review.files.find((file) => file.path === review.selectedFilePath) ?? null;
  const totals = summarizeChangedFiles(review.files);
  const diffBlocks = useMemo(() => parseUnifiedDiff(review.diff?.content ?? ""), [review.diff?.content]);
  const [leftColumnWidth, setLeftColumnWidth] = useState<number>(() => readStoredLeftColumnWidth());
  const [isCommitDialogOpen, setIsCommitDialogOpen] = useState(false);
  const [diffView, setDiffView] = useState<DiffView>(() => readStoredDiffView());
  const panelRef = useRef<HTMLElement>(null);
  const canCommit = Boolean(workspace?.id && onPrepareCommit && review.files.length > 0);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(DIFF_VIEW_KEY, diffView);
  }, [diffView]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(LEFT_COL_WIDTH_KEY, String(leftColumnWidth));
  }, [leftColumnWidth]);

  // Captures the listener-removal + body-style-reset for any drag currently
  // in flight; the unmount cleanup below replays it so a mid-drag unmount
  // doesn't leave document-level listeners or a frozen cursor behind.
  const dragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;
    },
    []
  );

  const handleResizeMouseDown = (e: ReactMouseEvent): void => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = leftColumnWidth;
    // Cap so the diff column always retains at least half the panel width.
    const maxW = Math.max(LEFT_COL_MIN, (panelRef.current?.clientWidth ?? 800) * 0.5);
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (me: MouseEvent) => {
      setLeftColumnWidth(Math.max(LEFT_COL_MIN, Math.min(startW + me.clientX - startX, maxW)));
    };
    const cleanup = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      dragCleanupRef.current = null;
    };
    const onUp = () => cleanup();
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    dragCleanupRef.current = cleanup;
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
        <div className="review-toolbar-actions">
          <button
            className="small-icon"
            type="button"
            title={diffView === "unified" ? "Switch to side-by-side diff" : "Switch to unified diff"}
            aria-label={diffView === "unified" ? "Switch to side-by-side diff" : "Switch to unified diff"}
            aria-pressed={diffView === "side-by-side"}
            onClick={() => setDiffView((current) => (current === "unified" ? "side-by-side" : "unified"))}
          >
            {diffView === "unified" ? <Columns2 size={18} /> : <Rows3 size={18} />}
          </button>
          <button
            className="small-icon"
            type="button"
            title="Commit selected"
            aria-label="Commit selected"
            disabled={!canCommit}
            onClick={() => setIsCommitDialogOpen(true)}
          >
            <GitCommitHorizontal size={18} />
          </button>
          <button className="small-icon" type="button" title="Close review" aria-label="Close review" onClick={review.closePanel}>
            <PanelRightClose size={18} />
          </button>
        </div>
      </div>
      <div className="review-body">
        <div className="review-list-col" style={{ width: leftColumnWidth }}>
          {isChanges ? (
            <div className="review-file-tabs" aria-label="Changed file list">
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
            <WorkspaceTree state={review.workspaceFiles} />
          )}
        </div>
        <div
          className="review-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize file list width"
          onMouseDown={handleResizeMouseDown}
        />
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
              {review.diffState === "ready" && diffBlocks.length > 0 ? (
                <DiffBlocks blocks={diffBlocks} filePath={selectedFile?.path ?? null} view={diffView} />
              ) : null}
            </>
          ) : (
            <FilePreview state={review.workspaceFiles} />
          )}
        </div>
      </div>
      {workspace && onPrepareCommit ? (
        <CommitDialog
          open={isCommitDialogOpen}
          onClose={() => setIsCommitDialogOpen(false)}
          workspaceId={workspace.id}
          files={review.files}
          defaultMessage={workspace.taskLabel}
          onPrepareCommit={onPrepareCommit}
        />
      ) : null}
    </aside>
  );
}
