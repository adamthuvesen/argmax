import { useEffect, useMemo, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import type { ChangedFileSummary, GitCommitResult } from "../../shared/types.js";

interface Feedback {
  kind: "success" | "error";
  message: string;
}

export function CommitDialog({
  open,
  onClose,
  workspaceId,
  files,
  defaultMessage,
  onCommitted
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  files: ChangedFileSummary[];
  defaultMessage: string;
  onCommitted?: (result: GitCommitResult) => void;
}): JSX.Element | null {
  const allPaths = useMemo(() => files.map((file) => file.path), [files]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(allPaths));
  const [message, setMessage] = useState<string>(defaultMessage);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  // Reset state every time the dialog re-opens so the user always starts from
  // the freshest changed-file list and the default message.
  useEffect(() => {
    if (!open) return;
    setSelected(new Set(allPaths));
    setMessage(defaultMessage);
    setSubmitting(false);
    setFeedback(null);
  }, [open, allPaths, defaultMessage]);

  if (!open) return null;

  const allSelected = allPaths.length > 0 && selected.size === allPaths.length;
  const submitDisabled =
    submitting || selected.size === 0 || message.trim().length === 0 || allPaths.length === 0;

  const togglePath = (path: string): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const toggleAll = (): void => {
    setSelected((current) => (current.size === allPaths.length ? new Set() : new Set(allPaths)));
  };

  const handleSubmit = async (): Promise<void> => {
    if (submitDisabled || !window.argmax) return;
    setSubmitting(true);
    setFeedback(null);
    try {
      const result = await window.argmax.git.commit({
        workspaceId,
        message: message.trim(),
        selectedFiles: Array.from(selected)
      });
      onCommitted?.(result);
      onClose();
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : "Commit failed."
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="commit-dialog-overlay"
      role="dialog"
      aria-label="Commit selected changes"
      aria-modal="true"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      <div className="commit-dialog">
        <header className="commit-dialog-header">
          <h2>Commit selected</h2>
          <button type="button" aria-label="Close commit dialog" onClick={onClose}>
            ×
          </button>
        </header>

        <label className="commit-dialog-stage-all">
          <input
            type="checkbox"
            checked={allSelected}
            aria-label="Stage all files"
            onChange={toggleAll}
            disabled={allPaths.length === 0}
          />
          <span>Stage all ({allPaths.length})</span>
        </label>

        {allPaths.length === 0 ? (
          <p className="commit-dialog-empty">No changes to commit.</p>
        ) : (
          <ul className="commit-dialog-files" role="list" aria-label="Changed files">
            {files.map((file) => (
              <li key={file.path}>
                <label>
                  <input
                    type="checkbox"
                    checked={selected.has(file.path)}
                    aria-label={`Stage ${file.path}`}
                    onChange={() => togglePath(file.path)}
                  />
                  <span className="commit-dialog-file-path">{file.path}</span>
                  <span className="commit-dialog-file-counts">
                    <span className="commit-dialog-additions">+{file.additions}</span>
                    <span className="commit-dialog-deletions">−{file.deletions}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}

        <label className="commit-dialog-message-label" htmlFor="commit-dialog-message">
          Commit message
        </label>
        <textarea
          id="commit-dialog-message"
          className="commit-dialog-message"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          rows={4}
          placeholder="type(scope): lowercase imperative"
        />

        {feedback ? (
          <p
            className={`commit-dialog-feedback commit-dialog-feedback--${feedback.kind}`}
            role={feedback.kind === "error" ? "alert" : "status"}
            aria-live={feedback.kind === "error" ? "assertive" : "polite"}
          >
            {feedback.kind === "success" ? (
              <CheckCircle2 size={14} aria-hidden="true" />
            ) : (
              <AlertCircle size={14} aria-hidden="true" />
            )}
            <span>{feedback.message}</span>
          </p>
        ) : null}

        <footer className="commit-dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="commit-dialog-submit"
            disabled={submitDisabled}
            onClick={() => {
              void handleSubmit();
            }}
          >
            {submitting ? "Committing…" : "Commit"}
          </button>
        </footer>
      </div>
    </div>
  );
}
