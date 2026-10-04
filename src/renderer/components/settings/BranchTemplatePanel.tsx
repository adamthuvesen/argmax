import { useEffect, useState, type JSX } from "react";
import type { ProjectSummary } from "../../../shared/types.js";
import { validationMessage } from "../../../shared/validationMessage.js";

const PLACEHOLDERS = "{type}, {slug}, {word}, {id}, {date}";

/**
 * Settings → Projects → Branch names. A template names the branch of each new
 * isolated worktree: `{slug}` is the task label, `{type}` is always `feat`,
 * `{word}` and `{id}` are Argmax's usual random word and 8 hex characters, and
 * `{date}` is the UTC day. A project's template overrides the app-wide one.
 * Existing branches are never renamed. Rust validates on save and the reason
 * for a rejection shows beside the field.
 */
export function BranchTemplatePanel({
  project,
  onProjectUpdated
}: {
  project: ProjectSummary;
  onProjectUpdated: (updated: ProjectSummary) => void;
}): JSX.Element {
  const [appTemplate, setAppTemplate] = useState("");
  const [defaultTemplate, setDefaultTemplate] = useState("");
  const [projectTemplate, setProjectTemplate] = useState(project.branchTemplate ?? "");
  const [appError, setAppError] = useState<string | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const api = window.argmax;

  useEffect(() => {
    let active = true;
    // Optional chaining: a host older than this setting has no such channel.
    void api?.settings
      ?.branchTemplate?.()
      .then((settings) => {
        if (!active) return;
        setAppTemplate(settings.template ?? "");
        setDefaultTemplate(settings.defaultTemplate);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [api]);

  async function saveApp(): Promise<void> {
    if (!api) return;
    setBusy(true);
    setAppError(null);
    setStatus(null);
    try {
      const saved = await api.settings.setBranchTemplate({
        template: appTemplate.trim() === "" ? null : appTemplate.trim()
      });
      setAppTemplate(saved.template ?? "");
      setStatus("Default branch template saved.");
    } catch (reason) {
      setAppError(validationMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function saveProject(): Promise<void> {
    if (!api) return;
    setBusy(true);
    setProjectError(null);
    setStatus(null);
    try {
      const updated = await api.projects.setBranchTemplate({
        projectId: project.id,
        template: projectTemplate.trim() === "" ? null : projectTemplate.trim()
      });
      setProjectTemplate(updated.branchTemplate ?? "");
      onProjectUpdated(updated);
      setStatus("Project branch template saved.");
    } catch (reason) {
      setProjectError(validationMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="settings-branch-names" className="settings-card" aria-label="Branch names">
      <h3>Branch names</h3>
      <p className="settings-note">
        Names the branch of each new worktree chat. Placeholders: {PLACEHOLDERS}. A taken name gets a
        numeric suffix. Existing branches keep their names.
      </p>
      <div className="settings-field">
        <label className="settings-field-label" htmlFor="settings-branch-template-app">
          Default for all projects
        </label>
        <input
          id="settings-branch-template-app"
          className="settings-text-input"
          type="text"
          value={appTemplate}
          onChange={(event) => setAppTemplate(event.target.value)}
          placeholder={defaultTemplate || "argmax/{word}-{id}"}
          spellCheck={false}
        />
        {appError ? (
          <p role="alert" className="settings-note">
            {appError}
          </p>
        ) : null}
        <div className="settings-form-footer">
          <button type="button" className="settings-button" disabled={busy} onClick={() => void saveApp()}>
            Save default
          </button>
        </div>
      </div>
      <div className="settings-field">
        <label className="settings-field-label" htmlFor="settings-branch-template-project">
          {project.name} override
        </label>
        <input
          id="settings-branch-template-project"
          className="settings-text-input"
          type="text"
          value={projectTemplate}
          onChange={(event) => setProjectTemplate(event.target.value)}
          placeholder="Use the default"
          spellCheck={false}
        />
        {projectError ? (
          <p role="alert" className="settings-note">
            {projectError}
          </p>
        ) : null}
        <div className="settings-form-footer">
          <button type="button" className="settings-button" disabled={busy} onClick={() => void saveProject()}>
            Save project template
          </button>
        </div>
      </div>
      {status ? (
        <p role="status" className="settings-note">
          {status}
        </p>
      ) : null}
    </section>
  );
}
