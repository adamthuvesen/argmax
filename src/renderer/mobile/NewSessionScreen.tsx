import { ArrowUp, ChevronLeft, ChevronsUpDown, Folder, GitBranch, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type JSX, type ReactNode } from "react";
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

/** A quiet Codex-style context row: icon + current value + up/down chevron,
 *  with an invisible native `<select>` stretched over it so tapping anywhere
 *  opens the platform picker. */
function ContextRow({
  icon,
  value,
  select
}: {
  icon: ReactNode;
  value: string;
  select: ReactNode;
}): JSX.Element {
  return (
    <div className="mobile-new-row">
      <span className="mobile-new-row-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="mobile-new-row-value">{value}</span>
      <ChevronsUpDown size={14} className="mobile-new-row-caret" aria-hidden="true" />
      {select}
    </div>
  );
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

  const modelValue = model
    ? `${PROVIDER_SETUP[model.provider].displayName} · ${model.label}`
    : "No model";
  const workspaceValue =
    workspaceMode === "worktree"
      ? "New worktree"
      : `Current branch · ${project?.currentBranch ?? "main"}`;

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
        <div className="mobile-new-body">
          {/* Context rows sit directly above the composer, Codex-style: the
              empty space above stays quiet and the thumb reaches everything. */}
          <div className="mobile-new-context">
            <ContextRow
              icon={<Folder size={16} />}
              value={project?.name ?? ""}
              select={
                <select
                  className="mobile-new-row-select"
                  aria-label="Project"
                  value={project?.id ?? ""}
                  onChange={(event) => setProjectId(event.target.value)}
                >
                  {projects.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </option>
                  ))}
                </select>
              }
            />
            <ContextRow
              icon={<GitBranch size={16} />}
              value={workspaceValue}
              select={
                <select
                  className="mobile-new-row-select"
                  aria-label="Workspace"
                  value={workspaceMode}
                  onChange={(event) => chooseWorkspaceMode(event.target.value as WorkspaceMode)}
                >
                  <option value="current">
                    Current branch{project?.currentBranch ? ` (${project.currentBranch})` : ""}
                  </option>
                  <option value="worktree">New worktree</option>
                </select>
              }
            />
            <ContextRow
              icon={<Zap size={16} />}
              value={modelValue}
              select={
                model ? (
                  <select
                    className="mobile-new-row-select"
                    aria-label="Model"
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
                ) : null
              }
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
    </div>
  );
}
