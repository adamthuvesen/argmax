import { ChevronRight, FileText, Folder } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import type { WorkspaceFileEntry } from "../../shared/types.js";
import type { WorkspaceFilesState } from "../hooks/useReviewState.js";

type TreeNode = {
  name: string;
  path: string;
  kind: "dir" | "file";
  children: TreeNode[];
};

type VisibleRow = {
  node: TreeNode;
  depth: number;
};

const ROW_HEIGHT = 24;
const OVERSCAN_ROWS = 8;

function buildFileTree(entries: WorkspaceFileEntry[]): TreeNode {
  const root: TreeNode = { name: "", path: "", kind: "dir", children: [] };
  // Per-cursor `Map<segment, TreeNode>` makes the inner lookup O(1). The
  // previous `cursor.children.find(...)` made the build O(n²) for wide
  // directories with many siblings.
  const indexes = new WeakMap<TreeNode, Map<string, TreeNode>>();
  indexes.set(root, new Map());
  for (const entry of entries) {
    const segments = entry.path.split("/").filter(Boolean);
    let cursor = root;
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i];
      if (!segment) continue;
      const isLast = i === segments.length - 1;
      const childPath = cursor.path ? `${cursor.path}/${segment}` : segment;
      const cursorIndex = indexes.get(cursor);
      if (!cursorIndex) {
        throw new Error("buildFileTree: missing index for cursor");
      }
      let next = cursorIndex.get(segment);
      if (!next) {
        next = {
          name: segment,
          path: childPath,
          kind: isLast ? "file" : "dir",
          children: []
        };
        cursor.children.push(next);
        cursorIndex.set(segment, next);
        indexes.set(next, new Map());
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

function flattenVisible(root: TreeNode, expanded: Set<string>): VisibleRow[] {
  const rows: VisibleRow[] = [];
  const walk = (node: TreeNode, depth: number): void => {
    for (const child of node.children) {
      rows.push({ node: child, depth });
      if (child.kind === "dir" && expanded.has(child.path)) {
        walk(child, depth + 1);
      }
    }
  };
  walk(root, 0);
  return rows;
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
  const [scrollTop, setScrollTop] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const toggleDir = useCallback((path: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const visibleRows = useMemo(() => flattenVisible(tree, expanded), [tree, expanded]);

  // Recompute window bounds whenever scroll or content changes. The slice is
  // small (height/ROW_HEIGHT + overscan); 10k entries collapse to ~30 rendered
  // DOM nodes at default viewport sizes.
  const totalHeight = visibleRows.length * ROW_HEIGHT;
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS);
  const endIndex = Math.min(
    visibleRows.length,
    Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN_ROWS
  );
  const visibleSlice = visibleRows.slice(startIndex, endIndex);
  const topPad = startIndex * ROW_HEIGHT;
  const bottomPad = Math.max(0, totalHeight - endIndex * ROW_HEIGHT);

  // Reset scroll when the entries change underneath us — otherwise the
  // virtualized window can sit on top of an empty range and look broken.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
    setScrollTop(0);
  }, [tree]);

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
      ref={scrollRef}
      className="workspace-tree"
      style={{ height, overflowY: "auto" }}
      aria-label="Workspace files"
      role="tree"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div style={{ height: totalHeight, position: "relative" }}>
        <div style={{ height: topPad }} aria-hidden="true" />
        {visibleSlice.map((row) => (
          <TreeRow
            key={row.node.path}
            node={row.node}
            depth={row.depth}
            expanded={expanded}
            selectedPath={state.selectedPath}
            onToggle={toggleDir}
            onSelect={state.openFile}
          />
        ))}
        <div style={{ height: bottomPad }} aria-hidden="true" />
      </div>
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
  const indent = { paddingLeft: 6 + depth * 12, height: ROW_HEIGHT } as const;
  if (node.kind === "dir") {
    return (
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
