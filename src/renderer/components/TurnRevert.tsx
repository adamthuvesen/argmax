import { useState, type JSX } from "react";
import { Undo2 } from "lucide-react";
import type { RewindPreview } from "../../shared/types.js";

/**
 * "Revert to here" on a finished turn: restores the checkout to the
 * before-turn checkpoint taken when this turn was launched.
 *
 * Files only. No provider CLI can resume a conversation from an earlier
 * message — each one takes an opaque conversation id and continues from its
 * end — so rewinding the transcript would be a promise the backend cannot
 * keep, the same reason Fork does not claim to fork "from here". The
 * conversation stays as the record of what was tried, which is usually what
 * you want to read while deciding what to do next.
 *
 * Two steps on purpose: the first click prices the change (which files, how
 * many), and only the confirm commits it.
 */
export function TurnRevert({ workspaceId, checkpointId, unavailableReason, disabled, onReverted }: {
  workspaceId: string;
  checkpointId?: string;
  /** Set when the before-turn checkpoint was skipped; shown on click. */
  unavailableReason?: string;
  /** A turn is still running: the checkout is moving under us. */
  disabled?: boolean;
  onReverted: () => void;
}): JSX.Element {
  const [preview, setPreview] = useState<RewindPreview | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<void>): Promise<void> => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setPreview(null);
      setError(failure instanceof Error ? failure.message : "Could not revert this turn.");
    } finally {
      setPending(false);
    }
  };

  const paths = preview
    ? preview.changedPaths.length +
      preview.deletedPaths.filter((path) => !preview.changedPaths.includes(path)).length
    : 0;

  return (
    <>
      <button
        type="button"
        className="turn-block-footer-action"
        aria-label="Revert to here"
        title="Revert to here — restore the files to before this turn"
        disabled={disabled || pending}
        onClick={() => void run(async () => {
          if (unavailableReason) {
            setError(unavailableReason);
            return;
          }
          if (!checkpointId) {
            return;
          }
          setPreview(await window.argmax!.checkpoints.previewRewind({ workspaceId, checkpointId }));
        })}
      >
        <Undo2 size={13} aria-hidden />
      </button>
      {(preview || error) && (
        <div className="turn-revert-confirm" role="region" aria-label="Revert to here">
          {error ? (
            <p className="turn-revert-error" role="alert">{error}</p>
          ) : (
            <p className="turn-revert-summary">
              {paths === 0
                ? "No working files change. Staging is restored."
                : `Restores ${paths} ${paths === 1 ? "file" : "files"} to before this turn. The conversation stays.`}
            </p>
          )}
          <div className="turn-revert-actions">
            <button type="button" className="turn-revert-button" disabled={pending} onClick={() => { setPreview(null); setError(null); }}>
              Cancel
            </button>
            {preview && (
              <button
                type="button"
                className="turn-revert-button turn-revert-button-commit"
                disabled={pending}
                onClick={() => void run(async () => {
                  await window.argmax!.checkpoints.rewindFiles({
                    workspaceId,
                    checkpointId: preview.checkpoint.id,
                    expectedFingerprint: preview.currentFingerprint
                  });
                  setPreview(null);
                  onReverted();
                })}
              >
                Revert files
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
