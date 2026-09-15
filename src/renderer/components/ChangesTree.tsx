import { FileIcon, FolderIcon } from "@react-symbols/icons/utils";
import { ChevronRight, ChevronsDownUp, FolderOpen, Minus, Plus, RotateCw, Undo2 } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type JSX,
  type MouseEvent
} from "react";
import { buildFileTree, type TreeNode } from "../lib/fileTree.js";
import { SPECIAL_FILE_ICONS } from "../lib/specialFileIcons.js";
import type { ChangedFileSummary } from "../../shared/types.js";

export interface ChangesTreeProps {
  files: ChangedFileSummary[];
  /** Path of the changed file the panel is currently showing, if any. */
  selectedPath: string | null;
  /** Row click: the caller decides whether that selects or opens the diff. */
  onSelectFile: (path: string) => void;
  onRefresh: () => void;
  onOpenInFiles: (path: string) => void;
  /** Omit to hide staging entirely — e.g. when diffing against the base branch,
   *  where there is no index to move. */
  onToggleStaged?: (file: ChangedFileSummary) => void;
  /** Omit to hide revert. Untracked files hide it on their own: there is no
   *  tracked content to restore. */
  onRevert?: (file: ChangedFileSummary) => void;
  /** A review write is in flight; staging and revert stay visible but inert. */
  actionsPending?: boolean;
}

/** Row geometry copied from `WorkspaceTree` so both trees line up under the
 *  review toolbar; `--tree-depth` drives the indent guides. */
const ROW_HEIGHT = 24;
const INDENT_BASE = 10;
const INDENT_STEP = 12;

type ChangeStatus = "added" | "modified" | "deleted";

const STATUS_GLYPH: Record<ChangeStatus, string> = {
  added: "+",
  modified: "·",
  deleted: "−"
};

const STATUS_WORD: Record<ChangeStatus, string> = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted"
};

/** A directory chain folded into one row, so `src` › `renderer` › `components`
 *  reads as `src/renderer/components`. `path` stays the canonical path of the
 *  deepest directory, which is what toggling and ancestor reveal work on. */
type CompactNode = {
  path: string;
  label: string;
  kind: "dir" | "file";
  children: CompactNode[];
};

type VisibleRow = {
  node: CompactNode;
  depth: number;
};

/**
 * A directory whose only child is another directory contributes an indent level
 * and nothing else, so it merges into that child. A directory holding a file
 * keeps its own row — folding it would leave the file with nowhere to sit.
 */
function compactNode(node: TreeNode): CompactNode {
  if (node.kind === "file") {
    return { path: node.path, label: node.name, kind: "file", children: [] };
  }
  let tail = node;
  const segments = [node.name];
  for (;;) {
    const only = tail.children.length === 1 ? tail.children[0] : undefined;
    if (!only || only.kind !== "dir") break;
    tail = only;
    segments.push(only.name);
  }
  return {
    path: tail.path,
    label: segments.join("/"),
    kind: "dir",
    children: tail.children.map(compactNode)
  };
}

function flattenVisible(roots: CompactNode[], collapsed: Set<string>): VisibleRow[] {
  const rows: VisibleRow[] = [];
  const walk = (nodes: CompactNode[], depth: number): void => {
    for (const node of nodes) {
      rows.push({ node, depth });
      if (node.kind === "dir" && !collapsed.has(node.path)) walk(node.children, depth + 1);
    }
  };
  walk(roots, 0);
  return rows;
}

function collectDirPaths(nodes: CompactNode[], into: string[]): string[] {
  for (const node of nodes) {
    if (node.kind !== "dir") continue;
    into.push(node.path);
    collectDirPaths(node.children, into);
  }
  return into;
}

/** Status comes from the line mix rather than the git status code: a review
 *  reader cares whether a file only grew, only shrank, or both. */
function changeStatus(file: ChangedFileSummary): ChangeStatus {
  if (file.additions > 0 && file.deletions === 0) return "added";
  if (file.additions === 0 && file.deletions > 0) return "deleted";
  return "modified";
}

