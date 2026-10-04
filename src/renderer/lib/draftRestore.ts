import type { ComposerAttachment } from "../../shared/types.js";

/**
 * Put a draft back after a send that failed behind the user's back. A
 * background send empties the composer at once so the next draft can start,
 * and by the time it fails the person may already be typing it. The restored
 * draft goes above what they typed (it would have been sent first), and
 * neither is thrown away.
 */
export function restoreDraftText(current: string, restored: string): string {
  if (restored.trim() === "") return current;
  return current.trim() === "" ? restored : `${restored}\n\n${current}`;
}

/** The restored attachments first, then any the person has added since, once each. */
export function restoreDraftAttachments(
  current: readonly ComposerAttachment[],
  restored: readonly ComposerAttachment[]
): ComposerAttachment[] {
  const seen = new Set<string>();
  const merged: ComposerAttachment[] = [];
  for (const attachment of [...restored, ...current]) {
    if (seen.has(attachment.filePath)) continue;
    seen.add(attachment.filePath);
    merged.push(attachment);
  }
  return merged;
}
