import { X } from "lucide-react";
import { useEffect, useRef, useState, type JSX } from "react";
import { createPortal } from "react-dom";
import type { ProjectCheck, ProjectSummary } from "../../shared/types.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
import { useMotionPresence } from "../hooks/useMotionPresence.js";
import { useRestoreFocus } from "../hooks/useRestoreFocus.js";
import { collapseHome } from "../lib/pathDisplay.js";
import "../styles/cloud-handoff.css";
import "../styles/project-check.css";

/**
 * Project check's question before a launch: the prompt reads like work for
 * another project. The suggestion is preselected, so Enter takes it; the
 * project the launcher was aimed at is one arrow key away. Escape goes back
 * to the composer with the draft untouched.
 */
export function ProjectCheckDialog({
  check,
  currentProject,
  projects,
  onStart,
  onCancel
}: {
  check: ProjectCheck;
  currentProject: ProjectSummary;
  projects: readonly ProjectSummary[];
  onStart: (projectId: string) => void;
  onCancel: () => void;
}): JSX.Element | null {
  const dialogRef = useRef<HTMLFormElement | null>(null);
  const motion = useMotionPresence(true);
  const byId = new Map(projects.map((project) => [project.id, project]));
  const suggested = check.suggestedProjectId ? byId.get(check.suggestedProjectId) : undefined;
  const runnerUp = check.runnerUpProjectId ? byId.get(check.runnerUpProjectId) : undefined;
  const options = [suggested, runnerUp, currentProject].filter(
    (project, index, all): project is ProjectSummary =>
      project !== undefined && all.findIndex((other) => other?.id === project.id) === index
  );
  const [selectedId, setSelectedId] = useState(suggested?.id ?? currentProject.id);
  const selected = byId.get(selectedId) ?? currentProject;

  useDismissOnOutsideOrEscape(dialogRef, true, onCancel, undefined, { trapFocus: true });
  useRestoreFocus(true);

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.focus();
  }, []);

  if (!motion.present || !suggested) return null;

  return createPortal(
    <div
      className="cloud-task-dialog-overlay motion-modal-overlay"
      data-motion-state={motion.motionState}
      onAnimationEnd={motion.onMotionEnd}
      role="dialog"
      aria-modal="true"
      aria-labelledby="project-check-title"
      aria-describedby="project-check-description"
    >
      <form
        ref={dialogRef}
        className="cloud-task-dialog motion-modal-surface project-check-dialog"
        tabIndex={-1}
        onSubmit={(event) => {
          event.preventDefault();
          onStart(selected.id);
        }}
        onKeyDown={(event) => {
          // A radio swallows Enter; the dialog's one decision should not.
          if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
            event.preventDefault();
            onStart(selected.id);
          }
        }}
      >
        <header className="cloud-task-dialog-header">
          <div>
            <h2 id="project-check-title">Start in {suggested.name}?</h2>
            <p id="project-check-description">
              You’re in {currentProject.name}, but this reads like {suggested.name} work.
            </p>
          </div>
          <button type="button" aria-label="Back to the prompt" onClick={onCancel}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <div className="cloud-task-dialog-body">
          {check.reasons.length > 0 ? (
            <ul className="project-check-reasons" aria-label="Why">
              {check.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : null}
          <div className="project-check-options" role="radiogroup" aria-label="Project">
            {options.map((project) => (
              <label
                key={project.id}
                className="project-check-option"
                data-checked={project.id === selectedId ? "true" : "false"}
              >
                <input
                  type="radio"
                  name="project-check-project"
                  value={project.id}
                  checked={project.id === selectedId}
                  onChange={() => setSelectedId(project.id)}
                />
                <span className="project-check-option-name">{project.name}</span>
                <span className="project-check-option-path">{collapseHome(project.repoPath)}</span>
                <span className="project-check-option-tag">
                  {project.id === suggested.id
                    ? "Suggested"
                    : project.id === currentProject.id
                      ? "Current"
                      : null}
                </span>
              </label>
            ))}
          </div>
        </div>
        <footer className="cloud-task-dialog-actions">
          <button type="button" onClick={onCancel}>
            Back
          </button>
          <button type="submit" className="cloud-task-dialog-launch">
            Start in {selected.name}
          </button>
        </footer>
      </form>
    </div>,
    document.body
  );
}