function countPhrase(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function statusTitle(file: ChangedFileSummary, status: ChangeStatus): string {
  return `${STATUS_WORD[status]}, ${countPhrase(file.additions, "insertion")}, ${countPhrase(file.deletions, "deletion")}`;
}

export function ChangesTree({
  files,
  selectedPath,
  onSelectFile,
  onRefresh,
  onOpenInFiles,
  onToggleStaged,
  onRevert,
  actionsPending = false
}: ChangesTreeProps): JSX.Element {
  // Folded rather than expanded folders: a changed set is small and the point
  // of the panel is seeing the files, so everything starts open and stays open
  // as new paths arrive.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const roots = useMemo(
    () => buildFileTree(files.map((file) => ({ path: file.path }))).children.map(compactNode),
    [files]
  );
  const summaries = useMemo(() => new Map(files.map((file) => [file.path, file])), [files]);
  const dirPaths = useMemo(() => collectDirPaths(roots, []), [roots]);
  const visibleRows = useMemo(() => flattenVisible(roots, collapsed), [roots, collapsed]);
  const expandedCount = dirPaths.filter((path) => !collapsed.has(path)).length;

  const collapseAll = useCallback((): void => {
    setCollapsed(new Set(dirPaths));
  }, [dirPaths]);

  const toggleDir = useCallback((path: string): void => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // A file selected from outside (or restored) has to be on screen, so reopen
  // every folder above it. Compacted chains are covered because a chain's row
  // key is its deepest directory, which is one of these prefixes.
  useEffect(() => {
    if (!selectedPath) return;
    setCollapsed((current) => {
      if (current.size === 0) return current;
      const next = new Set(current);
      const segments = selectedPath.split("/");
      let changed = false;
      for (let i = 1; i < segments.length; i++) {
        if (next.delete(segments.slice(0, i).join("/"))) changed = true;
      }
      return changed ? next : current;
    });
  }, [selectedPath]);

  return (
    <div className="workspace-tree-col changes-tree-col">
      <div className="workspace-tree-toolbar">
        <button
          type="button"
          className="small-icon"
          title="Collapse all folders"
          aria-label="Collapse all folders"
          disabled={expandedCount === 0}
          onClick={collapseAll}
        >
          <ChevronsDownUp size={14} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          className="small-icon"
          title="Refresh changed files"
          aria-label="Refresh changed files"
          onClick={onRefresh}
        >
          <RotateCw size={14} strokeWidth={1.75} />
        </button>
      </div>
      <div className="workspace-tree changes-tree" role="tree" aria-label="Changed files">
        {visibleRows.map((row) =>
          row.node.kind === "dir" ? (
            <DirRow
              key={row.node.path}
              node={row.node}
              depth={row.depth}
              open={!collapsed.has(row.node.path)}
              onToggle={toggleDir}
            />
          ) : (
            <FileRow
              key={row.node.path}
              node={row.node}
              depth={row.depth}
              file={summaries.get(row.node.path)}
              selected={selectedPath === row.node.path}
              actionsPending={actionsPending}
              onSelectFile={onSelectFile}
              onOpenInFiles={onOpenInFiles}
              onToggleStaged={onToggleStaged}
              onRevert={onRevert}
            />
          )
        )}
      </div>
    </div>
  );
}

function rowIndent(depth: number): CSSProperties {
  return {
    paddingLeft: INDENT_BASE + depth * INDENT_STEP,
    height: ROW_HEIGHT,
    "--tree-depth": depth
  } as CSSProperties;
}

function DirRow({
  node,
  depth,
  open,
  onToggle
}: {
  node: CompactNode;
  depth: number;
  open: boolean;
  onToggle: (path: string) => void;
}): JSX.Element {
  // The folder glyph follows the deepest name in a folded chain, which is the
  // directory the row actually opens.
  const iconName = node.label.slice(node.label.lastIndexOf("/") + 1);
  return (
    <button
      type="button"
      role="treeitem"
      aria-expanded={open}
      className="workspace-tree-row workspace-tree-dir"
      style={rowIndent(depth)}
      title={node.path}
      onClick={() => onToggle(node.path)}
    >
      <ChevronRight size={12} className={`workspace-tree-chevron${open ? " expanded" : ""}`} />
      <span className="workspace-tree-icon" title={`Folder icon for ${iconName}`} aria-hidden="true">
        <FolderIcon folderName={iconName} width={14} height={14} />
      </span>
      <span className="workspace-tree-label">{node.label}</span>
    </button>
  );
}

function FileRow({
  node,
  depth,
  file,
  selected,
  actionsPending,
  onSelectFile,
  onOpenInFiles,
  onToggleStaged,
  onRevert
}: {
  node: CompactNode;
  depth: number;
  file: ChangedFileSummary | undefined;
  selected: boolean;
  actionsPending: boolean;
  onSelectFile: (path: string) => void;
  onOpenInFiles: (path: string) => void;
  onToggleStaged?: (file: ChangedFileSummary) => void;
  onRevert?: (file: ChangedFileSummary) => void;
}): JSX.Element | null {
  if (!file) return null;
  const status = changeStatus(file);
  const title = statusTitle(file, status);
  const isUntracked = file.status === "??";
  // Actions sit beside the row button, not inside it: a button cannot nest, and
  // this keeps the status glyph on screen when they appear on hover.
  const act = (run: () => void) => (event: MouseEvent): void => {
    event.stopPropagation();
    run();
  };
  return (
    <div className="changes-tree-row-shell">
      <button
        type="button"
        role="treeitem"
        aria-selected={selected}
        aria-pressed={selected}
        className="workspace-tree-row workspace-tree-file changes-tree-file"
        data-status={status}
        style={rowIndent(depth)}
        title={node.path}
        onClick={() => onSelectFile(node.path)}
      >
        <span className="workspace-tree-chevron-spacer" aria-hidden="true" />
        <span className="workspace-tree-icon" title={`File icon for ${node.label}`} aria-hidden="true">
          <FileIcon
            fileName={node.label}
            autoAssign
            editFileNameData={SPECIAL_FILE_ICONS}
            width={14}
            height={14}
          />
        </span>
        <span className="workspace-tree-label changes-tree-label" data-status={status}>
          {node.label}
        </span>
      </button>
      <span className="changes-tree-row-end">
        <span className="changes-tree-actions">
          {onToggleStaged ? (
            <button
              type="button"
              className="small-icon"
              title={`${file.staged ? "Unstage" : "Stage"} ${file.path}`}
              aria-label={`${file.staged ? "Unstage" : "Stage"} ${file.path}`}
              disabled={actionsPending}
              onClick={act(() => onToggleStaged(file))}
            >
              {file.staged ? <Minus size={13} aria-hidden="true" /> : <Plus size={13} aria-hidden="true" />}
            </button>
          ) : null}
          {onRevert && !isUntracked ? (
            <button
              type="button"
              className="small-icon"
              title="Save a recovery checkpoint, then discard unstaged changes"
              aria-label={`Revert unstaged changes in ${file.path}`}
              disabled={actionsPending}
              onClick={act(() => onRevert(file))}
            >
              <Undo2 size={13} aria-hidden="true" />
            </button>
          ) : null}
          <button
            type="button"
            className="small-icon"
            title={`Open ${file.path} in Files view`}
            aria-label={`Open ${file.path} in Files view`}
            onClick={act(() => onOpenInFiles(file.path))}
          >
            <FolderOpen size={13} aria-hidden="true" />
          </button>
        </span>
        <span className="changes-tree-status" data-status={status} role="img" aria-label={title} title={title}>
          {STATUS_GLYPH[status]}
        </span>
      </span>
    </div>
  );
}
