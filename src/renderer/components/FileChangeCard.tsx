import { ExternalLink, FilePlus, FileX2, Pencil } from "lucide-react";
import { useMemo, useState, type JSX } from "react";
import { countVisibleDiffLines, type FileChange } from "../lib/fileChange.js";
import { DiffBlocks } from "./DiffBlocks.js";

const COLLAPSE_THRESHOLD = 16;

function displayPath(path: string, cwd: string | null | undefined): string {
  if (!cwd) return path;
  const normalized = cwd.endsWith("/") ? cwd : `${cwd}/`;
  if (path.startsWith(normalized)) return path.slice(normalized.length);
  if (path === cwd) return path;
  return path;
}

export function FileChangeCard({
  change,
  workspaceCwd
}: {
  change: FileChange;
  workspaceCwd?: string | null;
}): JSX.Element {
  const visibleLines = useMemo(
    () => (change.kind === "delete" ? 0 : countVisibleDiffLines(change.hunks)),
    [change]
  );
  const exceedsThreshold = visibleLines > COLLAPSE_THRESHOLD;
  const [expanded, setExpanded] = useState(false);
  const collapsed = exceedsThreshold && !expanded;

  const verb = change.kind === "create" ? "Created" : change.kind === "delete" ? "Deleted" : "Edited";
  const Icon = change.kind === "create" ? FilePlus : change.kind === "delete" ? FileX2 : Pencil;
  const noLineNumbers = change.kind === "edit" && change.noLineNumbers === true;
  const shortPath = useMemo(() => displayPath(change.path, workspaceCwd), [change.path, workspaceCwd]);

  const onOpen = (): void => {
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
          aria-label={`Open ${change.path} in editor`}
        >
          <ExternalLink size={11} aria-hidden="true" />
          <span>Open in editor</span>
        </button>
      </header>
      <div className="file-change-card-body" data-collapsed={collapsed ? "true" : "false"}>
        {change.kind === "delete" ? (
          <p className="file-change-card-empty">File removed.</p>
        ) : change.hunks.length === 0 ? (
          <p className="file-change-card-empty">{note ?? "No content to display."}</p>
        ) : (
          <>
            <DiffBlocks blocks={change.hunks} filePath={change.path} view="unified" />
            {note ? <p className="file-change-card-note">{note}</p> : null}
          </>
        )}
      </div>
      {exceedsThreshold ? (
        <button
          className="file-change-card-toggle"
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Show less" : `Show all ${visibleLines} lines`}
        </button>
      ) : null}
    </section>
  );
}
