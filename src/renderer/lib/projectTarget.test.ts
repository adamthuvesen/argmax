import { describe, expect, it } from "vitest";
import type { ProjectSummary } from "../../shared/types.js";
import { projectFileSource, projectFolderInput, type ProjectTarget } from "./projectTarget.js";

const project = { id: "project-1" } as ProjectSummary;

describe("ProjectTarget", () => {
  it("requires the folder, so a surface cannot leave it out", () => {
    // Replay of e1a8afac: ⌘J created the checkout workspace without the folder
    // the launcher had picked. The field is required, so that shape does not compile.
    // @ts-expect-error projectFolderId is required
    const omitted: ProjectTarget = { project };
    expect(omitted.projectFolderId).toBeUndefined();
  });

  it("sends no wire key for the primary folder", () => {
    expect(projectFolderInput({ projectFolderId: null })).toEqual({});
    expect(projectFolderInput({ projectFolderId: "folder-2" })).toEqual({ projectFolderId: "folder-2" });
  });

  it("reads files from the picked folder when there is one", () => {
    expect(projectFileSource({ project, projectFolderId: null })).toEqual({ kind: "project", id: "project-1" });
    expect(projectFileSource({ project, projectFolderId: "folder-2" })).toEqual({ kind: "projectFolder", id: "folder-2" });
  });
});
