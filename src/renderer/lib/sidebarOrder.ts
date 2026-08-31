/**
 * The sidebar's session rows, in the order they are on screen.
 *
 * ⌘1..9 means "the nth row I can see", and what that resolves to depends on
 * pinning, the Priority section, which groups are collapsed, whether a group
 * is capped by "Show N more", and the projects/date view mode. Rebuilding that
 * decision here would duplicate the whole of Sidebar's layout and drift from
 * it, so the rendered list is the source of truth: each row carries its
 * workspace id and this reads them in document order.
 */
export function listVisibleSidebarWorkspaceIds(): string[] {
  if (typeof document === "undefined") return [];
  const rows = document.querySelectorAll<HTMLElement>(".project-list .session-row[data-workspace-id]");
  return Array.from(rows, (row) => row.dataset.workspaceId).filter(
    (id): id is string => Boolean(id)
  );
}
