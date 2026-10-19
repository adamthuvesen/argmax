import { useMemo, type JSX } from "react";
import { ChevronRight, Folder } from "lucide-react";
import type { ProjectFolderChangesState } from "../hooks/useProjectFolderChanges.js";
import { parseUnifiedDiff } from "../lib/diff.js";
import { repoNameFromPath } from "../lib/projects.js";
import { ChangesTree } from "./ChangesTree.js";
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
            {error ? <span className="project-folder-change-total">Unavailable</span> : null}
          </summary>
          {error ? <p className="project-folder-changes-error" role="status">Could not load changes: {error}</p> : files.length === 0 ? null : <ChangesTree
            files={files}
            selectedPath={state.selection?.folderId === folder.id ? state.selection.path : null}
            onSelectFile={(path) => state.selectFile(folder.id, path)}
            onRefresh={state.refresh}
          />}

        </details>
        );
      })}
    </section>
  );
}

export function ProjectFolderChangesDiff({ state }: { state: ProjectFolderChangesState }): JSX.Element {
  const blocks = useMemo(() => parseUnifiedDiff(state.diff?.content ?? ""), [state.diff?.content]);
  return (
      <div className="review-diff-scroll">
        {state.loadingDiff ? <LinesSkeleton rows={14} label="Loading folder diff" /> : null}
        {state.diffError ? <p className="review-empty review-error" role="alert">{state.diffError}</p> : null}
        {!state.loadingDiff && !state.diffError && blocks.length === 0 ? <p className="review-empty">No diff available.</p> : null}
        {!state.loadingDiff && blocks.length > 0 ? (
          <DiffBlocks blocks={blocks} filePath={state.selection?.path} presentation="review" onExpandContext={state.expandContext} />
        ) : null}
      </div>
  );
}
