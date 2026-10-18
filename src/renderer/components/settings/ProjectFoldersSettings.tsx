import { useEffect, useState, type JSX } from "react";
import type { ProjectFolder, ProjectSummary } from "../../../shared/types.js";
import { validationMessage } from "../../../shared/validationMessage.js";
import { ProjectFoldersForm, type ProjectFoldersDraft } from "../ProjectFoldersForm.js";
import { ProjectFolderContext } from "./ProjectFolderContext.js";

export function ProjectFoldersSettings({ project, onProjectUpdated }: {
  project: ProjectSummary;
  onProjectUpdated: (project: ProjectSummary) => void;
}): JSX.Element {
  const [folders, setFolders] = useState<ProjectFolder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const api = window.argmax?.projects;

  useEffect(() => {
    if (!api) return;
    let active = true;
    void api.getFolders({ projectId: project.id }).then((result) => {
      if (active) { setFolders(result); setError(null); }
    }).catch((reason: unknown) => {
      if (active) setError(validationMessage(reason));
    });
    return () => { active = false; };
  }, [api, project.id, revision]);

  async function save(draft: ProjectFoldersDraft): Promise<void> {
    if (!api) return;
    const updated = await api.configure({ projectId: project.id, ...draft });
    onProjectUpdated(updated);
    setRevision((current) => current + 1);
  }

  return (
    <section id="settings-project-folders" className="settings-card" aria-label="Project name and folders">
      {!api ? <p className="settings-note">Open Argmax on your Mac to edit project folders.</p> : null}
      {error ? <p className="settings-note" role="alert">{error}</p> : null}
      {api && !error && !folders ? <p className="settings-note" role="status">Loading project folders…</p> : null}
      {folders ? <ProjectFoldersForm
        key={`${project.id}:${project.name}:${folders.map((folder) => `${folder.rootPath}:${folder.isPrimary}`).join("|")}`}
        initialValue={{ name: project.name, folders: folders.map((folder) => folder.rootPath),
          primaryPath: folders.find((folder) => folder.isPrimary)?.rootPath ?? project.repoPath }}
        submitLabel="Save project" onSubmit={save}
        renderFolderDetails={(path) => {
          const folder = folders.find((candidate) => candidate.rootPath === path);
          return folder && !folder.isPrimary ? <ProjectFolderContext key={folder.id} folder={folder} /> : null;
        }}
      /> : null}
    </section>
  );
}
