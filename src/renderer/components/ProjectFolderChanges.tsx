import { useMemo, type JSX } from "react";
import { FileIcon } from "@react-symbols/icons/utils";
import { ChevronRight, Folder } from "lucide-react";
import type { ProjectFolderChangesState } from "../hooks/useProjectFolderChanges.js";
import { parseUnifiedDiff } from "../lib/diff.js";
import { repoNameFromPath } from "../lib/projects.js";
import { SPECIAL_FILE_ICONS } from "../lib/specialFileIcons.js";
import { ChangeCount } from "./ChangeCount.js";
import { DiffBlocks } from "./DiffBlocks.js";
import { LinesSkeleton } from "./LinesSkeleton.js";

export function ProjectFolderChangesList({ state }: { state: ProjectFolderChangesState }): JSX.Element | null {
  if (!state.error && state.groups.length === 0) return null;
  return (
    <section className="project-folder-changes" aria-label="Other project folders">
      {state.error ? <p className="project-folder-changes-error" role="alert">Could not load project folders: {state.error}</p> : null}
      {state.groups.map(({ folder, files, error }) => {
        const folderName = repoNameFromPath(folder.rootPath) ?? folder.name;
        return (
        <details className="project-folder-change-group" key={folder.id} open={files.length > 0 || !!error}>
          <summary title={folder.rootPath}>
            <ChevronRight className="project-folder-change-chevron" size={12} aria-hidden="true" />
            <Folder size={14} aria-hidden="true" />
            <span className="project-folder-change-name">{folderName}</span>
            <span className="project-folder-change-total">{error ? "Unavailable" : files.length === 0 ? "No changes" : `${files.length} ${files.length === 1 ? "file" : "files"}`}</span>
          </summary>
          {error ? <p className="project-folder-changes-error" role="status">Could not load changes: {error}</p> : files.length === 0 ? <p>No uncommitted changes.</p> : files.map((file) => {
            const slash = file.path.lastIndexOf("/");
            const name = file.path.slice(slash + 1);
            const directory = slash < 0 ? "" : file.path.slice(0, slash);
            return (
            <button
              key={file.path}
              type="button"
              className="project-folder-change-file"
              aria-label={`View ${file.path} in ${folderName}`}
              aria-pressed={state.selection?.folderId === folder.id && state.selection?.path === file.path}
              title={`${folder.rootPath}/${file.path}`}
              onClick={() => state.selectFile(folder.id, file.path)}
            >
              <span className="project-folder-change-icon" aria-hidden="true">
                <FileIcon fileName={name} autoAssign editFileNameData={SPECIAL_FILE_ICONS} width={14} height={14} />
              </span>
              <span className="project-folder-change-path">
                <span className="project-folder-change-basename">{name}</span>
                {directory ? <span className="project-folder-change-directory">{directory}</span> : null}
              </span>
              <ChangeCount additions={file.additions} deletions={file.deletions} />
            </button>
            );
          })}
        </details>
        );
      })}
    </section>
  );
}

export function ProjectFolderChangesDiff({ state }: { state: ProjectFolderChangesState }): JSX.Element {
  const blocks = useMemo(() => parseUnifiedDiff(state.diff?.content ?? ""), [state.diff?.content]);
  return (
    <>
      <div className="review-diff-heading project-folder-diff-heading">
        <span title={state.selectedFolder?.rootPath}>{state.selectedFolder?.name} / {state.selection?.path}</span>
        <button type="button" onClick={state.clearSelection}>Back to chat changes</button>
      </div>
      <p className="project-folder-diff-scope">Uncommitted changes in this folder’s checkout. These can include other chats’ work.</p>
      <div className="review-diff-scroll">
        {state.loadingDiff ? <LinesSkeleton rows={14} label="Loading folder diff" /> : null}
        {state.diffError ? <p className="review-empty review-error" role="alert">{state.diffError}</p> : null}
        {!state.loadingDiff && !state.diffError && blocks.length === 0 ? <p className="review-empty">No diff available.</p> : null}
        {!state.loadingDiff && blocks.length > 0 ? (
          <DiffBlocks blocks={blocks} filePath={state.selection?.path} presentation="review" onExpandContext={state.expandContext} />
        ) : null}
      </div>
    </>
  );
}
