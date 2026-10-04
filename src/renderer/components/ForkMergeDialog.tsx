import { useEffect, useRef, useState, type JSX } from "react";
import { createPortal } from "react-dom";
import type { ForkMergePreview } from "../../shared/types.js";
import { useRestoreFocus } from "../hooks/useRestoreFocus.js";
import { showErrorToast, showInfoToast } from "../state/toast.js";

/**
 * Preview and confirm bringing a fork's findings back to its source chat.
 *
 * The text shown is exactly what the source receives, minus the footer that
 * names the merge. Confirming sends it as the source's next message, behind
 * the turn it is running when there is one. It never merges git branches or
 * restores files; see docs/workspaces.md (Bringing findings back).
 */
export function ForkMergeDialog({
  childSessionId,
  onClose
}: {
  childSessionId: string;
  onClose: () => void;
}): JSX.Element {
  const [preview, setPreview] = useState<ForkMergePreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useRestoreFocus(true);

  useEffect(() => {
    let cancelled = false;
    if (!window.argmax) return;
    window.argmax.session
      .forkMergePreview({ sessionId: childSessionId })
      .then((next) => {
        if (!cancelled) setPreview(next);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : "Couldn't read the fork.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [childSessionId]);

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key !== "Escape" || sending) return;
      event.preventDefault();
      onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, sending]);

  const throughEventId = preview?.throughEventId ?? null;
  const canSend = preview !== null && !preview.nothingNew && throughEventId !== null && !sending;

  const send = async (): Promise<void> => {
    if (!canSend || !window.argmax || throughEventId === null) return;
    setSending(true);
    try {
      const result = await window.argmax.session.forkMerge({
        sessionId: childSessionId,
        throughEventId
      });
      showInfoToast(
        !result.merged
          ? "Those findings were already brought back."
          : result.queued
            ? `Queued for ${preview?.sourceLabel ?? "the source chat"}; it sends when that turn ends.`
            : `Sent to ${preview?.sourceLabel ?? "the source chat"}.`
      );
      onClose();
    } catch (error) {
      showErrorToast(error instanceof Error ? error.message : "Couldn't bring the findings back.");
      setSending(false);
    }
  };

  return createPortal(
    <div
      className="commit-dialog-overlay motion-modal-overlay"
      data-motion-state="open"
      role="dialog"
      aria-modal="true"
      aria-label="Bring findings back"
      onMouseDown={(event) => {
        if (!sending && event.target === event.currentTarget) onClose();
      }}
      tabIndex={-1}
    >
      <div ref={dialogRef} className="commit-dialog fork-merge-dialog motion-modal-surface">
        <header className="commit-dialog-header">
          <h2>Bring findings back</h2>
          <button type="button" aria-label="Close" onClick={onClose} disabled={sending}>
            ×
          </button>
        </header>
        {loadError ? (
          <p className="commit-dialog-empty" role="alert">
            {loadError}
          </p>
        ) : preview === null ? (
          <p className="commit-dialog-empty">Reading the fork…</p>
        ) : (
          <>
            <p className="fork-merge-summary">
              {preview.nothingNew
                ? `Nothing new to bring back to ${preview.sourceLabel}.`
                : `${preview.newMessageCount} new message${preview.newMessageCount === 1 ? "" : "s"} from this fork go to ${preview.sourceLabel} as its next message.`}
              {preview.boundaryExcerpt ? ` Forked at “${preview.boundaryExcerpt}”.` : ""}
            </p>
            {preview.childActive ? (
              <p className="fork-merge-note" role="status">
                This fork is still working, so its findings may be incomplete.
              </p>
            ) : null}
            {preview.sourceBusy ? (
              <p className="fork-merge-note" role="status">
                {preview.sourceLabel} is working. The message waits in its queue until that turn ends.
              </p>
            ) : null}
            {preview.unconfirmedMergeId ? (
              <p className="fork-merge-note" role="status">
                An earlier merge is still waiting in {preview.sourceLabel}&apos;s queue and counts as
                sent. Discard it there to bring those findings back again.
              </p>
            ) : null}
            {preview.truncated ? (
              <p className="fork-merge-note" role="status">
                Only the most recent messages are included. The message points at this fork for the rest.
              </p>
            ) : null}
            {preview.nothingNew ? null : (
              <pre className="fork-merge-text" aria-label="Message the source will receive">
                {preview.text}
              </pre>
            )}
          </>
        )}
        <footer className="commit-dialog-actions">
          <button type="button" onClick={onClose} disabled={sending}>
            {preview?.nothingNew ? "Close" : "Cancel"}
          </button>
          {preview?.nothingNew ? null : (
            <button
              type="button"
              className="commit-dialog-submit"
              disabled={!canSend}
              onClick={() => void send()}
            >
              {sending ? "Sending…" : preview?.sourceBusy ? "Queue for source" : "Send to source"}
            </button>
          )}
        </footer>
      </div>
    </div>,
    document.body
  );
}
