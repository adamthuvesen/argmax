import { useMemo, type JSX } from "react";
import type { ProjectFolderChangesState } from "../hooks/useProjectFolderChanges.js";
import { parseUnifiedDiff } from "../lib/diff.js";
import { ChangeCount } from "./ChangeCount.js";
import { DiffBlocks } from "./DiffBlocks.js";
import { LinesSkeleton } from "./LinesSkeleton.js";

export function ProjectFolderChangesList({ state }: { state: ProjectFolderChangesState }): JSX.Element | null {
  if (!state.error && state.groups.length === 0) return null;
  return (
    <section className="project-folder-changes" aria-label="Other project folders">
      <div className="project-folder-changes-label">Other project folders</div>
      {state.error ? <p role="alert">Could not load project folders: {state.error}</p> : null}
      {state.groups.map(({ folder, files, error }) => (
        <details key={folder.id} open>
          <summary title={folder.rootPath}>{folder.name}<span>{files.length}</span></summary>
          <p className="project-folder-changes-scope" title={folder.rootPath}>Checkout changes · shared with other chats</p>
          {error ? <p role="status">Git changes unavailable: {error}</p> : files.length === 0 ? <p>No uncommitted changes.</p> : files.map((file) => (
            <button
              key={file.path}
              type="button"
              className="project-folder-change-file"
              aria-label={`View ${file.path} in ${folder.name}`}
              aria-pressed={state.selection?.folderId === folder.id && state.selection?.path === file.path}
              title={`${folder.rootPath}/${file.path}`}
              onClick={() => state.selectFile(folder.id, file.path)}
            >
              <span>{file.path}</span>
              <ChangeCount additions={file.additions} deletions={file.deletions} />
            </button>
          ))}
        </details>
      ))}
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
