/** Which side of the agent chat the Review // Files panel docks on. */
export type ReviewPanelSide = "left" | "right";

export const REVIEW_PANEL_SIDE_KEY = "argmax.review.panelSide";
export const DEFAULT_REVIEW_PANEL_SIDE: ReviewPanelSide = "right";

export function readStoredReviewPanelSide(): ReviewPanelSide {
  if (typeof window === "undefined") return DEFAULT_REVIEW_PANEL_SIDE;
  try {
    const stored = window.localStorage.getItem(REVIEW_PANEL_SIDE_KEY);
    return stored === "left" || stored === "right" ? stored : DEFAULT_REVIEW_PANEL_SIDE;
  } catch {
    return DEFAULT_REVIEW_PANEL_SIDE;
  }
}
