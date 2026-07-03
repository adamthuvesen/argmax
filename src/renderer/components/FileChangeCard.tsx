import { FilePlus, FileX2, PanelRight, Pencil } from "lucide-react";
import { useMemo, type JSX } from "react";
import type { FileChange } from "../lib/fileChange.js";
import type { FileChipOpenOptions } from "./FileChip.js";
import { DiffBlocks } from "./DiffBlocks.js";

function displayPath(path: string, cwd: string | null | undefined): string {
  if (!cwd) return path;
  const normalized = cwd.endsWith("/") ? cwd : `${cwd}/`;
  if (path.startsWith(normalized)) return path.slice(normalized.length);
  if (path === cwd) return path;
  return path;
}

export function FileChangeCard({
  change,
  workspaceCwd,
  onOpenFile
}: {
  change: FileChange;
  workspaceCwd?: string | null;
  onOpenFile?: (path: string, opts?: FileChipOpenOptions) => void;
}): JSX.Element {
  const verb = change.kind === "create" ? "Created" : change.kind === "delete" ? "Deleted" : "Edited";
  const Icon = change.kind === "create" ? FilePlus : change.kind === "delete" ? FileX2 : Pencil;
  const noLineNumbers = change.kind === "edit" && change.noLineNumbers === true;
  const shortPath = useMemo(() => displayPath(change.path, workspaceCwd), [change.path, workspaceCwd]);

  const onOpen = (): void => {
    if (onOpenFile) {
      // The agent's file_path is absolute, but the review panel (file tree, tabs,
      // path resolver) keys on workspace-relative paths — hand it the relativized
      // path so it resolves and opens instead of silently failing containment.
      onOpenFile(shortPath);
      return;
    }
    if (!window.argmax) return;
    void window.argmax.system
      .openPath({ path: change.path, ...(workspaceCwd ? { cwd: workspaceCwd } : {}) })
      .catch(() => undefined);
  };

  const note = change.kind === "delete" ? null : change.note ?? null;

  return (
    <section
      className="file-change-card"
      data-kind={change.kind}
      {...(noLineNumbers ? { "data-no-line-numbers": "true" } : {})}
      aria-label={`${verb} ${change.path}`}
    >
      <header className="file-change-card-header">
        <Icon size={14} aria-hidden="true" />
        <code className="file-change-card-path" title={change.path}>
          {shortPath}
        </code>
        <button
          className="file-change-card-open"
          type="button"
          onClick={onOpen}
          aria-label={`Open ${change.path}`}
        >
          <PanelRight size={11} aria-hidden="true" />
          <span>Open</span>
        </button>
      </header>
      <div className="file-change-card-body">
        {change.kind === "delete" ? (
          <p className="file-change-card-empty">File removed.</p>
        ) : change.hunks.length === 0 ? (
          <p className="file-change-card-empty">{note ?? "No content to display."}</p>
        ) : (
          <>
            <DiffBlocks blocks={change.hunks} filePath={change.path} />
            {note ? <p className="file-change-card-note">{note}</p> : null}
          </>
        )}
      </div>
    </section>
  );
}
