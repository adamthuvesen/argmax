/** Files open as tabs in the review panel ride along with composer sends as
 *  `@path` references, so the agent sees what the user is looking at without
 *  a manual @-mention. Renderer-side only: like annotations, the paths are
 *  serialized into the prompt text at send time. */

/** Open-tab paths with the active tab first, preserving tab order otherwise. */
export function orderedOpenFilePaths(
  tabs: readonly { path: string }[],
  activeTabPath: string | null
): string[] {
  const paths = tabs.map((tab) => tab.path);
  if (activeTabPath === null || !paths.includes(activeTabPath)) return paths;
  return [activeTabPath, ...paths.filter((path) => path !== activeTabPath)];
}

/** Short text for the open-files chip above the composer. */
export function openFilesChipLabel(paths: readonly string[]): string {
  const name = paths[0]?.split("/").pop() ?? "";
  return paths.length > 1 ? `Open files: ${name} +${paths.length - 1}` : `Open file: ${name}`;
}

/**
 * Appends the open files as `@path` references after the typed message.
 * Paths the user already @-mentioned are skipped; no-op when nothing is left.
 */
export function appendOpenFilesToPrompt(prompt: string, paths: readonly string[]): string {
  const unmentioned = paths.filter((path) => !prompt.includes(`@${path}`));
  if (unmentioned.length === 0) return prompt;
  const refs = unmentioned.map((path) => `@${path}`).join("\n");
  return `${prompt}\n\nFor context, I have these files open in the editor:\n${refs}`;
}
