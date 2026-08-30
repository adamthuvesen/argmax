import { ArrowUp, ChevronsUpDown, Folder, GitBranch, Zap } from "lucide-react";
import { useCallback, useMemo, useState, type JSX, type ReactNode } from "react";
import { PROVIDER_TITLE_MODEL } from "../../shared/providerModels.js";
import { BottomSheet, SheetOption } from "./BottomSheet.js";
import { MobileScreenHeader } from "./MobileScreenHeader.js";
import type { ProjectSummary, ProviderId } from "../../shared/types.js";
import { persistLaunchModel, readStoredLaunchModel } from "../lib/launchModelPreference.js";
import {
  allModelOptions,
  factoryLaunchModel,
  providerModelKey,
  type ModelPickerSelection
} from "../lib/models.js";
import { PROVIDER_SETUP, PROVIDER_SETUP_ORDER } from "../lib/providerSetup.js";
import { titleFromPrompt } from "../lib/projects.js";
import {
  readStoredWorkspaceMode,
  writeWorkspaceMode,
  type WorkspaceMode
} from "../lib/workspaceMode.js";
import { REMOTE_CONNECTION_LOST_MESSAGE } from "../lib/wsTransport.js";

/** A quiet Codex-style context row: icon + current value + up/down chevron,
 *  with an invisible button stretched over it so tapping anywhere opens the
 *  matching bottom sheet. */
function ContextRow({
  icon,
  value,
  label,
  open,
  onOpen
}: {
  icon: ReactNode;
  value: string;
  label: string;
  open: boolean;
  onOpen: () => void;
}): JSX.Element {
  return (
    <div className="mobile-new-row">
      <span className="mobile-new-row-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="mobile-new-row-value">{value}</span>
      <ChevronsUpDown size={14} className="mobile-new-row-caret" aria-hidden="true" />
      <button
        type="button"
        className="mobile-new-row-select"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={onOpen}
      />
    </div>
  );
}

export type PickerKind = "project" | "workspace" | "model";

