import type { WorkspaceFileEntry } from "../../shared/types.js";

export type TreeNode = {
  name: string;
  path: string;
  kind: "dir" | "file";
  children: TreeNode[];
};

/**
 * Build a directory tree from a flat list of `path/to/file`-shaped entries.
 *
 * Per-cursor `Map<segment, TreeNode>` index keeps the inner lookup O(1).
 * The prior `cursor.children.find(...)` shape was O(n²) on wide directories.
 */
export function buildFileTree(entries: WorkspaceFileEntry[]): TreeNode {
  const root: TreeNode = { name: "", path: "", kind: "dir", children: [] };
  const indexes = new WeakMap<TreeNode, Map<string, TreeNode>>();
  indexes.set(root, new Map());
  for (const entry of entries) {
    const segments = entry.path.split("/").filter(Boolean);
    let cursor = root;
    for (const [i, segment] of segments.entries()) {
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
