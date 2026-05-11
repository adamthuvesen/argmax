import { ChevronRight, FileText, Folder } from "lucide-react";
import { useCallback, useMemo, useState, type JSX } from "react";
import type { WorkspaceFileEntry } from "../../shared/types.js";
import type { WorkspaceFilesState } from "../hooks/useReviewState.js";

type TreeNode = {
  name: string;
  path: string;
  kind: "dir" | "file";
  children: TreeNode[];
};

function buildFileTree(entries: WorkspaceFileEntry[]): TreeNode {
  const root: TreeNode = { name: "", path: "", kind: "dir", children: [] };
  for (const entry of entries) {
    const segments = entry.path.split("/").filter(Boolean);
    let cursor = root;
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i];
      if (!segment) continue;
      const isLast = i === segments.length - 1;
      const childPath = cursor.path ? `${cursor.path}/${segment}` : segment;
      let next = cursor.children.find((child) => child.name === segment);
      if (!next) {
        next = {
          name: segment,
          path: childPath,
          kind: isLast ? "file" : "dir",
          children: []
        };
        cursor.children.push(next);
      }
      cursor = next;
    }
  }
  sortTree(root);
  return root;
}

function sortTree(node: TreeNode): void {
  node.children.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const child of node.children) {
    if (child.kind === "dir") sortTree(child);
  }
}

export function WorkspaceTree({
  state,
  height
}: {
  state: WorkspaceFilesState;
  height: number;
}): JSX.Element {
  const tree = useMemo(() => buildFileTree(state.entries), [state.entries]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const toggleDir = useCallback((path: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  if (state.listState === "loading") {
    return (
      <div className="workspace-tree workspace-tree-empty" style={{ height }} aria-label="Workspace files">
        <p className="review-empty">Loading files…</p>
      </div>
    );
  }

  if (state.listState === "error") {
    return (
      <div className="workspace-tree workspace-tree-empty" style={{ height }} aria-label="Workspace files">
        <p className="review-empty review-error">{state.listError}</p>
      </div>
    );
  }

  if (state.listState === "ready" && state.entries.length === 0) {
    return (
      <div className="workspace-tree workspace-tree-empty" style={{ height }} aria-label="Workspace files">
        <p className="review-empty">No files in this workspace.</p>
      </div>
    );
  }

  return (
    <div
      className="workspace-tree"
      style={{ height }}
      aria-label="Workspace files"
      role="tree"
    >
      {tree.children.map((child) => (
        <TreeRow
          key={child.path}
          node={child}
          depth={0}
          expanded={expanded}
          selectedPath={state.selectedPath}
          onToggle={toggleDir}
          onSelect={state.openFile}
        />
      ))}
    </div>
  );
}

function TreeRow({
  node,
  depth,
  expanded,
  selectedPath,
  onToggle,
  onSelect
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  selectedPath: string | null;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}): JSX.Element {
  const isOpen = expanded.has(node.path);
  const indent = { paddingLeft: 6 + depth * 12 } as const;
  if (node.kind === "dir") {
    return (
      <>
        <button
          type="button"
          role="treeitem"
          aria-expanded={isOpen}
          className="workspace-tree-row workspace-tree-dir"
          style={indent}
          title={node.path}
          onClick={() => onToggle(node.path)}
        >
          <ChevronRight size={12} className={`workspace-tree-chevron${isOpen ? " expanded" : ""}`} />
          <Folder size={13} />
          <span>{node.name}</span>
        </button>
        {isOpen
          ? node.children.map((child) => (
              <TreeRow
                key={child.path}
                node={child}
                depth={depth + 1}
                expanded={expanded}
                selectedPath={selectedPath}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            ))
          : null}
      </>
    );
  }
  const isSelected = selectedPath === node.path;
  return (
    <button
      type="button"
      role="treeitem"
      aria-selected={isSelected}
      aria-pressed={isSelected}
      className="workspace-tree-row workspace-tree-file"
      style={indent}
      title={node.path}
      onClick={() => onSelect(node.path)}
    >
      <span className="workspace-tree-chevron-spacer" aria-hidden="true" />
      <FileText size={13} />
      <span>{node.name}</span>
    </button>
  );
}
