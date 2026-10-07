import { useCallback, useMemo, useState, type JSX } from "react";
import type { MergeCleanup, ProjectSummary } from "../../../shared/types.js";
import { showErrorToast } from "../../state/toast.js";
import { BranchTemplatePanel } from "./BranchTemplatePanel.js";
import { LinkedReposPanel } from "./LinkedReposPanel.js";
import { ProjectSourcesPanel } from "./ProjectSourcesPanel.js";
import { SegmentedControl, SettingGroup, SettingRow, SettingsListPicker } from "./settingsPrimitives.js";

/**
 * Per-project settings editor (Settings → Projects). Every field here is
 * consumed by the runtime: worktree location places isolated worktrees, the
 * setup command runs once in each fresh worktree before the agent launches,
 * check commands run from the changed-files card, and merge cleanup lets
 * the gh poller dispose of a workspace once its PR lands. The model is not a
 * project setting — Settings → Agents holds one default agent for the app.
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
          <BranchTemplatePanel
            key={`branch-names-${selected.id}`}
            project={selected}
            onProjectUpdated={onProjectUpdated}
          />
          <LinkedReposPanel key={`linked-${selected.id}`} projectId={selected.id} />
          <ProjectSourcesPanel key={`sources-${selected.id}`} projectId={selected.id} />
        </>
      )}
    </SettingGroup>
  );
}

const MERGE_CLEANUP_OPTIONS: ReadonlyArray<{ value: MergeCleanup; label: string }> = [
  { value: "off", label: "Keep" },
  { value: "remove-checkout", label: "Remove worktree" },
  { value: "archive", label: "Archive chat" }
];

const MERGE_CLEANUP_DESCRIPTIONS: Record<MergeCleanup, string> = {
  off: "Nothing changes when GitHub reports the pull request merged. The sidebar row shows it merged.",
  "remove-checkout":
    "Deletes the chat's worktree, then runs PR cleanup: deletes the local and remote branch and fast-forwards the base branch where it is checked out. The chat stays in the sidebar, read-only. Only chats with their own worktree. One with uncommitted changes or commits after the merge is kept.",
  archive:
    "Moves the chat to Archived and keeps its worktree for recovery for two days. The branch is kept. Only chats with their own worktree. One with uncommitted changes is kept."
};

/** Keyed by project id, so switching projects remounts with fresh values. */
function ProjectSettingsForm({
  project,
  onProjectUpdated
}: {
  project: ProjectSummary;
  onProjectUpdated: (updated: ProjectSummary) => void;
}): JSX.Element {
  const [worktreeLocation, setWorktreeLocation] = useState(project.settings.worktreeLocation);
  const [setupCommand, setSetupCommand] = useState(project.settings.setupCommand);
  const [checkCommandsText, setCheckCommandsText] = useState(project.settings.checkCommands.join("\n"));
  const [mergeCleanup, setMergeCleanup] = useState<MergeCleanup>(project.settings.mergeCleanup);
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
    worktreeLocation.trim() !== project.settings.worktreeLocation ||
    setupCommand.trim() !== project.settings.setupCommand ||
    checkCommands.join("\n") !== project.settings.checkCommands.join("\n") ||
    mergeCleanup !== project.settings.mergeCleanup;

  const save = useCallback(async (): Promise<void> => {
    setStatus(null);
    if (!window.argmax) {
      showErrorToast("Open Argmax on your Mac to edit project settings.");
      return;
    }
    const location = worktreeLocation.trim();
    if (!location.startsWith("/")) {
      // Worktree creation requires an absolute path.
      // reject here so a bad value fails at save time, not at first launch.
      setStatus({ kind: "error", message: "Worktree location must be an absolute path." });
      return;
    }
    setSaving(true);
    try {
      const updated = await window.argmax.projects.updateSettings({
        projectId: project.id,
        settings: {
          setupCommand: setupCommand.trim(),
          worktreeLocation: location,
          checkCommands,
          mergeCleanup
        }
      });
      onProjectUpdated(updated);
      setStatus({ kind: "saved", message: "Project settings saved." });
    } catch (error) {
      showErrorToast(error instanceof Error ? error.message : "Could not save project settings.");
    } finally {
      setSaving(false);
    }
  }, [project, worktreeLocation, setupCommand, checkCommands, mergeCleanup, onProjectUpdated]);

  return (
    <div className="settings-card">
      <div className="settings-field">
        <span className="settings-field-label">Repository</span>
        <p className="settings-note">{project.repoPath}</p>
      </div>

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
          Absolute folder for new worktrees. It can be outside the repository. Existing worktrees stay in place.
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
          One command per line. Offered on a chat's changed-files card so you can verify a
          workspace before shipping it.
        </p>
      </div>

      <SettingRow
        label="When a PR merges"
        description={MERGE_CLEANUP_DESCRIPTIONS[mergeCleanup]}
        control={
          <SegmentedControl
            ariaLabel="When a PR merges"
            name={`merge-cleanup-${project.id}`}
            value={mergeCleanup}
            onChange={(next) => setMergeCleanup(next as MergeCleanup)}
            options={MERGE_CLEANUP_OPTIONS}
          />
        }
      />

      <div className="settings-form-footer">
        <button
          type="button"
          className="settings-button"
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
