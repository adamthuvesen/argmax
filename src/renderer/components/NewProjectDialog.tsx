import { X } from "lucide-react";
import { useRef, useState, type JSX } from "react";
import { createPortal } from "react-dom";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
import { useRestoreFocus } from "../hooks/useRestoreFocus.js";
import { ProjectFoldersForm, type ProjectFoldersDraft } from "./ProjectFoldersForm.js";

export function NewProjectDialog({ onClose, onCreate }: {
  onClose: () => void;
  onCreate: (draft: ProjectFoldersDraft) => Promise<void>;
}): JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  useDismissOnOutsideOrEscape(dialogRef, true, () => { if (!busy) onClose(); }, undefined, { trapFocus: true });
  useRestoreFocus(true);

  return createPortal(
    <div className="project-dialog-overlay motion-modal-overlay" data-motion-state="open">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="new-project-heading"
        className="project-dialog motion-modal-surface">
        <header className="project-dialog-header">
          <h2 id="new-project-heading">Create project</h2>
          <button type="button" className="small-icon" aria-label="Close create project" disabled={busy} onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <ProjectFoldersForm initialValue={{ name: "", folders: [], primaryPath: "" }}
          autoFocus submitLabel="Create project" onSubmit={onCreate} onCancel={onClose} onBusyChange={setBusy} />
      </div>
    </div>,
    document.body
  );
}
