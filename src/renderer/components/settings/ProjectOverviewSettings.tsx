import { useEffect, useId, useState, type JSX } from "react";
import type { ProjectFolder, ProjectOverviewDocument, ProjectSummary } from "../../../shared/types.js";
import { validationMessage } from "../../../shared/validationMessage.js";
import { showErrorToast } from "../../state/toast.js";
import { SettingGroup } from "./settingsPrimitives.js";

export function ProjectOverviewSettings({ project, folders, onProjectUpdated }: {
  project: ProjectSummary;
  folders: ProjectFolder[];
  onProjectUpdated: (project: ProjectSummary) => void;
}): JSX.Element {
  const inputId = useId();
  const overview = project.overview;
  const savedText = overview?.saved?.text ?? "";
  const revision = overview?.revision ?? 0;
  const [editor, setEditor] = useState({ text: savedText, baseText: savedText, revision });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const dirty = editor.text !== editor.baseText;
  const conflict = dirty && editor.baseText !== savedText;
  const generating = overview?.status === "generating";
  const api = window.argmax?.projects;

  useEffect(() => {
    setEditor((current) => {
      if (current.text === current.baseText) return { text: savedText, baseText: savedText, revision };
      if (current.baseText === savedText) return { ...current, revision };
      return current;
    });
  }, [savedText, revision]);

  async function changeOverview(action: "generate" | "save" | "apply" | "discard"): Promise<void> {
    if (!api || busy) return;
    setBusy(true);
    setSaved(false);
    const submittedText = editor.text;
    try {
      const updated = action === "generate"
        ? await api.generateOverview({ projectId: project.id })
        : action === "save"
          ? await api.updateOverview({ projectId: project.id, text: submittedText, expectedRevision: editor.revision })
          : action === "apply"
            ? await api.applyOverviewDraft({ projectId: project.id, expectedRevision: revision })
            : await api.discardOverviewDraft({ projectId: project.id, expectedRevision: revision });
      if (action === "save") {
        const nextText = updated.overview?.saved?.text ?? "";
        setEditor((current) => ({
          text: current.text === submittedText ? nextText : current.text,
          baseText: nextText,
          revision: updated.overview?.revision ?? 0
        }));
        setSaved(true);
      }
      onProjectUpdated(updated);
    } catch (reason) {
      showErrorToast(validationMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingGroup id="settings-project-overview" label="Project overview">
      <div className="settings-field">
        <label className="settings-field-label" htmlFor={inputId}>Overview</label>
        <p className="settings-note">Purpose, folder roles, and how the code fits together. Agents use this to find relevant files.</p>
        <textarea id={inputId} aria-label="Project overview" className="settings-text-input settings-textarea project-overview-input"
          rows={6} value={editor.text} disabled={!api} placeholder="Describe this project…"
          onChange={(event) => { setEditor((current) => ({ ...current, text: event.target.value })); setSaved(false); }} />
      </div>
      {overview?.saved ? <OverviewSources document={overview.saved} folders={folders} /> : null}
      {generating ? <p className="settings-note" role="status">Generating the project overview in the background…</p> : null}
      {overview?.status === "failed" ? <p className="settings-note" role="alert">Overview unavailable. {overview.error}</p> : null}
      {conflict ? <div className="settings-field">
        <p className="settings-note" role="status">The saved overview changed. Your edits are preserved.</p>
        <div className="settings-form-footer">
          <button type="button" className="settings-button" disabled={busy}
            onClick={() => setEditor({ text: editor.text, baseText: savedText, revision })}>Keep my edits</button>
          <button type="button" className="settings-button" disabled={busy}
            onClick={() => setEditor({ text: savedText, baseText: savedText, revision })}>Use saved overview</button>
        </div>
      </div> : null}
      {api ? <div className="settings-form-footer">
        <button type="button" className="settings-button" disabled={busy || generating || Boolean(overview?.draft)}
          onClick={() => void changeOverview("generate")}>
          {generating ? "Generating…" : overview?.status === "failed" ? "Retry overview" : overview?.saved ? "Refresh overview" : "Generate overview"}
        </button>
        <button type="button" className="settings-button" disabled={busy || !dirty || conflict}
          onClick={() => void changeOverview("save")}>Save overview</button>
        {dirty && !conflict ? <button type="button" className="settings-button" disabled={busy}
          onClick={() => { setEditor({ text: savedText, baseText: savedText, revision }); setSaved(false); }}>Discard edits</button> : null}
        {saved && !dirty ? <span className="settings-note" role="status">Overview saved.</span> : null}
      </div> : <p className="settings-note">Open Argmax on your Mac to edit the project overview.</p>}
      {overview?.draft ? <div className="settings-field">
        <span className="settings-field-label">Refreshed draft</span>
        <p className="settings-note">Review this draft before replacing your saved overview.</p>
        <div className="project-overview-draft" aria-label="Refreshed overview draft">{overview.draft.text}</div>
        <OverviewSources document={overview.draft} folders={folders} />
        {dirty ? <p className="settings-note">Save or discard your edits before applying the draft.</p> : null}
        <div className="settings-form-footer">
          <button type="button" className="settings-button" disabled={!api || busy || dirty}
            onClick={() => void changeOverview("apply")}>Apply draft</button>
          <button type="button" className="settings-button" disabled={!api || busy}
            onClick={() => void changeOverview("discard")}>Discard draft</button>
        </div>
      </div> : null}
    </SettingGroup>
  );
}

function OverviewSources({ document, folders }: { document: ProjectOverviewDocument; folders: ProjectFolder[] }): JSX.Element {
  return (
    <div className="project-overview-sources">
      {document.generatedAt ? <p className="settings-note">Generated <time dateTime={document.generatedAt}>
        {new Date(document.generatedAt).toLocaleString()}
      </time></p> : null}
      {document.sources.length > 0 ? <div className="settings-note">
        <span>Sources</span>
        <ul aria-label="Overview sources">{document.sources.map((source) => {
          const folder = folders.find((candidate) => candidate.id === source.folderId);
          return <li key={`${source.folderId}:${source.path}`} title={folder?.rootPath}>
            {folder?.name ?? "Removed folder"}/{source.path}
          </li>;
        })}</ul>
      </div> : null}
    </div>
  );
}
