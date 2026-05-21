import { ChevronRight, FileText, Folder } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { buildFileTree, type TreeNode } from "../lib/fileTree.js";
import type { WorkspaceFilesState } from "../hooks/useReviewState.js";

type VisibleRow = {
  node: TreeNode;
  depth: number;
};

const ROW_HEIGHT = 24;
const OVERSCAN_ROWS = 8;

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
  height?: number;
}): JSX.Element {
  const tree = useMemo(() => buildFileTree(state.entries), [state.entries]);
  // Stable fingerprint so streaming refreshes that rebuild `entries` with the
  // same paths don't reset scroll (audit-2026-05-18 M19).
  const entriesShapeKey = useMemo(() => {
    const paths = state.entries.map((entry) => entry.path);
    if (paths.length === 0) return "0";
    return `${paths.length}:${paths[0] ?? ""}:${paths[paths.length - 1] ?? ""}`;
  }, [state.entries]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [scrollTop, setScrollTop] = useState(0);
  // Fallback used when `height` is omitted — the tree fills a flex parent and
  // measures its own scroll container. Seed at 400px so the first paint shows
  // rows before the ResizeObserver fires (it yields 0 for one frame on mount).
  const [measuredHeight, setMeasuredHeight] = useState(400);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const toggleDir = useCallback((path: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // When a file is selected from outside (quick-open, restored state),
  // make sure every ancestor directory is expanded so the row is visible.
  useEffect(() => {
    const path = state.selectedPath;
    if (!path) return;
    const segments = path.split("/");
    if (segments.length <= 1) return;
    setExpanded((current) => {
      let changed = false;
      const next = new Set(current);
      for (let i = 1; i < segments.length; i++) {
        const ancestor = segments.slice(0, i).join("/");
        if (!next.has(ancestor)) {
          next.add(ancestor);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [state.selectedPath]);

  useEffect(() => {
    if (height !== undefined) return;
    const node = scrollRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.height;
      if (typeof next === "number" && next > 0) setMeasuredHeight(next);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [height]);

  const effectiveHeight = height ?? measuredHeight;
  const visibleRows = useMemo(() => flattenVisible(tree, expanded), [tree, expanded]);

  // Recompute window bounds whenever scroll or content changes. The slice is
  // small (height/ROW_HEIGHT + overscan); 10k entries collapse to ~30 rendered
  // DOM nodes at default viewport sizes.
  const totalHeight = visibleRows.length * ROW_HEIGHT;
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS);
  const endIndex = Math.min(
    visibleRows.length,
    Math.ceil((scrollTop + effectiveHeight) / ROW_HEIGHT) + OVERSCAN_ROWS
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
  }, [entriesShapeKey]);

  // Center the selected row when it sits outside the current scroll window.
  useEffect(() => {
    const path = state.selectedPath;
    const node = scrollRef.current;
    if (!path || !node) return;
    const index = visibleRows.findIndex((row) => row.node.path === path);
    if (index < 0) return;
    const rowTop = index * ROW_HEIGHT;
    const rowBottom = rowTop + ROW_HEIGHT;
    const viewTop = node.scrollTop;
    const viewBottom = viewTop + effectiveHeight;
    if (rowTop >= viewTop && rowBottom <= viewBottom) return;
    const target = Math.max(0, rowTop - effectiveHeight / 2);
    node.scrollTop = target;
    setScrollTop(target);
  }, [state.selectedPath, visibleRows, effectiveHeight]);

  // When the parent provides an explicit height (e.g. the command palette pop-out),
  // we honour it. Otherwise we let `.workspace-tree`'s flex sizing fill the
  // available column — using inline `height: 100%` here fights the flex parent
  // and leaves the scroll container without a definite height in some layouts
  // (notably the LaunchSurface review-panel overlay), which kills scrolling.
  const containerStyle = height === undefined ? undefined : { height };

  if (state.listState === "loading") {
    return (
      <div className="workspace-tree workspace-tree-empty" style={containerStyle} aria-label="Workspace files">
        <p className="review-empty">Loading files…</p>
      </div>
    );
  }

  if (state.listState === "error") {
    return (
      <div className="workspace-tree workspace-tree-empty" style={containerStyle} aria-label="Workspace files">
        <p className="review-empty review-error">{state.listError}</p>
      </div>
    );
  }

  if (state.listState === "ready" && state.entries.length === 0) {
    return (
      <div className="workspace-tree workspace-tree-empty" style={containerStyle} aria-label="Workspace files">
        <p className="review-empty">No files in this workspace.</p>
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className="workspace-tree"
      style={{ ...containerStyle, overflowY: "auto" }}
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