export function NewSessionScreen({
  projects,
  onClose,
  onLaunched,
  onError,
  openSheet,
  onOpenSheetChange
}: {
  projects: ProjectSummary[];
  onClose: () => void;
  /** Called with the new workspace id after refresh-worthy state exists. */
  onLaunched: (workspaceId: string) => Promise<void>;
  onError: (message: string) => void;
  /** Which picker sheet is up. Owned by MobileApp so a back gesture can pop
   *  the sheet instead of tearing down this screen and the typed prompt. */
  openSheet: PickerKind | null;
  onOpenSheetChange: (kind: PickerKind | null) => void;
}): JSX.Element {
  const [projectId, setProjectId] = useState(() => projects[0]?.id ?? "");
  const [prompt, setPrompt] = useState("");
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(readStoredWorkspaceMode);
  const [launching, setLaunching] = useState(false);

  const project = useMemo(
    () => projects.find((candidate) => candidate.id === projectId) ?? projects[0] ?? null,
    [projectId, projects]
  );

  // Same default as the desktop launcher: the stored global preference, then
  // the factory pick (Claude Opus 5) — not the project's configured model. The
  // phone's localStorage is its own store, so the preference is per device.
  const [model, setModel] = useState<ModelPickerSelection>(
    () => readStoredLaunchModel() ?? factoryLaunchModel()
  );

  const chooseWorkspaceMode = useCallback((mode: WorkspaceMode): void => {
    setWorkspaceMode(mode);
    writeWorkspaceMode(mode);
  }, []);

  const launch = useCallback(async (): Promise<void> => {
    if (!window.argmax || !project || launching) return;
    const trimmed = prompt.trim();
    if (trimmed.length === 0) return;
    setLaunching(true);
    try {
      const taskLabel = titleFromPrompt(trimmed);
      const workspace =
        workspaceMode === "worktree"
          ? await window.argmax.workspaces.createIsolated({
              projectId: project.id,
              taskLabel,
              baseRef: project.currentBranch ?? null
            })
          : await window.argmax.workspaces.createCurrent({ projectId: project.id, taskLabel });
      try {
        await window.argmax.providers.launch({
          workspaceId: workspace.id,
          provider: model.provider,
          prompt: trimmed,
          modelLabel: model.label,
          modelId: model.modelId,
          reasoningEffort: model.reasoningEffort ?? null,
          fastMode: false,
          agentMode: "auto",
          permissionMode: "auto-approve",
          cols: 120,
          rows: 32,
          attachments: null
        });
      } catch (error) {
        // No session started, so the workspace (and its worktree) would sit
        // stranded with no explanation. A lost socket is the exception: the
        // backend may have launched fine and only the reply went missing, so
        // archiving there would kill a live session and delete its worktree.
        if (!(error instanceof Error && error.message === REMOTE_CONNECTION_LOST_MESSAGE)) {
          void window.argmax.workspaces
            .archive({ workspaceId: workspace.id, force: true })
            .catch(() => undefined);
        }
        throw error;
      }
      void window.argmax.workspaces
        .autoTitle({
          workspaceId: workspace.id,
          provider: model.provider,
          modelId: PROVIDER_TITLE_MODEL[model.provider],
          prompt: trimmed
        })
        .catch(() => undefined);
      await onLaunched(workspace.id);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Launching the session failed.");
      setLaunching(false);
    }
  }, [launching, model, onError, onLaunched, project, prompt, workspaceMode]);

  const modelValue = `${PROVIDER_SETUP[model.provider].displayName} · ${model.label}`;
  const workspaceValue =
    workspaceMode === "worktree"
      ? "New worktree"
      : `Current branch · ${project?.currentBranch ?? "main"}`;

  return (
    <div className="mobile-new-screen">
      <MobileScreenHeader onBack={onClose} backLabel="Back to sessions" title="New session" />

      {projects.length === 0 ? (
        <div className="mobile-empty">
          <p>No projects registered.</p>
          <p className="mobile-empty-detail">Add a project in the desktop app first.</p>
        </div>
      ) : (
        <div className="mobile-new-body">
          {/* Context rows sit directly above the composer, Codex-style: the
              empty space above stays quiet and the thumb reaches everything.
              Each row opens a bottom sheet — native selects anchor to the row
              near the bottom edge on iOS and clip off-screen. */}
          <div className="mobile-new-context">
            <ContextRow
              icon={<Folder size={16} />}
              value={project?.name ?? ""}
              label="Project"
              open={openSheet === "project"}
              onOpen={() => onOpenSheetChange("project")}
            />
            <ContextRow
              icon={<GitBranch size={16} />}
              value={workspaceValue}
              label="Workspace"
              open={openSheet === "workspace"}
              onOpen={() => onOpenSheetChange("workspace")}
            />
            <ContextRow
              icon={<Zap size={16} />}
              value={modelValue}
              label="Model"
              open={openSheet === "model"}
              onOpen={() => onOpenSheetChange("model")}
            />
          </div>

          <div className="mobile-new-composer">
            <textarea
              className="mobile-new-prompt"
              aria-label="Task"
              placeholder="What are we building?"
              value={prompt}
              rows={2}
              // The screen opens from a deliberate "+" tap, so raising the
              // keyboard immediately is the expected next step, not a theft.
              autoFocus
              onChange={(event) => setPrompt(event.target.value)}
            />
            <button
              type="button"
              className="mobile-new-send"
              aria-label="Launch session"
              disabled={launching || prompt.trim().length === 0}
              onClick={() => void launch()}
            >
              <ArrowUp size={18} aria-hidden="true" />
            </button>
          </div>
        </div>
      )}

      {openSheet === "project" ? (
        <BottomSheet label="Choose project" onClose={() => onOpenSheetChange(null)}>
          <div className="mobile-sheet-group">
            {projects.map((candidate) => (
              <SheetOption
                key={candidate.id}
                label={candidate.name}
                selected={candidate.id === project?.id}
                onSelect={() => {
                  setProjectId(candidate.id);
                  onOpenSheetChange(null);
                }}
              />
            ))}
          </div>
        </BottomSheet>
      ) : null}

      {openSheet === "workspace" ? (
        <BottomSheet label="Choose workspace" onClose={() => onOpenSheetChange(null)}>
          <div className="mobile-sheet-group">
            <SheetOption
              label={`Current branch${project?.currentBranch ? ` (${project.currentBranch})` : ""}`}
              selected={workspaceMode === "current"}
              onSelect={() => {
                chooseWorkspaceMode("current");
                onOpenSheetChange(null);
              }}
            />
            <SheetOption
              label="New worktree"
              selected={workspaceMode === "worktree"}
              onSelect={() => {
                chooseWorkspaceMode("worktree");
                onOpenSheetChange(null);
              }}
            />
          </div>
        </BottomSheet>
      ) : null}

      {openSheet === "model" ? (
        <BottomSheet label="Choose model" onClose={() => onOpenSheetChange(null)}>
          {PROVIDER_SETUP_ORDER.map((provider: ProviderId) => (
            <div key={provider} className="mobile-sheet-group">
              <p className="mobile-sheet-group-label">{PROVIDER_SETUP[provider].displayName}</p>
              {allModelOptions
                .filter((option) => option.provider === provider)
                .map((option) => {
                  const key = providerModelKey(option);
                  return (
                    <SheetOption
                      key={key}
                      label={option.label}
                      selected={key === providerModelKey(model)}
                      onSelect={() => {
                        setModel(option);
                        persistLaunchModel(option);
                        onOpenSheetChange(null);
                      }}
                    />
                  );
                })}
            </div>
          ))}
        </BottomSheet>
      ) : null}
    </div>
  );
}
