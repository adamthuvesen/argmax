import { useEffect, useMemo, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ChangedFileSummary, CommitPreparation, PrepareCommitInput } from "../../shared/types.js";

export function CommitDialog({
  open,
  onClose,
  workspaceId,
  files,
  defaultMessage,
  onPrepareCommit
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  files: ChangedFileSummary[];
  defaultMessage: string;
  onPrepareCommit: (input: PrepareCommitInput) => Promise<CommitPreparation>;
}): JSX.Element | null {
  const allPaths = useMemo(() => files.map((file) => file.path), [files]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(allPaths));
  const [message, setMessage] = useState<string>(defaultMessage);
  const [prepared, setPrepared] = useState<CommitPreparation | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);

  // Reset state every time the dialog re-opens so the user always starts from
  // the freshest changed-file list and the default message.
  useEffect(() => {
    if (!open) return;
    setSelected(new Set(allPaths));
    setMessage(defaultMessage);
    setPrepared(null);
    setSubmitting(false);
  }, [open, allPaths, defaultMessage]);

  if (!open) return null;

  const allSelected = allPaths.length > 0 && selected.size === allPaths.length;
  const submitDisabled = submitting || selected.size === 0 || message.trim().length === 0;

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
    if (submitDisabled) return;
    setSubmitting(true);
    try {
      const result = await onPrepareCommit({
        workspaceId,
        selectedFiles: Array.from(selected),
        message: message.trim()
      });
      setPrepared(result);
    } catch {
      // The parent shows an error toast — keep the dialog open so the user can
      // adjust the message or file selection without retyping everything.
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

        {prepared ? (
          <section className="commit-dialog-prepared" aria-label="Prepared commit plan">
            <p className="commit-dialog-prepared-title">Prepared plan</p>
            <p className="commit-dialog-prepared-branch">
              Branch <code>{prepared.branch}</code>
            </p>
            <ol className="commit-dialog-prepared-commands">
              {prepared.commands.map((command) => (
                <li key={command}>
                  <code>{command}</code>
                </li>
              ))}
            </ol>
          </section>
        ) : null}

        <footer className="commit-dialog-actions">
          <button type="button" onClick={onClose}>
            {prepared ? "Close" : "Cancel"}
          </button>
          <button
            type="button"
            className="commit-dialog-submit"
            disabled={submitDisabled}
            onClick={() => {
              void handleSubmit();
            }}
          >
            {submitting ? "Preparing…" : prepared ? "Re-prepare" : "Commit"}
          </button>
        </footer>
      </div>
    </div>
  );
}
