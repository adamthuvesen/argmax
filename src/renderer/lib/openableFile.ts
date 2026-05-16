import type { ArgmaxApi } from "../../shared/types.js";

/**
 * Resolve a path that came from agent text (chip / link) into a workspace-
 * relative path we can actually open, or null if we can't confidently locate
 * it. The agent often references files by bare basename (e.g.
 * `research_journal.md`); silently opening the right-panel onto a path that
 * doesn't exist surfaces a confusing IPC error, so we pre-check.
 *
 * Resolution order:
 *  1. Literal path — if stat succeeds, use it as-is.
 *  2. Path contains a separator — trust the agent's directory context; if
 *     stat fails, give up (don't guess at sibling files).
 *  3. Bare basename — list workspace files; if exactly one entry has that
 *     basename, use its path. Multiple matches are ambiguous → null.
 */
export async function resolveOpenablePath(
  api: ArgmaxApi | undefined,
  workspaceId: string,
  path: string
): Promise<string | null> {
  if (!api) return null;
  try {
    await api.workspace.statFile(workspaceId, path);
    return path;
  } catch {
    // fall through to basename resolution
  }
  if (path.includes("/")) return null;
  let entries;
  try {
    entries = await api.workspace.listFiles(workspaceId);
  } catch {
    return null;
  }
  const matches = entries.filter((entry) => {
    if (entry.path === path) return true;
    const slash = entry.path.lastIndexOf("/");
    return slash >= 0 && entry.path.slice(slash + 1) === path;
  });
  const only = matches.length === 1 ? matches[0] : undefined;
  return only ? only.path : null;
}
