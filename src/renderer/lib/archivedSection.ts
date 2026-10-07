import type { WorkspaceSummary } from "../../shared/types.js";

/**
 * Whether a chat is listed in the sidebar's Archived section. A chat whose PR
 * merged and whose checkout Argmax removed is archived too, but it stays in
 * its normal section, so the person can see what merged. It is read-only like
 * any other archived chat.
 */
export function isInArchivedSection(workspace: Pick<WorkspaceSummary, "state" | "checkoutRemovedAt">): boolean {
  return workspace.state === "archived" && !workspace.checkoutRemovedAt;
}
