import { useCallback, useMemo, useState, type JSX } from "react";
import type { ProjectSummary } from "../../../shared/types.js";
import {
  allModelOptions,
  modelDefaultForProvider,
  type ModelPickerSelection
} from "../../lib/models.js";
import { CombinedModelSelector } from "../ModelSelector.js";
import { SettingGroup, SettingRow, SettingsListPicker } from "./settingsPrimitives.js";

/**
 * Per-project settings editor (Settings → Projects). Every field here is
 * consumed by the runtime: worktree location places isolated worktrees, the
 * setup command runs once in each fresh worktree before the agent launches,
 * check commands run from the changed-files card, and the default agent/model
 * seeds sessions Argmax launches on its own (e.g. PR check-failure fixes).
 */
export function ProjectsSettings({
  projects,
  onProjectUpdated
}: {
  projects: ProjectSummary[];
  onProjectUpdated: (updated: ProjectSummary) => void;
}): JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(projects[0]?.id ?? null);
  const selected = projects.find((project) => project.id === selectedId) ?? projects[0] ?? null;

  return (
    <SettingGroup id="settings-project-config" label="Project settings" card={false}>
      {selected === null ? (
        <div className="settings-card">
          <p className="settings-note">No projects registered yet. Add a project from the sidebar first.</p>
        </div>
      ) : (
        <>
          {projects.length > 1 ? (
            <div className="settings-card">
              <SettingRow
                label="Project"
                htmlFor="settings-project-picker"
                control={
                  <SettingsListPicker
                    ariaLabel="Project"
                    inputId="settings-project-picker"
                    value={selected.id}
                    onChange={setSelectedId}
                    options={projects.map((project) => ({ value: project.id, label: project.name }))}
                  />
                }
              />
            </div>
          ) : null}
          <ProjectSettingsForm key={selected.id} project={selected} onProjectUpdated={onProjectUpdated} />
        </>
      )}
    </SettingGroup>
  );
}

/** The project's stored default model, resolved against the catalog. Falls
 *  back to the provider's default when the stored pair no longer matches. */
function storedModelSelection(project: ProjectSummary): ModelPickerSelection {
  const { defaultProvider, defaultModelId, defaultModelLabel } = project.settings;
  const matched = allModelOptions.find(
    (option) =>
      option.provider === defaultProvider &&
      (option.modelId === defaultModelId || (defaultModelId === "" && option.label === defaultModelLabel))
  );
  if (matched) {
    return { provider: matched.provider, label: matched.label, modelId: matched.modelId };
  }
  return { provider: defaultProvider, ...modelDefaultForProvider(defaultProvider) };
}

/** Keyed by project id, so switching projects remounts with fresh values. */
function ProjectSettingsForm({
  project,
  onProjectUpdated
}: {
  project: ProjectSummary;
  onProjectUpdated: (updated: ProjectSummary) => void;
}): JSX.Element {
  const [defaultModel, setDefaultModel] = useState<ModelPickerSelection>(() => storedModelSelection(project));
  const [worktreeLocation, setWorktreeLocation] = useState(project.settings.worktreeLocation);
  const [setupCommand, setSetupCommand] = useState(project.settings.setupCommand);
  const [checkCommandsText, setCheckCommandsText] = useState(project.settings.checkCommands.join("\n"));
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ kind: "saved" | "error"; message: string } | null>(null);

  const checkCommands = useMemo(
    () =>
      checkCommandsText
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    [checkCommandsText]
  );

  const dirty =
    defaultModel.provider !== project.settings.defaultProvider ||
    defaultModel.modelId !== project.settings.defaultModelId ||
    worktreeLocation.trim() !== project.settings.worktreeLocation ||
    setupCommand.trim() !== project.settings.setupCommand ||
    checkCommands.join("\n") !== project.settings.checkCommands.join("\n");

  const save = useCallback(async (): Promise<void> => {
    if (!window.argmax) {
      setStatus({ kind: "error", message: "Open the Tauri app window to edit project settings." });
      return;
    }
    const location = worktreeLocation.trim();
    if (!location.startsWith("/")) {
      // Worktree creation requires an absolute path inside the repository —
      // reject here so a bad value fails at save time, not at first launch.
      setStatus({ kind: "error", message: "Worktree location must be an absolute path inside the repository." });
      return;
    }
    setSaving(true);
    setStatus(null);
    try {
      const updated = await window.argmax.projects.updateSettings({
        projectId: project.id,
        settings: {
          defaultProvider: defaultModel.provider,
          defaultModelLabel: defaultModel.label,
          defaultModelId: defaultModel.modelId,
          setupCommand: setupCommand.trim(),
          worktreeLocation: location,
          checkCommands
        }
      });
      onProjectUpdated(updated);
      setStatus({ kind: "saved", message: "Project settings saved." });
    } catch (error) {
      setStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "Could not save project settings."
      });
    } finally {
      setSaving(false);
    }
  }, [project, defaultModel, worktreeLocation, setupCommand, checkCommands, onProjectUpdated]);

  return (
    <div className="settings-card">
      <div className="settings-field">
        <span className="settings-field-label">Repository</span>
        <p className="settings-note">{project.repoPath}</p>
      </div>

      <SettingRow
        label="Default agent"
        description="Used when Argmax starts a session for this project on its own — for example the automatic fix session when a PR check fails."
        htmlFor="settings-project-model"
        control={
          <CombinedModelSelector
            ariaLabel="Default agent"
            inputId="settings-project-model"
            value={defaultModel}
            onChange={setDefaultModel}
          />
        }
      />

      <div className="settings-field">
        <label className="settings-field-label" htmlFor="settings-project-worktrees">
          Worktree location
        </label>
        <input
          id="settings-project-worktrees"
          className="settings-text-input"
          type="text"
          value={worktreeLocation}
          onChange={(event) => setWorktreeLocation(event.target.value)}
          spellCheck={false}
        />
        <p className="settings-note">
          Absolute path inside the repository where isolated worktrees are created.
        </p>
      </div>

      <div className="settings-field">
        <label className="settings-field-label" htmlFor="settings-project-setup">
          Setup command
        </label>
        <input
          id="settings-project-setup"
          className="settings-text-input"
          type="text"
          value={setupCommand}
          onChange={(event) => setSetupCommand(event.target.value)}
          placeholder="npm install"
          spellCheck={false}
        />
        <p className="settings-note">
          Run once in each fresh worktree before the agent starts, so dependencies are in place.
          Leave empty to skip.
        </p>
      </div>

      <div className="settings-field">
        <label className="settings-field-label" htmlFor="settings-project-checks">
          Check commands
        </label>
        <textarea
          id="settings-project-checks"
          className="settings-text-input settings-textarea"
          value={checkCommandsText}
          onChange={(event) => setCheckCommandsText(event.target.value)}
          rows={3}
          placeholder={"npm run lint\nnpm test"}
          spellCheck={false}
        />
        <p className="settings-note">
          One command per line. Offered on a session's changed-files card so you can verify a
          workspace before shipping it.
        </p>
      </div>

      <div className="settings-form-footer">
        <button
          type="button"
          className="primary-action"
          onClick={() => void save()}
          disabled={saving || !dirty}
        >
          {saving ? "Saving…" : "Save project settings"}
        </button>
        {status ? (
          <p
            className="settings-note settings-form-status"
            data-status={status.kind}
            role={status.kind === "error" ? "alert" : "status"}
          >
            {status.message}
          </p>
        ) : null}
      </div>
    </div>
  );
}
