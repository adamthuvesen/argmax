import { ChevronRight, Folder } from "lucide-react";
import type { JSX } from "react";
import type { ReviewState } from "../hooks/useReviewState.js";
import { statusLabel, summarizeChangedFiles } from "../lib/changedFiles.js";
import { ChangeCount } from "./ChangeCount.js";

export function ChangedFilesCard({ review }: { review: ReviewState }): JSX.Element | null {
  if (review.filesState === "idle") {
    return null;
  }

  const browseFilesButton = (
    <button
      className="changed-files-browse"
      type="button"
      aria-label="Browse workspace files"
      title="Browse workspace files"
      onClick={review.openPanelInFilesMode}
    >
      <Folder size={13} />
    </button>
  );

  if (review.filesState === "loading") {
    return (
      <section className="changed-files-card" aria-label="Changed files">
        <div className="changed-files-header changed-files-header-static">
          <span className="changed-files-title">Loading changed files</span>
          {browseFilesButton}
        </div>
      </section>
    );
  }

  if (review.filesState === "error") {
    return (
      <section className="changed-files-card" aria-label="Changed files">
        <div className="changed-files-header changed-files-header-static">
          <span className="changed-files-title">Changed files unavailable</span>
          <span className="review-error">{review.filesError}</span>
          {browseFilesButton}
        </div>
      </section>
    );
  }

  if (review.files.length === 0) {
    return (
      <section className="changed-files-card" aria-label="Changed files">
        <div className="changed-files-header changed-files-header-static">
          <span className="changed-files-title">No changes yet</span>
          {browseFilesButton}
        </div>
      </section>
    );
  }

  const totals = summarizeChangedFiles(review.files);
  return (
    <section className="changed-files-card" aria-label="Changed files">
      <div className="changed-files-header-row">
        <button
          className="changed-files-header"
          type="button"
          aria-expanded={!review.isSummaryCollapsed}
          aria-label="Toggle changed files"
          onClick={review.toggleSummary}
        >
          <span className="changed-files-title">{review.files.length} files changed</span>
          <span className="changed-files-actions">
            <ChangeCount additions={totals.additions} deletions={totals.deletions} />
          </span>
          <ChevronRight size={11} className={`changed-files-chevron${!review.isSummaryCollapsed ? " expanded" : ""}`} />
        </button>
        {browseFilesButton}
      </div>
      {!review.isSummaryCollapsed ? (
        <div className="changed-files-list">
          {review.files.map((file) => (
            <button
              aria-pressed={review.selectedFilePath === file.path && review.isPanelOpen}
              className="changed-file-row"
              key={file.path}
              type="button"
              title={file.path}
              onClick={() => review.openFile(file.path)}
            >
              <span className="changed-file-status">{statusLabel(file.status)}</span>
              <span className="changed-file-path">{file.path}</span>
              <ChangeCount additions={file.additions} deletions={file.deletions} />
              <ChevronRight size={16} />
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}
