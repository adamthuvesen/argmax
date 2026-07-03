import { Folder, FolderOpen, GitBranch, PanelRightClose, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type JSX, type MouseEvent as ReactMouseEvent } from "react";
import type { ReviewState, WorkspaceFilesState } from "../hooks/useReviewState.js";
import { statusLabel, summarizeChangedFiles } from "../lib/changedFiles.js";
import { parseUnifiedDiff } from "../lib/diff.js";
import { ChangeCount } from "./ChangeCount.js";
import { DiffBlocks } from "./DiffBlocks.js";
import { FilePreview } from "./FilePreview.js";
import { LinesSkeleton } from "./LinesSkeleton.js";
import { WorkspaceTree } from "./WorkspaceTree.js";

function fileBasename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

function statusGlyph(status: string): string {
  return statusLabel(status).slice(0, 1).toUpperCase();
}

function FileTabStrip({ state }: { state: WorkspaceFilesState }): JSX.Element | null {
  if (state.tabs.length === 0) return null;
  const promptPath = state.dirtyClosePrompt?.path ?? null;
  const promptName = promptPath ? fileBasename(promptPath) : null;
  return (
    <div className="file-tabs-shell">
      <div className="file-tabs" role="tablist" aria-label="Open files">
        {state.tabs.map((tab) => {
          const isActive = tab.path === state.activeTabPath;
          return (
            <div className="file-tab" data-active={isActive ? "true" : "false"} key={tab.path}>
              <button
                type="button"
                role="tab"
                aria-selected={isActive}
                title={tab.path}
                onClick={() => state.selectTab(tab.path)}
              >
                <span className="file-tab-name">{fileBasename(tab.path)}</span>
                {tab.isDirty ? (
                  <span className="file-tab-dirty" aria-label="Unsaved changes" title="Unsaved changes">
                    •
                  </span>
                ) : null}
              </button>
              <button
                type="button"
                className="file-tab-close"
                aria-label={`Close ${tab.path}`}
                title={`Close ${tab.path}`}
                onClick={(event) => {
                  event.stopPropagation();
                  state.closeTab(tab.path);
                }}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
      {promptPath ? (
        <div className="file-tab-close-prompt" role="alert" aria-label={`Unsaved changes in ${promptPath}`}>
          <span>
            Save changes to <strong>{promptName}</strong>?
          </span>
          <div className="file-tab-close-prompt-actions">
            <button
              type="button"
              onClick={() => void state.saveDirtyTabAndClose()}
              disabled={state.saveState === "saving"}
            >
              {state.saveState === "saving" ? "Saving..." : "Save"}
            </button>
            <button type="button" onClick={state.discardDirtyTabAndClose}>
              Discard
            </button>
            <button type="button" onClick={state.cancelDirtyTabClose}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const LEFT_COL_WIDTH_KEY = "argmax.reviewPanel.leftColumnWidth";
const LEFT_COL_MIN = 200;
const LEFT_COL_MAX = 600;
const LEFT_COL_DEFAULT = 280;
const PREVIEW_COL_MIN = 160;
const REVIEW_RESIZE_HANDLE_WIDTH = 5;

function maxLeftColumnWidth(panelWidth: number): number {
  return Math.max(
    LEFT_COL_MIN,
    Math.min(LEFT_COL_MAX, panelWidth - PREVIEW_COL_MIN - REVIEW_RESIZE_HANDLE_WIDTH)
  );
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
  review
}: {
  onResizePanelMouseDown?: (event: ReactMouseEvent) => void;
  review: ReviewState;
}): JSX.Element {
  const selectedFile = review.files.find((file) => file.path === review.selectedFilePath) ?? null;
  const totals = summarizeChangedFiles(review.files);
  const diffBlocks = useMemo(() => parseUnifiedDiff(review.diff?.content ?? ""), [review.diff?.content]);
  const [leftColumnWidth, setLeftColumnWidth] = useState<number>(() => readStoredLeftColumnWidth());
  const [collapsedDiffPath, setCollapsedDiffPath] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(LEFT_COL_WIDTH_KEY, String(leftColumnWidth));
  }, [leftColumnWidth]);

  useEffect(() => {
    if (review.mode !== "files") return undefined;
    const panel = panelRef.current;
    if (!panel) return undefined;
    const clampToPanel = (): void => {
      const maxW = maxLeftColumnWidth(panel.clientWidth);
      setLeftColumnWidth((current) => (current > maxW ? maxW : current));
    };
    clampToPanel();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(clampToPanel);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [review.mode]);

  useEffect(() => {
    if (review.mode !== "files") return undefined;
    const activePath = review.workspaceFiles.activeTabPath;
    if (!activePath) return undefined;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== "w") return;
      if (event.isComposing || event.repeat) return;
      event.preventDefault();
      event.stopPropagation();
      review.workspaceFiles.closeTab(activePath);
    };
    document.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => document.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [review.mode, review.workspaceFiles]);

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
    const maxW = maxLeftColumnWidth(panelRef.current?.clientWidth ?? 800);
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
  const branchComparison = review.changesComparison === "branch";
  const comparisonLabel = branchComparison ? "Branch" : "Local";
  const nextComparison = branchComparison ? "local" : "branch";
  const nextComparisonTitle = branchComparison
    ? "Switch to working-tree changes (uncommitted, vs HEAD)"
    : review.comparisonBaseLabel
      ? `Switch to all changes vs ${review.comparisonBaseLabel}`
      : "Switch to all changes vs base branch";
  const subtitle = isChanges
    ? `${review.files.length} ${review.files.length === 1 ? "file" : "files"} changed`
    : "Files";
  const eyebrow = isChanges ? "Review // Changes" : "Review // Files";
  const summaryStrip = isChanges && review.files.length > 0
    ? `${review.files.length} file${review.files.length === 1 ? "" : "s"} · +${totals.additions} −${totals.deletions}`
    : null;
  const expandedFilePath = selectedFile && collapsedDiffPath !== selectedFile.path ? selectedFile.path : null;

  const toggleChangedFile = (filePath: string): void => {
    if (review.selectedFilePath === filePath) {
      setCollapsedDiffPath((current) => (current === filePath ? null : filePath));
      return;
    }
    setCollapsedDiffPath(null);
    review.openFile(filePath);
  };

  return (
    <aside className="review-panel" aria-label="Review panel" ref={panelRef}>
      {onResizePanelMouseDown ? (
        <div className="panel-col-resize-handle" aria-hidden="true" onMouseDown={onResizePanelMouseDown} />
      ) : null}
      <div className="review-toolbar">
        <div className="review-toolbar-titles">
          <p className="review-eyebrow" aria-hidden="true">{eyebrow}</p>
          <div className="review-mode-tabs" role="tablist" aria-label="Review panel mode">
            <button
              role="tab"
              type="button"
              aria-label="Changes"
              aria-selected={isChanges}
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
              title="Files"
              onClick={() => review.setMode("files")}
            >
              <Folder size={14} aria-hidden="true" />
            </button>
          </div>
          <h2>
            <span className="review-title-text">{subtitle}</span>
            {isChanges && review.files.length > 0 ? (
              <ChangeCount additions={totals.additions} deletions={totals.deletions} />
            ) : null}
          </h2>
        </div>
        <div className="review-toolbar-actions">
          {isChanges ? (
            <div className="review-comparison-toggle-wrap">
              <button
                type="button"
                className="review-comparison-toggle"
                aria-label={`Diff baseline: ${comparisonLabel}`}
                aria-pressed={branchComparison}
                title={nextComparisonTitle}
                onClick={() => review.setChangesComparison(nextComparison)}
              >
                {comparisonLabel}
              </button>
            </div>
          ) : null}
          <button className="small-icon" type="button" title="Close review" aria-label="Close review" onClick={review.closePanel}>
            <PanelRightClose size={16} strokeWidth={1.75} />
          </button>
        </div>
      </div>
      <div className={isChanges ? "review-body review-body-changes" : "review-body"}>
        {isChanges ? null : (
          <>
            <div className="review-list-col" style={{ width: leftColumnWidth }}>
              <WorkspaceTree state={review.workspaceFiles} />
            </div>
            <div
              className="review-resize-handle"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize file list width"
              onMouseDown={handleResizeMouseDown}
            />
          </>
        )}
        <div className={isChanges ? "review-diff" : "review-diff review-diff-files"}>
          {isChanges ? (
            <>
              {review.filesState === "ready" && review.files.length === 0 ? (
                <p className="review-empty">
                  <span className="review-empty-mark" aria-hidden="true">∅</span>
                  <span>No changes.</span>
                </p>
              ) : null}
              {review.files.length > 0 ? (
                <div className="review-changed-file-stack" aria-label="Changed files">
                  {review.files.map((file) => {
                    const isExpanded = expandedFilePath === file.path;
                    const glyph = statusGlyph(file.status);
                    return (
                      <section className="review-changed-file-section" key={file.path} data-expanded={isExpanded ? "true" : "false"}>
                        <div className="review-changed-file-row">
                          <button
                            className="review-changed-file-toggle"
                            type="button"
                            aria-label={`${isExpanded ? "Collapse" : "Expand"} ${file.path} diff`}
                            aria-expanded={isExpanded}
                            aria-controls={`review-diff-${file.path}`}
                            title={`${isExpanded ? "Collapse" : "Expand"} ${file.path}`}
                            data-status={glyph.toLowerCase()}
                            onClick={() => toggleChangedFile(file.path)}
                          >
                            <span className="review-file-row-status" aria-hidden="true">{glyph}</span>
                            <span className="review-file-row-path">{file.path}</span>
                          </button>
                          <ChangeCount additions={file.additions} deletions={file.deletions} />
                          <button
                            className="small-icon"
                            type="button"
                            title={`Open ${file.path} in Files view`}
                            aria-label={`Open ${file.path} in Files view`}
                            onClick={() => review.openInFilesView(file.path)}
                          >
                            <FolderOpen size={16} />
                          </button>
                        </div>
                        {isExpanded ? (
                          <div className="review-inline-diff" id={`review-diff-${file.path}`}>
                            {review.diffState === "loading" ? (
                              <LinesSkeleton rows={14} label="Loading diff" className="review-diff-skeleton" />
                            ) : null}
                            {review.diffState === "error" ? (
                              <p className="review-empty review-error" role="alert">
                                <span className="review-empty-mark" aria-hidden="true">!</span>
                                <span>{review.diffError ?? "Couldn't load this diff."}</span>
                              </p>
                            ) : null}
                            {review.diffState === "ready" && diffBlocks.length === 0 ? (
                              <p className="review-empty">
                                <span className="review-empty-mark" aria-hidden="true">∅</span>
                                <span>No textual diff.</span>
                              </p>
                            ) : null}
                            {review.diffState === "ready" && diffBlocks.length > 0 ? (
                              <DiffBlocks blocks={diffBlocks} filePath={file.path} />
                            ) : null}
                          </div>
                        ) : null}
                      </section>
                    );
                  })}
                </div>
              ) : null}
            </>
          ) : (
            <>
              <FileTabStrip state={review.workspaceFiles} />
              <FilePreview state={review.workspaceFiles} />
            </>
          )}
        </div>
      </div>
      {summaryStrip ? (
        <footer className="review-footer" aria-hidden="true">
          <span className="review-footer-mark">└─</span>
          <span className="review-footer-text">{summaryStrip}</span>
        </footer>
      ) : null}
    </aside>
  );
}
