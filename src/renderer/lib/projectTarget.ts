import type { ProjectSummary } from "../../shared/types.js";

/**
 * The project folder an action applies to. The folder is a required field, so a
 * surface that acts on a project cannot leave it out and silently act on the
 * primary folder. `null` states the choice: the project's primary folder, which
 * the host resolves itself.
 */
export interface ProjectTarget {
  project: ProjectSummary;
  projectFolderId: string | null;
}

/**
 * The wire form. The key stays optional because the iPhone app ships separately
 * from the Mac build, so the primary folder is sent as no key at all.
 */
export function projectFolderInput(target: Pick<ProjectTarget, "projectFolderId">): { projectFolderId?: string } {
  return target.projectFolderId ? { projectFolderId: target.projectFolderId } : {};
}

/** Where the file palette and the `@` menu read this target's files. */
export function projectFileSource(target: ProjectTarget): { kind: "projectFolder" | "project"; id: string } {
  return target.projectFolderId
    ? { kind: "projectFolder", id: target.projectFolderId }
    : { kind: "project", id: target.project.id };
}
