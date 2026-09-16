import { useEffect, useRef, useState, type JSX } from "react";
import { createPortal } from "react-dom";
import type { ProjectSummary } from "../../../shared/types.js";
import { useMotionPresence } from "../../hooks/useMotionPresence.js";
import { useRestoreFocus } from "../../hooks/useRestoreFocus.js";
import { readStoredLaunchModel } from "../../lib/launchModelPreference.js";
import { factoryLaunchModel, type ModelPickerSelection } from "../../lib/models.js";
import { showArcPage } from "../../state/overlays.js";
import { showErrorToast } from "../../state/toast.js";
import { LaunchModelSelector } from "../ModelSelector.js";
import { SettingsListPicker } from "../settings/settingsPrimitives.js";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function NewArcDialog({
  open,
  onClose,
  projects
}: {
  open: boolean;
  onClose: () => void;
  projects: ProjectSummary[];
}): JSX.Element | null {
  const [name, setName] = useState("");
  const [brief, setBrief] = useState("");
  const [homeProjectId, setHomeProjectId] = useState<string>(projects[0]?.id ?? "");
  const [folder, setFolder] = useState("");
  const [folderOpen, setFolderOpen] = useState(false);
  const [model, setModel] = useState<ModelPickerSelection>(() => readStoredLaunchModel() ?? factoryLaunchModel());
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [effortPickerOpen, setEffortPickerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const motion = useMotionPresence(open);

  // Reset to a clean draft every time the dialog re-opens.
  useEffect(() => {
    if (!open) return;
    setName("");
    setBrief("");
    setHomeProjectId(projects[0]?.id ?? "");
    setFolder("");
    setFolderOpen(false);
    setModel(readStoredLaunchModel() ?? factoryLaunchModel());
    setSubmitting(false);
    setError(null);
    // Only the open edge should reset the draft — projects can refresh mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useRestoreFocus(open);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    function onKey(event: globalThis.KeyboardEvent): void {
      if (event.key === "Escape") {
        if (submitting) return;
        event.preventDefault();
        onClose();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose, submitting]);

  if (!motion.present) return null;

  const trimmedName = name.trim();
  const submitDisabled = submitting || trimmedName.length === 0 || homeProjectId.length === 0;

  const handleSubmit = async (): Promise<void> => {
    if (submitDisabled || !window.argmax) return;
    setSubmitting(true);
    setError(null);
    try {
      const arc = await window.argmax.arcs.create({
        name: trimmedName,
        brief: brief.trim(),
        homeProjectId,
        dir: folder.trim() ? folder.trim() : null
      });
      onClose();
      showArcPage(arc.id);
      try {
        await window.argmax.arcs.launchCoordinator({
          arcId: arc.id,
          provider: model.provider,
          modelLabel: model.label,
          modelId: model.modelId,
          ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {})
        });
      } catch (launchError) {
        // The arc still exists — the page shows "Start coordinator" for a
        // retry, so a launch failure is a toast rather than a blocked dialog.
        showErrorToast(errorMessage(launchError, "The arc was created, but its coordinator could not start."));
      }
    } catch (createError) {
      setError(errorMessage(createError, "Could not create the arc."));
    } finally {
      setSubmitting(false);
    }
  };

  const projectOptions = projects.map((candidate) => ({ value: candidate.id, label: candidate.name }));

  return createPortal(
    <div
      className="new-arc-dialog-overlay motion-modal-overlay"
      data-motion-state={motion.motionState}
      role="dialog"
      aria-label="New arc"
      aria-modal="true"
      aria-hidden={open ? undefined : true}
      ref={dialogRef}
      onAnimationEnd={motion.onMotionEnd}
      onMouseDown={(event) => {
        if (!submitting && event.target === event.currentTarget) onClose();
      }}
      tabIndex={-1}
    >
      <form
        className="new-arc-dialog motion-modal-surface"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit();
        }}
      >
        <header className="new-arc-dialog-header">
          <h2>New arc</h2>
          <button type="button" aria-label="Close" onClick={onClose} disabled={submitting}>
            ×
          </button>
        </header>

        <div className="sched-field">
          <label className="sched-label" htmlFor="new-arc-name">
            Name
          </label>
          <input
            id="new-arc-name"
            className="sched-input"
            value={name}
            autoFocus
            autoComplete="off"
            placeholder="Q3 pricing rollout"
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        <div className="sched-field">
          <label className="sched-label" htmlFor="new-arc-brief">
            Brief
          </label>
          <textarea
            id="new-arc-brief"
            className="sched-input sched-textarea"
            rows={4}
            value={brief}
            placeholder="What this arc is for, and what done looks like. Optional — you can fill this in later."
            onChange={(event) => setBrief(event.target.value)}
          />
        </div>

        <div className="sched-field sched-field-inline">
          <span className="sched-label">Home project</span>
          <div className="sched-picker">
            <SettingsListPicker
              ariaLabel="Home project"
              value={homeProjectId}
              onChange={setHomeProjectId}
              options={
                projectOptions.length > 0
                  ? projectOptions
                  : [{ value: "", label: "No projects registered" }]
              }
              disabled={projectOptions.length === 0}
            />
          </div>
        </div>

        <div className="sched-field sched-field-inline">
          <span className="sched-label">Coordinator model</span>
          <LaunchModelSelector
            ariaLabel="Coordinator model"
            open={modelPickerOpen}
            onOpenChange={setModelPickerOpen}
            withEffortSlider
            effortOpen={effortPickerOpen}
            onEffortOpenChange={setEffortPickerOpen}
            value={model}
            onChange={setModel}
          />
        </div>

        <details
          className="new-arc-folder-details"
          open={folderOpen}
          onToggle={(event) => setFolderOpen(event.currentTarget.open)}
        >
          <summary>Advanced: use an existing folder</summary>
          <div className="sched-field">
            <label className="sched-label" htmlFor="new-arc-folder">
              Folder
            </label>
            <input
              id="new-arc-folder"
              className="sched-input sched-input-mono"
              value={folder}
              autoComplete="off"
              placeholder="/absolute/path/to/existing/folder"
              onChange={(event) => setFolder(event.target.value)}
            />
            <p className="sched-help">
              Must already exist. Left blank, Argmax creates and owns a new folder for this arc.
            </p>
          </div>
        </details>

        {error ? (
          <p className="new-arc-dialog-error" role="alert">
            {error}
          </p>
        ) : null}

        <footer className="new-arc-dialog-actions">
          <button type="button" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className="new-arc-dialog-submit" disabled={submitDisabled}>
            {submitting ? "Creating…" : "Create arc"}
          </button>
        </footer>
      </form>
    </div>,
    document.body
  );
}
