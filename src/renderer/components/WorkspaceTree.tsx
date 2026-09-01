import { FileIcon, FolderIcon } from "@react-symbols/icons/utils";
import { ChevronRight, ChevronsDownUp, RotateCw } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX
} from "react";
import { buildFileTree, type TreeNode } from "../lib/fileTree.js";
import { SPECIAL_FILE_ICONS } from "../lib/specialFileIcons.js";
import type { WorkspaceFilesState } from "../hooks/useReviewState.js";

type VisibleRow = {
  node: TreeNode;
  depth: number;
};

/** Action bar over the tree: collapse-all plus the caller's re-list. It carries
 *  no title — the panel already names the source — and doubles as the tree's
 *  breathing room under the review toolbar. Omitted by surfaces that supply
 *  their own chrome (the mobile review screen, the command-palette pop-out). */
export interface WorkspaceTreeToolbar {
  onRefresh: () => void;
}

const ROW_HEIGHT = 24;
const OVERSCAN_ROWS = 8;
/** Row text starts here; with the scroller's 6px padding and the row's 2px
 *  margin this puts the depth-0 chevron 18px from the column edge, level with
 *  the review toolbar's content. */
const INDENT_BASE = 10;
const INDENT_STEP = 12;
/** Ancestor folders pinned above the scroll window, VS Code "sticky scroll"
 *  style. Capped so a deep path can't eat the viewport. */
const STICKY_MAX_ROWS = 4;

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

/** Row indexes of the folders enclosing `index`, outermost first. */
function ancestorRowIndexes(rows: VisibleRow[], index: number): number[] {
  const row = rows[index];
  if (!row) return [];
  const chain: number[] = [];
  let wanted = row.depth - 1;
  for (let i = index - 1; i >= 0 && wanted >= 0; i--) {
    const candidate = rows[i];
    if (candidate && candidate.node.kind === "dir" && candidate.depth === wanted) {
      chain.unshift(i);
      wanted -= 1;
    }
  }
  return chain;
}

/** First row index past the subtree rooted at `index`. */
function subtreeEndIndex(rows: VisibleRow[], index: number): number {
  const depth = rows[index]?.depth ?? 0;
  for (let i = index + 1; i < rows.length; i++) {
    if ((rows[i]?.depth ?? 0) <= depth) return i;
  }
  return rows.length;
}

/**
 * The sticky block for a scroll offset: the enclosing folders of whichever row
 * sits under the block's own bottom edge (solved by iteration, since pinning a
 * row changes which row is covered), plus the negative offset that slides the
 * block out of view as the deepest folder's subtree scrolls past.
 */
function stickyBlockFor(
  rows: VisibleRow[],
  scrollTop: number
): { indexes: number[]; offset: number } {
  if (rows.length === 0) return { indexes: [], offset: 0 };
  const topIndex = Math.min(rows.length - 1, Math.max(0, Math.floor(scrollTop / ROW_HEIGHT)));
  let indexes = ancestorRowIndexes(rows, topIndex).slice(-STICKY_MAX_ROWS);
  for (let pass = 0; pass < 4; pass++) {
    const covered = Math.min(rows.length - 1, topIndex + indexes.length);
    const next = ancestorRowIndexes(rows, covered).slice(-STICKY_MAX_ROWS);
    if (next.length === indexes.length) break;
    indexes = next;
  }
  if (indexes.length === 0) return { indexes, offset: 0 };
  const deepest = indexes[indexes.length - 1] ?? 0;
  const blockHeight = indexes.length * ROW_HEIGHT;
  const boundaryTop = subtreeEndIndex(rows, deepest) * ROW_HEIGHT - scrollTop;
  return { indexes, offset: Math.min(0, boundaryTop - blockHeight) };
}

