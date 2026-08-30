import { useEffect, useMemo, useState, type JSX } from "react";
import type { WorkspaceSummary } from "../../shared/types.js";
import { ChangeCount } from "../components/ChangeCount.js";
import { DiffBlocks } from "../components/DiffBlocks.js";
import { FilePreview } from "../components/FilePreview.js";
import { LinesSkeleton } from "../components/LinesSkeleton.js";
import { WorkspaceTree } from "../components/WorkspaceTree.js";
import {
  REVIEW_SCOPE_LABELS,
  useReviewState,
  type ReviewChangesScope,
  type ReviewSource
} from "../hooks/useReviewState.js";
import { statusLabel, summarizeChangedFiles } from "../lib/changedFiles.js";
import { MobileScreenHeader } from "./MobileScreenHeader.js";
import { parseUnifiedDiff } from "../lib/diff.js";

function statusGlyph(status: string): string {
  return statusLabel(status).slice(0, 1).toUpperCase();
}

/**
 * Full-screen mobile counterpart of the desktop review panel: the same
 * Changes / Files views, drill-down instead of columns. Reuses the desktop
 * data hooks and leaf components (tree, diff, preview) wholesale — only the
 * chrome is mobile-shaped.
 */
export function MobileReviewScreen({
  workspace,
  initialFilePath = null,
  onClose
}: {
  workspace: WorkspaceSummary;
  /** Open straight into this file — set when a chat file reference was tapped. */
  initialFilePath?: string | null;
  onClose: () => void;
}): JSX.Element {
  const source = useMemo<ReviewSource>(() => ({ kind: "workspace", workspace }), [workspace]);
  // Phones have no Cmd+S and no save affordance, so browsing stays read-only —
  // a stray tap in the editor can't strand unsaved edits, and the editor's
  // external-change polling stays off the WS bridge.
  // The data hooks only load while the panel is "open"; on this screen the
  // panel is the screen, so it starts open and stays open.
  const review = useReviewState(source, null, { editable: false, initiallyOpen: true });

  const [collapsedDiffPath, setCollapsedDiffPath] = useState<string | null>(null);
  // Files mode drills down: tree first, then the tapped file full-screen.
  const [fileOpen, setFileOpen] = useState(false);

  const { openInFilesView } = review;
  useEffect(() => {
    if (!initialFilePath) return;
    openInFilesView(initialFilePath);
    setFileOpen(true);
  }, [initialFilePath, openInFilesView]);

  const isChanges = review.mode === "changes";
  const selectedFile = review.files.find((file) => file.path === review.selectedFilePath) ?? null;
  const expandedFilePath =
    selectedFile && collapsedDiffPath !== selectedFile.path ? selectedFile.path : null;
  const diffBlocks = useMemo(() => parseUnifiedDiff(review.diff?.content ?? ""), [review.diff?.content]);
  const totals = summarizeChangedFiles(review.files);

  const toggleChangedFile = (filePath: string): void => {
    if (review.selectedFilePath === filePath) {
      setCollapsedDiffPath((current) => (current === filePath ? null : filePath));
      return;
    }
    setCollapsedDiffPath(null);
    review.openFile(filePath);
  };

  const previewingFile = !isChanges && fileOpen && review.workspaceFiles.selectedPath !== null;
  // Selecting a file in the tree pushes the full-screen preview.
  const treeState = {
    ...review.workspaceFiles,
    openFile: (path: string): void => {
      review.workspaceFiles.openFile(path);
      setFileOpen(true);
    }
  };

  return (
    <div className="mobile-review-screen">
      <MobileScreenHeader
        onBack={previewingFile ? () => setFileOpen(false) : onClose}
        backLabel={previewingFile ? "Back to files" : "Back to session"}
        title={
          <div className="mobile-review-tabs" role="tablist" aria-label="Review mode">
            <button
              role="tab"
              type="button"
              aria-selected={isChanges}
              onClick={() => review.setMode("changes")}
            >
              Changes
            </button>
            <button
              role="tab"
              type="button"
              aria-selected={!isChanges}
              onClick={() => review.setMode("files")}
            >
              Files
            </button>
          </div>
        }
      />

      {isChanges ? (
        <div className="mobile-review-meta">
          <select
            className="mobile-review-scope"
            aria-label="Changes shown"
            value={review.changesScope}
            onChange={(event) => review.setChangesScope(event.target.value as ReviewChangesScope)}
          >
            {review.availableScopes.map((scope) => (
              <option key={scope} value={scope}>
                {REVIEW_SCOPE_LABELS[scope]}
              </option>
            ))}
          </select>
          {review.files.length > 0 ? (
            <span className="mobile-review-totals">
              {review.files.length} file{review.files.length === 1 ? "" : "s"} · +{totals.additions}{" "}
              −{totals.deletions}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="mobile-review-body">
        {isChanges ? (
          <div className="mobile-review-scroll">
            {review.filesState === "loading" && review.files.length === 0 ? (
              <LinesSkeleton rows={10} label="Loading changes" className="review-diff-skeleton" />
            ) : null}
            {review.filesState === "error" ? (
              <p className="review-empty review-error" role="alert">
                {review.filesError ?? "Couldn't load changes."}
              </p>
            ) : null}
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
                    <section
                      className="review-changed-file-section"
                      key={file.path}
                      data-expanded={isExpanded ? "true" : "false"}
                    >
                      <div className="review-changed-file-row">
                        <button
                          className="review-changed-file-toggle"
                          type="button"
                          aria-label={`${isExpanded ? "Collapse" : "Expand"} ${file.path} diff`}
                          aria-expanded={isExpanded}
                          data-status={glyph.toLowerCase()}
                          onClick={() => toggleChangedFile(file.path)}
                        >
                          <span className="review-file-row-status" aria-hidden="true">{glyph}</span>
                          <span className="review-file-row-path">{file.path}</span>
                        </button>
                        <ChangeCount additions={file.additions} deletions={file.deletions} />
                      </div>
                      {isExpanded ? (
                        <div className="review-inline-diff">
                          {review.diffState === "loading" ? (
                            <LinesSkeleton rows={10} label="Loading diff" className="review-diff-skeleton" />
                          ) : null}
                          {review.diffState === "error" ? (
                            <p className="review-empty review-error" role="alert">
                              {review.diffError ?? "Couldn't load this diff."}
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
          </div>
        ) : previewingFile ? (
          <FilePreview state={review.workspaceFiles} />
        ) : (
          <WorkspaceTree state={treeState} />
        )}
      </div>
    </div>
  );
}
