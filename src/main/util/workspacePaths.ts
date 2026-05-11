import { resolve, sep } from "node:path";

/**
 * Resolve filePath against the workspace root and assert the canonical result
 * stays inside it — defense against symlinks or constructed paths that would
 * redirect access into another tree. Shape validation (no absolute paths,
 * no `..`, no leading `-`) is enforced separately by `relativeFilePathSchema`
 * at the IPC boundary; this is the runtime check after resolution.
 */
export function assertSafeRelativePath(workspaceRoot: string, filePath: string): void {
  const resolved = resolve(workspaceRoot, filePath);
  assertContainedPath(workspaceRoot, resolved, "filePath escapes the workspace root");
}

export function assertContainedPath(root: string, candidate: string, message: string): void {
  const rootPrefix = root.endsWith(sep) ? root : root + sep;
  if (candidate !== root && !candidate.startsWith(rootPrefix)) {
    throw new Error(message);
  }
}
