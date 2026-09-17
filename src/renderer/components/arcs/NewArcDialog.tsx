import { Bot, Folder, TriangleAlert, X } from "lucide-react";
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
import { WorkingNest } from "../WorkingNest.js";
import { SettingsListPicker } from "../settings/settingsPrimitives.js";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/** The chat an arc is being started from, when the dialog runs in that mode. */
export interface ArcPromoteSource {
  sessionId: string;
  chatLabel: string;
  projectName: string;
  /** The chat runs in its own worktree, which an archive would take away. */
  isolated: boolean;
  /** Sessions this chat launched that will join the arc with it. */
  adoptableCount: number;
}

type DraftState = "drafting" | "drafted" | "failed" | null;

export function NewArcDialog({
  open,
  onClose,
  projects,
  promote = null
}: {
  open: boolean;
  onClose: () => void;
  projects: ProjectSummary[];
  promote?: ArcPromoteSource | null;
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
  const [draftState, setDraftState] = useState<DraftState>(null);
  // A drafted value only fills a field the person has not typed into.
  const nameTouched = useRef(false);
  const briefTouched = useRef(false);
  const motion = useMotionPresence(open);
  const promoteSessionId = promote?.sessionId ?? null;

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
    nameTouched.current = false;
    briefTouched.current = false;
    setDraftState(null);
    // Only the open edge should reset the draft — projects can refresh mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || !promoteSessionId || !window.argmax) return;
    let cancelled = false;
    setDraftState("drafting");
    void window.argmax.arcs
      .draftFromSession({ sessionId: promoteSessionId })
      .then((draft) => {
        if (cancelled) return;
        if (draft.name === null || draft.brief === null) {
          setDraftState("failed");
          return;
        }
        if (!nameTouched.current) setName(draft.name);
        if (!briefTouched.current) setBrief(draft.brief);
        setDraftState("drafted");
      })
      .catch(() => {
        if (!cancelled) setDraftState("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [open, promoteSessionId]);

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
  // A brief is required unless an existing folder may already carry BRIEF.md;
  // the backend makes the final call on that folder.
  const briefMissing = brief.trim().length === 0 && folder.trim().length === 0;
  const submitDisabled =
    submitting || trimmedName.length === 0 || (!promote && homeProjectId.length === 0) || briefMissing;

  const handlePromote = async (source: ArcPromoteSource): Promise<void> => {
    if (!window.argmax) return;
    setSubmitting(true);
    setError(null);
    try {
      await window.argmax.arcs.promote({
        sessionId: source.sessionId,
        name: trimmedName,
        brief: brief.trim(),
        dir: folder.trim() ? folder.trim() : null
      });
      onClose();
    } catch (promoteError) {
      const message = errorMessage(promoteError, "Could not start the arc.");
      // The arc exists but the chat was not told; the sidebar already shows
      // it, so the dialog has nothing left to retry.
      if (message.startsWith("The arc was created")) {
        onClose();
        showErrorToast(message);
      } else {
        setError(message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = async (): Promise<void> => {
    if (submitDisabled || !window.argmax) return;
    if (promote) {
      await handlePromote(promote);
      return;
    }
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
          reasoningEffort: model.reasoningEffort ?? null
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
      aria-label={promote ? "Start an arc from this chat" : "New arc"}
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
        className={`new-arc-dialog motion-modal-surface${promote ? "" : " new-arc-dialog-chips"}`}
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit();
        }}
      >
        <header className="new-arc-dialog-header">
          <h2>{promote ? "Start an arc from this chat" : "New arc"}</h2>
          <button type="button" className="small-icon" aria-label="Close" onClick={onClose} disabled={submitting}>
            <X size={15} aria-hidden="true" />
          </button>
        </header>

        <div className="new-arc-dialog-body">
        {promote ? (
          <div className="new-arc-promote-intro">
            <p>
              This chat becomes the arc&rsquo;s coordinator. It keeps its history and model, and from here on it plans
              and delegates instead of doing the work itself.
            </p>
            <ul className="new-arc-promote-facts">
              <li>
                <Folder size={13} aria-hidden="true" />
                <span>
                  Home project <strong>{promote.projectName}</strong>
                </span>
              </li>
              {promote.adoptableCount > 0 ? (
                <li>
                  <Bot size={13} aria-hidden="true" />
                  <span>
                    {promote.adoptableCount === 1
                      ? "The chat it launched joins the arc"
                      : `The ${promote.adoptableCount} chats it launched join the arc`}
                  </span>
                </li>
              ) : null}
              {promote.isolated ? (
                <li data-tone="warning">
                  <TriangleAlert size={13} aria-hidden="true" />
                  <span>
                    It runs in its own worktree, so archiving that worktree ends the coordinator. You can start a new
                    one from the arc page.
                  </span>
                </li>
              ) : null}
            </ul>
          </div>
        ) : null}

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
            placeholder={draftState === "drafting" ? "Drafting…" : "Q3 pricing rollout"}
            onChange={(event) => {
              nameTouched.current = true;
              setName(event.target.value);
            }}
          />
        </div>

        <div className="sched-field">
          <div className="new-arc-label-row">
            <label className="sched-label" htmlFor="new-arc-brief">
              Brief
            </label>
            {draftState === "drafting" ? (
              <span className="new-arc-draft-status" role="status">
                <WorkingNest active size={11} /> Drafting from this chat…
              </span>
            ) : draftState === "drafted" ? (
              <span className="new-arc-draft-status" role="status">
                Drafted from this chat
              </span>
            ) : draftState === "failed" ? (
              <span className="new-arc-draft-status" role="status">
                Couldn&rsquo;t draft one, so write it yourself
              </span>
            ) : null}
          </div>
          <textarea
            id="new-arc-brief"
            className="sched-input sched-textarea"
            rows={promote ? 8 : 4}
            value={brief}
            placeholder={
              draftState === "drafting" ? "Reading the conversation…" : "What this arc is for, and what done looks like."
            }
            onChange={(event) => {
              briefTouched.current = true;
              setBrief(event.target.value);
            }}
          />
          {brief.trim().length === 0 && draftState !== "drafting" ? (
            <p className="sched-help" id="new-arc-brief-help">
              Required unless the folder below already has a BRIEF.md.
            </p>
          ) : null}
        </div>

        {promote ? null : (
          <>
        <div className="sched-field sched-field-inline">
          <span className="sched-label">Home project</span>
          <div className="sched-picker">
            <SettingsListPicker
              ariaLabel="Home project"
              icon={<Folder size={14} aria-hidden="true" />}
              portaled
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
          <div className="sched-picker">
            <LaunchModelSelector
              ariaLabel="Coordinator model"
              open={modelPickerOpen}
              onOpenChange={setModelPickerOpen}
              portaled
              withEffortSlider
              effortOpen={effortPickerOpen}
              onEffortOpenChange={setEffortPickerOpen}
              value={model}
              onChange={setModel}
            />
          </div>
        </div>
          </>
        )}

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
              Must already exist. If it has a BRIEF.md, leave the brief above empty to use it. Left blank,
              Argmax creates and owns a new folder for this arc.
            </p>
          </div>
        </details>

        {error ? (
          <p className="new-arc-dialog-error" role="alert">
            {error}
          </p>
        ) : null}
        </div>

        <footer className="new-arc-dialog-actions">
          <button type="button" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className="new-arc-dialog-submit" disabled={submitDisabled}>
            {submitting ? (promote ? "Starting…" : "Creating…") : promote ? "Start arc" : "Create arc"}
          </button>
        </footer>
      </form>
    </div>,
    document.body
  );
}
