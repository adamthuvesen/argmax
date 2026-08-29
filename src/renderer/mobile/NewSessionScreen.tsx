import { ChevronLeft } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import {
  DEFAULT_REASONING_EFFORT,
  PROVIDER_MODEL_DEFAULTS,
  PROVIDER_TITLE_MODEL
} from "../../shared/providerModels.js";
import type { ProjectSummary, ProviderId } from "../../shared/types.js";
import { allModelOptions, providerModelKey, type ModelPickerOption } from "../lib/models.js";
import { PROVIDER_SETUP, PROVIDER_SETUP_ORDER } from "../lib/providerSetup.js";
import { titleFromPrompt } from "../lib/projects.js";
import {
  readStoredWorkspaceMode,
  writeWorkspaceMode,
  type WorkspaceMode
} from "../lib/workspaceMode.js";

/** The launch model for a project: its configured default, falling back to the
 *  provider default when the project leaves the model unset. */
function projectLaunchModel(project: ProjectSummary): ModelPickerOption {
  const provider = project.settings.defaultProvider;
  const configured = allModelOptions.find(
    (option) => option.provider === provider && option.modelId === project.settings.defaultModelId
  );
  if (configured) return configured;
  const fallback = PROVIDER_MODEL_DEFAULTS[provider];
  return {
    provider,
    label: fallback.label,
    modelId: fallback.modelId,
    supportsReasoningEffort: Boolean(fallback.supportsReasoningEffort),
    ...(fallback.supportsReasoningEffort ? { reasoningEffort: DEFAULT_REASONING_EFFORT } : {})
  };
}

export function NewSessionScreen({
  projects,
  onClose,
  onLaunched,
  onError
}: {
  projects: ProjectSummary[];
  onClose: () => void;
  /** Called with the new workspace id after refresh-worthy state exists. */
  onLaunched: (workspaceId: string) => Promise<void>;
  onError: (message: string) => void;
}): JSX.Element {
  const [projectId, setProjectId] = useState(() => projects[0]?.id ?? "");
  const [prompt, setPrompt] = useState("");
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(readStoredWorkspaceMode);
  const [launching, setLaunching] = useState(false);

  const project = useMemo(
    () => projects.find((candidate) => candidate.id === projectId) ?? projects[0] ?? null,
    [projectId, projects]
  );

  // null = follow the project's default model; switching projects resets to it.
  const [modelKey, setModelKey] = useState<string | null>(null);
  useEffect(() => {
    setModelKey(null);
  }, [projectId]);
  const model = useMemo(() => {
    if (modelKey) {
      const chosen = allModelOptions.find((option) => providerModelKey(option) === modelKey);
      if (chosen) return chosen;
    }
    return project ? projectLaunchModel(project) : null;
  }, [modelKey, project]);

  const chooseWorkspaceMode = useCallback((mode: WorkspaceMode): void => {
    setWorkspaceMode(mode);
    writeWorkspaceMode(mode);
  }, []);

  const launch = useCallback(async (): Promise<void> => {
    if (!window.argmax || !project || !model || launching) return;
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

  return (
    <div className="mobile-new-screen">
      <header className="mobile-session-header">
        <button type="button" className="mobile-back" onClick={onClose} aria-label="Back to sessions">
          <ChevronLeft size={22} aria-hidden />
        </button>
        <span className="mobile-session-header-title">New session</span>
        <span className="mobile-header-spacer" aria-hidden />
      </header>

      {projects.length === 0 ? (
        <div className="mobile-empty">
          <p>No projects registered.</p>
          <p className="mobile-empty-detail">Add a project in the desktop app first.</p>
        </div>
      ) : (
        <div className="mobile-new-form">
          <label className="mobile-new-label" htmlFor="mobile-new-project">
            Project
          </label>
          <select
            id="mobile-new-project"
            className="mobile-new-select"
            value={project?.id ?? ""}
            onChange={(event) => setProjectId(event.target.value)}
          >
            {projects.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>

          <label className="mobile-new-label" htmlFor="mobile-new-prompt">
            Task
          </label>
          <textarea
            id="mobile-new-prompt"
            className="mobile-new-prompt"
            placeholder="What are we building?"
            value={prompt}
            rows={5}
            onChange={(event) => setPrompt(event.target.value)}
          />

          <div className="mobile-new-mode" role="radiogroup" aria-label="Workspace">
            <button
              type="button"
              role="radio"
              aria-checked={workspaceMode === "current"}
              className="mobile-new-mode-chip"
              onClick={() => chooseWorkspaceMode("current")}
            >
              Current branch
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={workspaceMode === "worktree"}
              className="mobile-new-mode-chip"
              onClick={() => chooseWorkspaceMode("worktree")}
            >
              Worktree
            </button>
          </div>

          {model ? (
            <>
              <label className="mobile-new-label" htmlFor="mobile-new-model">
                Model
              </label>
              <select
                id="mobile-new-model"
                className="mobile-new-select"
                value={providerModelKey(model)}
                onChange={(event) => setModelKey(event.target.value)}
              >
                {PROVIDER_SETUP_ORDER.map((provider: ProviderId) => (
                  <optgroup key={provider} label={PROVIDER_SETUP[provider].displayName}>
                    {allModelOptions
                      .filter((option) => option.provider === provider)
                      .map((option) => (
                        <option key={providerModelKey(option)} value={providerModelKey(option)}>
                          {option.label}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            </>
          ) : null}

          <button
            type="button"
            className="mobile-new-launch"
            disabled={launching || prompt.trim().length === 0}
            onClick={() => void launch()}
          >
            {launching ? "Launching…" : "Launch session"}
          </button>
        </div>
      )}
    </div>
  );
}
