import type { GhPrRecord, SessionPrSummary, WorkspaceSummary } from "../../shared/types.js";

/**
 * Renderer view of the session association carried on `WorkspaceSummary`.
 * The generated binding is wired in shared/types; keeping the structural
 * alias here lets old dashboard hosts omit the new projection while the
 * renderer still supports the scalar PR fields they already send.
 */
export type WorkspaceSessionPr = SessionPrSummary;

/**
 * The dashboard projection is the one source for card, menu, and sidebar PR
 * state. An absent array means an older host; an empty array is authoritative.
 */
export function workspaceSessionPrs(workspace: WorkspaceSummary | null): readonly WorkspaceSessionPr[] {
  if (!workspace) return [];
  return workspace.prs ?? [];
}

export function primaryWorkspacePr(workspace: WorkspaceSummary | null): WorkspaceSessionPr | null {
  const prs = workspaceSessionPrs(workspace);
  if (prs.length === 0) return null;
  return prs.find((pr) => pr.isPrimary) ?? prs[0] ?? null;
}

/** State used by both the sidebar marker and Priority placement. */
export function workspacePrSummaryState(workspace: WorkspaceSummary): string | null {
  const summary = workspace.prSummaryState;
  return summary === undefined ? workspace.prState : summary;
}

/** Unverified discoveries stay in the card for repair, but do not speak for the sidebar. */
export function verifiedWorkspacePrs(workspace: WorkspaceSummary): readonly WorkspaceSessionPr[] {
  return workspaceSessionPrs(workspace).filter((pr) => pr.relationship !== "unverified");
}

export function workspacePrCountLabel(workspace: WorkspaceSummary): string | null {
  const prs = verifiedWorkspacePrs(workspace);
  if (prs.length === 0) return null;
  const counts = new Map<string, number>();
  for (const pr of prs) {
    const state = pr.prState?.toLowerCase() ?? "unknown";
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  const order = ["open", "merged", "closed", "unknown"];
  return order
    .flatMap((state) => {
      const count = counts.get(state);
      return count ? [`${count} ${state}`] : [];
    })
    .join(" · ");
}

/** Refreshes in flight, keyed by session. */
const pending = new Map<string, Promise<GhPrRecord[]>>();

/**
 * `prs:refresh` for one session, collapsed across callers.
 *
 * The refresh shells out to `gh` over the network — measured 2026-09-10 at
 * 460–915 ms per call — and two independent surfaces ask for it the moment a
 * session opens: the chat actions menu wants the rows, and the workspace card
 * wants the workspace publish the refresh performs on its way out. Left alone
 * they fire the same `gh pr view` twice in the same tick on every switch.
 *
 * `null` when the host has no gh channel at all.
 */
export function refreshSessionPrs(sessionId: string): Promise<GhPrRecord[]> | null {
  const inFlight = pending.get(sessionId);
  if (inFlight) return inFlight;
  // Surfaces that reach Argmax without the gh channel (the phone companion)
  // keep whatever rows they already have rather than being handed an empty list.
  const refreshPrs = window.argmax?.prs?.refresh;
  if (!refreshPrs) return null;
  const refresh = refreshPrs({ sessionId }).finally(() => {
    pending.delete(sessionId);
  });
  pending.set(sessionId, refresh);
  return refresh;
}
