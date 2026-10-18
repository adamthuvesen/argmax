import { Folder, FolderPlus, X } from "lucide-react";
import { useId, useState, type JSX, type ReactNode } from "react";
import type { CreateProjectInput } from "../../shared/types.js";
import { validationMessage } from "../../shared/validationMessage.js";
import { showErrorToast } from "../state/toast.js";

export type ProjectFoldersDraft = CreateProjectInput;

export function ProjectFoldersForm({
  initialValue,
  submitLabel,
  onSubmit,
  onCancel,
  onBusyChange,
  autoFocus = false,
  renderFolderDetails
}: {
  initialValue: ProjectFoldersDraft;
  submitLabel: string;
  onSubmit: (draft: ProjectFoldersDraft) => Promise<void>;
  onCancel?: () => void;
  onBusyChange?: (busy: boolean) => void;
  autoFocus?: boolean;
  renderFolderDetails?: (path: string) => ReactNode;
}): JSX.Element {
  const nameId = useId();
  const [name, setName] = useState(initialValue.name);
  const [folders, setFolders] = useState(initialValue.folders);
  const [primaryPath, setPrimaryPath] = useState(initialValue.primaryPath);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const dirty = name.trim() !== initialValue.name || primaryPath !== initialValue.primaryPath ||
    folders.join("\n") !== initialValue.folders.join("\n");

  function updateBusy(value: boolean): void {
    setBusy(value);
    onBusyChange?.(value);
  }

  async function addFolder(): Promise<void> {
    if (!window.argmax) return;
    updateBusy(true);
    try {
      const selected = await window.argmax.projects.pickDirectory();
      if (selected.cancelled || !selected.path) return;
      const path = selected.path;
      if (folders.includes(path)) return;
      setFolders((current) => [...current, path]);
      if (!primaryPath) setPrimaryPath(path);
      setSaved(false);
    } catch (error) {
      showErrorToast(validationMessage(error));
    } finally {
      updateBusy(false);
    }
  }

  async function save(): Promise<void> {
    if (busy || !name.trim() || !primaryPath || folders.length === 0) return;
    updateBusy(true);
    setSaved(false);
    try {
      await onSubmit({ name: name.trim(), folders, primaryPath });
      setSaved(true);
    } catch (error) {
      showErrorToast(validationMessage(error));
    } finally {
      updateBusy(false);
    }
  }

  return (
    <form className="project-folders-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <div className="settings-field">
        <label className="settings-field-label" htmlFor={nameId}>Project name</label>
        <input
          id={nameId}
          className="settings-text-input project-name-input"
          value={name}
          autoFocus={autoFocus}
          autoComplete="off"
          placeholder="AI Analytics"
          disabled={busy}
          onChange={(event) => { setName(event.target.value); setSaved(false); }}
        />
      </div>
      <div className="project-folders-intro">
        <div className="project-folders-heading">
          <h3>Folders</h3>
          <button className="settings-button" type="button" disabled={busy} onClick={() => void addFolder()}>
            <FolderPlus size={14} aria-hidden="true" /> Add folder
          </button>
        </div>
        <p className="settings-note project-folders-help">
          Chats start in the primary repository. Other folders provide context for agents.
        </p>
      </div>
      {folders.length === 0 ? (
        <div className="project-folders-empty">
          <Folder size={24} strokeWidth={1.5} aria-hidden="true" />
          <p>Add a repository to start. You can also include folders with notes or related code.</p>
        </div>
      ) : (
        <ul className="project-folders-list" aria-label="Project folders">
          {folders.map((path) => {
            const folderName = path.replace(/\/+$/, "").split("/").pop() || path;
            const primary = path === primaryPath;
            return (
              <li key={path}>
                <div className="project-folder-row">
                  <Folder size={16} aria-hidden="true" />
                  <div className="project-folder-path">
                    <strong>{folderName}</strong>
                    <span title={path}>{path}</span>
                  </div>
                  <label className="project-folder-primary-choice">
                    <input type="radio" name={`${nameId}-primary`} checked={primary} disabled={busy}
                      aria-label={`Make ${folderName} primary`}
                      onChange={() => { setPrimaryPath(path); setSaved(false); }} />
                    <span>Primary</span>
                  </label>
                  <button type="button" className="small-icon" disabled={busy}
                    aria-label={`Remove folder ${folderName}`}
                    onClick={() => {
                      const remaining = folders.filter((folder) => folder !== path);
                      setFolders(remaining);
                      if (primary) setPrimaryPath(remaining[0] ?? "");
                      setSaved(false);
                    }}>
                    <X size={14} aria-hidden="true" />
                  </button>
                </div>
                {renderFolderDetails?.(path)}
              </li>
            );
          })}
        </ul>
      )}
      <footer className="project-folders-actions">
        {saved ? <span className="settings-note" role="status">Project saved.</span> : null}
        {onCancel ? <button type="button" className="settings-button" onClick={onCancel} disabled={busy}>Cancel</button> : null}
        <button type="submit" className="settings-button project-folders-submit"
          disabled={busy || !name.trim() || !primaryPath || !dirty}>
          {busy ? "Saving…" : submitLabel}
        </button>
      </footer>
    </form>
  );
}
