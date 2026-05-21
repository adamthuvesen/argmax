import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useRestoreFocus } from "../hooks/useRestoreFocus.js";
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

  useRestoreFocus(open);

  // Document-level Esc + focus trap. Esc must fire even if focus drifts out
  // of the dialog (Cancel button blur, mouse click on the overlay edge).
  // Tab cycles within the dialog's focusable elements. (audit-2026-05-17 H15)
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    function onKey(event: globalThis.KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey && (active === first || !dialogRef.current.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialogRef.current.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

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
      ref={dialogRef}
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
          onKeyDown={(event) => {
            // Cmd/Ctrl+Enter commits from the message textarea — plain Enter
            // stays a newline so multi-line commit messages still work.
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              if (submitDisabled) return;
              void handleSubmit();
            }
          }}
          rows={4}
          placeholder="type(scope): lowercase imperative"
          autoFocus
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