export function WorkspaceTree({
  state,
  height,
  toolbar
}: {
  state: WorkspaceFilesState;
  height?: number;
  toolbar?: WorkspaceTreeToolbar;
}): JSX.Element {
  const tree = useMemo(() => buildFileTree(state.entries), [state.entries]);
  // Stable fingerprint so streaming refreshes that rebuild `entries` with the
  // same paths don't reset scroll.
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
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const pendingRevealPathRef = useRef<string | null>(null);

  // Measuring rides on the ref callback, not an effect: the loading / error /
  // empty branches below render a different element, so an effect keyed on props
  // fires while the scroll container is still unmounted and then never re-runs,
  // leaving the window frozen at the 400px seed (files below it never render).
  // With a toolbar the wrapper takes any explicit height and the scroller flexes
  // into what's left, so the tree must measure itself even when `height` is set.
  const ownsHeight = height !== undefined && toolbar === undefined;
  const attachScroll = useCallback(
    (node: HTMLDivElement | null): void => {
      scrollRef.current = node;
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      if (!node || ownsHeight) return;
      if (node.clientHeight > 0) setMeasuredHeight(node.clientHeight);
      if (typeof ResizeObserver === "undefined") return;
      const observer = new ResizeObserver((entries) => {
        const next = entries[0]?.contentRect.height;
        if (typeof next === "number" && next > 0) setMeasuredHeight(next);
      });
      observer.observe(node);
      resizeObserverRef.current = observer;
    },
    [ownsHeight]
  );

  const collapseAll = useCallback((): void => {
    setExpanded(new Set());
  }, []);

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

  useEffect(() => () => resizeObserverRef.current?.disconnect(), []);

  const effectiveHeight = ownsHeight ? height : measuredHeight;
  const visibleRows = useMemo(() => flattenVisible(tree, expanded), [tree, expanded]);
  const sticky = useMemo(() => stickyBlockFor(visibleRows, scrollTop), [visibleRows, scrollTop]);

  // `visibleRows` also changes on folder toggles; only selected-file reveals
  // should move scroll, otherwise expansion steals the user's place.
  useEffect(() => {
    pendingRevealPathRef.current = state.selectedPath;
  }, [state.selectedPath, effectiveHeight]);

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
    if (pendingRevealPathRef.current !== path) return;
    if (!path || !node) return;
    const index = visibleRows.findIndex((row) => row.node.path === path);
    if (index < 0) return;
    const rowTop = index * ROW_HEIGHT;
    const rowBottom = rowTop + ROW_HEIGHT;
    const viewTop = node.scrollTop;
    const viewBottom = viewTop + effectiveHeight;
    pendingRevealPathRef.current = null;
    if (rowTop < viewTop || rowBottom > viewBottom) {
      const target = Math.max(0, rowTop - effectiveHeight / 2);
      node.scrollTop = target;
      setScrollTop(target);
    }
  }, [state.selectedPath, visibleRows, effectiveHeight]);

  // When the parent provides an explicit height (e.g. the command palette pop-out),
  // we honour it. Otherwise we let `.workspace-tree`'s flex sizing fill the
  // available column — using inline `height: 100%` here fights the flex parent
  // and leaves the scroll container without a definite height in some layouts
  // (notably the LaunchSurface review-panel overlay), which kills scrolling.
  const containerStyle = height === undefined ? undefined : { height };
  // With a toolbar the explicit height belongs to the column wrapper; the
  // scroller flexes into the remainder.
  const bodyStyle = toolbar === undefined ? containerStyle : undefined;

  const withToolbar = (body: JSX.Element): JSX.Element => {
    if (!toolbar) return body;
    return (
      <div className="workspace-tree-col" style={containerStyle}>
        <div className="workspace-tree-toolbar">
          <button
            type="button"
            className="small-icon"
            title="Collapse all folders"
            aria-label="Collapse all folders"
            disabled={expanded.size === 0}
            onClick={collapseAll}
          >
            <ChevronsDownUp size={14} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            className="small-icon"
            title="Refresh file list"
            aria-label="Refresh file list"
            onClick={toolbar.onRefresh}
          >
            <RotateCw size={14} strokeWidth={1.75} />
          </button>
        </div>
        {body}
      </div>
    );
  };

  if (state.listState === "loading") {
    return withToolbar(
      <div className="workspace-tree workspace-tree-empty" style={bodyStyle} aria-label="Workspace files">
        <p className="review-empty">Loading files…</p>
      </div>
    );
  }

  if (state.listState === "error") {
    return withToolbar(
      <div className="workspace-tree workspace-tree-empty" style={bodyStyle} aria-label="Workspace files">
        <p className="review-empty review-error">{state.listError}</p>
      </div>
    );
  }

  if (state.listState === "ready" && state.entries.length === 0) {
    return withToolbar(
      <div className="workspace-tree workspace-tree-empty" style={bodyStyle} aria-label="Workspace files">
        <p className="review-empty">No files in this workspace.</p>
      </div>
    );
  }

  return withToolbar(
    <div
      ref={attachScroll}
      className="workspace-tree"
      style={{ ...bodyStyle, overflowY: "auto" }}
      aria-label="Workspace files"
      role="tree"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div style={{ height: totalHeight, position: "relative" }}>
        {sticky.indexes.length > 0 ? (
          // Duplicates rows that are already in the tree, so it stays out of the
          // accessibility tree and out of the tab order; the pointer still gets
          // the fold-from-here affordance.
          <div
            className="workspace-tree-sticky"
            style={{ top: scrollTop + sticky.offset }}
            aria-hidden="true"
          >
            {sticky.indexes.map((index) => {
              const row = visibleRows[index];
              if (!row) return null;
              return (
                <TreeRow
                  key={`sticky-${row.node.path}`}
                  node={row.node}
                  depth={row.depth}
                  expanded={expanded}
                  selectedPath={state.selectedPath}
                  onToggle={toggleDir}
                  onSelect={state.openFile}
                  pinned
                />
              );
            })}
          </div>
        ) : null}
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
  onSelect,
  pinned = false
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  selectedPath: string | null;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  /** Copy of a row shown in the sticky ancestor block. */
  pinned?: boolean;
}): JSX.Element {
  const isOpen = expanded.has(node.path);
  // `--tree-depth` drives the indent guides: one hairline per level the row
  // sits under, drawn as a background repeat so deep trees cost no extra DOM.
  const indent = {
    paddingLeft: INDENT_BASE + depth * INDENT_STEP,
    height: ROW_HEIGHT,
    "--tree-depth": depth
  } as CSSProperties;
  if (node.kind === "dir") {
    return (
      <button
        type="button"
        role={pinned ? undefined : "treeitem"}
        tabIndex={pinned ? -1 : undefined}
        aria-expanded={pinned ? undefined : isOpen}
        className="workspace-tree-row workspace-tree-dir"
        style={indent}
        title={node.path}
        onClick={() => onToggle(node.path)}
      >
        <ChevronRight size={12} className={`workspace-tree-chevron${isOpen ? " expanded" : ""}`} />
        <span className="workspace-tree-icon" title={`Folder icon for ${node.name}`} aria-hidden="true">
          <FolderIcon folderName={node.name} width={14} height={14} />
        </span>
        <span className="workspace-tree-label">{node.name}</span>
      </button>
    );
  }
  const isSelected = selectedPath === node.path;
  return (
    <button
      type="button"
      role={pinned ? undefined : "treeitem"}
      tabIndex={pinned ? -1 : undefined}
      aria-selected={pinned ? undefined : isSelected}
      aria-pressed={pinned ? undefined : isSelected}
      className="workspace-tree-row workspace-tree-file"
      style={indent}
      title={node.path}
      onClick={() => onSelect(node.path)}
    >
      <span className="workspace-tree-chevron-spacer" aria-hidden="true" />
      <span className="workspace-tree-icon" title={`File icon for ${node.name}`} aria-hidden="true">
        <FileIcon
          fileName={node.name}
          autoAssign
          editFileNameData={SPECIAL_FILE_ICONS}
          width={14}
          height={14}
        />
      </span>
      <span className="workspace-tree-label">{node.name}</span>
    </button>
  );
}
