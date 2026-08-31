/** A file path as chat shows it: workspace-relative when it sits under the
 *  session's cwd, untouched otherwise. Agents report absolute paths, and the
 *  review panel keys on relative ones, so every chat surface that names a file
 *  relativizes the same way. */
export function displayPath(path: string, cwd: string | null | undefined): string {
  if (!cwd) return path;
  const normalized = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return path.startsWith(normalized) ? path.slice(normalized.length) : path;
}
