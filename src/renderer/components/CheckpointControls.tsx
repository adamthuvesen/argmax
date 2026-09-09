import "../styles/checkpoints.css";
import { useCallback, useEffect, useId, useRef, useState, type JSX } from "react";
import { History, RotateCcw, Save } from "lucide-react";
import type { Checkpoint, RewindPreview, SessionSummary, WorkspaceSummary } from "../../shared/types.js";

export function CheckpointControls({ session, workspace, onRestored }: {
  session: SessionSummary;
  workspace: WorkspaceSummary;
  onRestored: () => void;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [preview, setPreview] = useState<RewindPreview | null>(null);
  const [label, setLabel] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const busy = useRef(false);
  const listRevision = useRef(0);
  const actionRevision = useRef(0);
  const bodyId = useId();
  const active = session.state === "running" || session.state === "waiting" || session.state === "blocked";

  const refresh = useCallback(async (): Promise<void> => {
    const api = window.argmax?.checkpoints;
    if (!api) return;
    const request = ++listRevision.current;
    try {
      const rows = await api.list({ workspaceId: workspace.id, limit: 50 });
      if (request === listRevision.current) {
        setCheckpoints(rows);
        setError(null);
      }
    } catch (failure) {
      if (request === listRevision.current) setError(failure instanceof Error ? failure.message : "Could not load checkpoints.");
    }
  }, [workspace.id]);

  useEffect(() => {
    if (!open) return;
    void refresh();
    return () => { listRevision.current += 1; };
  }, [open, refresh, session.state]);

  useEffect(() => {
    actionRevision.current += 1;
    busy.current = false;
    setPending(false);
    setPreview(null);
    setError(null);
    setNotice(null);
  }, [workspace.id, session.id]);

  useEffect(() => () => { actionRevision.current += 1; }, []);

  const run = async (action: (isCurrent: () => boolean) => Promise<void>): Promise<void> => {
    if (busy.current) return;
    busy.current = true;
    const request = ++actionRevision.current;
    const isCurrent = (): boolean => request === actionRevision.current;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await action(isCurrent);
    } catch (failure) {
      if (isCurrent()) {
        setPreview(null);
        setError(failure instanceof Error ? failure.message : "Checkpoint operation failed.");
      }
    } finally {
      if (isCurrent()) { busy.current = false; setPending(false); }
    }
  };

  if (workspace.kind !== "git" || !window.argmax?.checkpoints) return null;

  return (
    <section className="checkpoint-controls" aria-label="Checkpoints">
      <button type="button" className="checkpoint-toggle" disabled={pending} aria-expanded={open} aria-controls={bodyId} onClick={() => {
        if (open) {
          actionRevision.current += 1;
          setPreview(null);
        }
        setOpen(!open);
      }}>
        <History size={14} /> Checkpoints
      </button>
      {open && <div id={bodyId} className="checkpoint-body">
        <p className="checkpoint-help">Save and restore tracked files, non-ignored new files, and staging. Ignored files and external actions are excluded.</p>
        <form className="checkpoint-create" onSubmit={(event) => {
          event.preventDefault();
          void run(async (isCurrent) => {
            await window.argmax!.checkpoints.create({
              workspaceId: workspace.id, sessionId: session.id,
              label: label.trim() || "Manual checkpoint", turnBoundary: null, providerConversationId: null
            });
            if (!isCurrent()) return;
            setLabel("");
            setNotice("Checkpoint saved.");
            await refresh();
          });
        }}>
          <input aria-label="Checkpoint label" placeholder="Checkpoint label" value={label} onChange={(event) => setLabel(event.target.value)} disabled={pending} />
          <button type="submit" disabled={pending || active}><Save size={14} /> Save checkpoint</button>
        </form>
        {active && <p className="checkpoint-help">Wait for the current work to stop before saving or restoring.</p>}
        {error && <p role="alert" className="checkpoint-error">{error}</p>}
        {notice && <p role="status" className="checkpoint-notice">{notice}</p>}
        {!preview && <ul className="checkpoint-list">
          {checkpoints.map((checkpoint) => <li key={checkpoint.id}>
            <span><strong>{checkpoint.label}</strong><time dateTime={checkpoint.createdAt}>{new Date(checkpoint.createdAt).toLocaleString()}</time></span>
            <button type="button" disabled={pending || active || !checkpoint.worktreeTree} aria-label={`Preview rewind to ${checkpoint.label}`} onClick={() => void run(async (isCurrent) => {
              const nextPreview = await window.argmax!.checkpoints.previewRewind({ workspaceId: workspace.id, checkpointId: checkpoint.id });
              if (isCurrent()) setPreview(nextPreview);
            })}>Preview</button>
          </li>)}
          {checkpoints.length === 0 && <li className="checkpoint-help">No checkpoints saved yet.</li>}
        </ul>}
        {preview && <div className="checkpoint-preview" role="region" aria-label="Rewind preview">
          <strong>Restore files to {preview.checkpoint.label}</strong>
          <p>A recovery checkpoint will preserve the current files and staging. This action does not rewind the conversation.</p>
          <ul>{preview.changedPaths.map((path) => <li key={path}>{path}</li>)}{preview.deletedPaths.filter((path) => !preview.changedPaths.includes(path)).map((path) => <li key={path}>{path} (remove)</li>)}</ul>
          {preview.changedPaths.length === 0 && preview.deletedPaths.length === 0 && <p>No working-file changes. Staging will also be restored.</p>}
          <div className="checkpoint-actions">
            <button type="button" disabled={pending} onClick={() => setPreview(null)}>Cancel</button>
            <button type="button" disabled={pending || active} onClick={() => void run(async (isCurrent) => {
              const result = await window.argmax!.checkpoints.rewindFiles({
                workspaceId: workspace.id, checkpointId: preview.checkpoint.id, expectedFingerprint: preview.currentFingerprint
              });
              if (!isCurrent()) return;
              setPreview(null);
              setNotice(`Files restored. Recovery checkpoint: ${result.recoveryCheckpoint.label}.`);
              onRestored();
              await refresh();
            })}><RotateCcw size={14} /> Restore files</button>
          </div>
        </div>}
      </div>}
    </section>
  );
}
