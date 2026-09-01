/**
 * Smart-follow scroll decision for the conversation list.
 *
 * The conversation list pins itself to the bottom only when the user is
 * already near the bottom. If they've scrolled up to read, new content
 * doesn't yank them back down. A separate "Scroll to latest" FAB appears
 * once they're far enough up that the latest content is off-screen.
 *
 * A leftover-viewport spacer after the latest user message is what makes
 * "pin to bottom" put that message at the top of the pane: the spacer fills
 * whatever the new turn has not yet grown into. Follow still targets the
 * physical bottom. Extracted from SessionConversation.tsx so the thresholds
 * and the boundary conditions can be unit-tested without driving real DOM
 * layout (jsdom doesn't implement scrollHeight/clientHeight/scrollTop in a
 * useful way).
 */

/** Threshold in pixels below which the list is considered "near the bottom"
 *  and auto-follows new content. Slightly larger than the FAB threshold so
 *  there's a hysteresis band where the list is pinned but the FAB is hidden. */
export const NEAR_BOTTOM_PX = 80;

/** Threshold above which the "Scroll to latest" FAB appears. */
export const FAB_VISIBLE_PX = 120;

export interface SmartFollowDecision {
  /** True when the list should keep itself pinned to the bottom as content arrives. */
  pinToBottom: boolean;
  /** True when the "Scroll to latest" FAB should be visible. */
  showFab: boolean;
  /** Pre-computed for callers that want to log or display the gap. */
  distanceFromBottom: number;
}

/**
 * Pure decision for the conversation list given its current scroll
 * measurements. Negative distances are clamped to zero (some browsers
 * report tiny over-scroll values when smooth scrolling overshoots).
 */
export function decideSmartFollow(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number
): SmartFollowDecision {
  const raw = scrollHeight - scrollTop - clientHeight;
  const distanceFromBottom = Number.isFinite(raw) ? Math.max(0, raw) : 0;
  return {
    pinToBottom: distanceFromBottom < NEAR_BOTTOM_PX,
    showFab: distanceFromBottom > FAB_VISIBLE_PX,
    distanceFromBottom
  };
}

export interface LatestTurnSpacerArgs {
  /** Visible height of the conversation list, including padding. */
  viewportHeight: number;
  /** List padding-top. Keeps the latest user message below the edge fade. */
  paddingTop: number;
  /** List padding-bottom. Matches the constant tail gap. */
  paddingBottom: number;
  /** `offsetTop` of the latest user-message row. */
  anchorOffsetTop: number;
  /** `offsetTop + offsetHeight` of `.conversation-tail`, excluding the spacer. */
  contentEnd: number;
}

/**
 * Extra height after the latest turn so pinning to the bottom sits the
 * latest user message at the top of the pane. Shrinks as that turn grows.
 * Once the turn is taller than the pane, the spacer is 0 and follow tracks
 * the new content as usual.
 */
export function latestTurnSpacerPx(args: LatestTurnSpacerArgs): number {
  const used = args.contentEnd - args.anchorOffsetTop;
  if (!Number.isFinite(used) || !Number.isFinite(args.viewportHeight)) return 0;
  const available =
    args.viewportHeight - args.paddingTop - args.paddingBottom;
  if (!Number.isFinite(available)) return 0;
  return Math.max(0, Math.round(available - Math.max(0, used)));
}
