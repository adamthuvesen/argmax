export type ReviewPanelMode = "changes" | "files" | "agents" | "browser" | "terminal";

export interface ReviewLayout {
  modes: [ReviewPanelMode] | [ReviewPanelMode, ReviewPanelMode];
  activeIndex: 0 | 1;
  ratio: number;
}

export type ReviewSplitPosition = "top" | "bottom";

export const DEFAULT_REVIEW_SPLIT_RATIO = 0.5;
export const MIN_REVIEW_SPLIT_RATIO = 0.2;
export const MAX_REVIEW_SPLIT_RATIO = 0.8;

const REVIEW_PANEL_MODES: readonly ReviewPanelMode[] = [
  "changes",
  "files",
  "agents",
  "browser",
  "terminal"
];

export function isReviewPanelMode(value: unknown): value is ReviewPanelMode {
  return typeof value === "string" && REVIEW_PANEL_MODES.includes(value as ReviewPanelMode);
}

export function createReviewLayout(mode: ReviewPanelMode): ReviewLayout {
  return { modes: [mode], activeIndex: 0, ratio: DEFAULT_REVIEW_SPLIT_RATIO };
}

export function clampReviewSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return DEFAULT_REVIEW_SPLIT_RATIO;
  return Math.min(MAX_REVIEW_SPLIT_RATIO, Math.max(MIN_REVIEW_SPLIT_RATIO, ratio));
}

export function parseReviewLayout(stored: string | null): ReviewLayout | null {
  if (!stored) return null;
  try {
    const value = JSON.parse(stored) as {
      modes?: unknown;
      activeIndex?: unknown;
      ratio?: unknown;
    };
    if (!Array.isArray(value.modes) || value.modes.length < 1 || value.modes.length > 2) return null;
    if (!value.modes.every(isReviewPanelMode)) return null;
    if (value.modes.length === 2 && value.modes[0] === value.modes[1]) return null;
    if (value.activeIndex !== 0 && value.activeIndex !== 1) return null;
    if (value.modes.length === 1 && value.activeIndex !== 0) return null;
    if (typeof value.ratio !== "number") return null;
    return {
      modes: value.modes as [ReviewPanelMode] | [ReviewPanelMode, ReviewPanelMode],
      activeIndex: value.activeIndex,
      ratio: clampReviewSplitRatio(value.ratio)
    };
  } catch {
    return null;
  }
}

export function normalizeReviewLayout(
  layout: ReviewLayout,
  availableModes: readonly ReviewPanelMode[]
): ReviewLayout {
  const available = new Set(availableModes);
  const wantedPaneCount = layout.modes.length;
  const modes: ReviewPanelMode[] = [];
  for (const mode of layout.modes) {
    if (available.has(mode) && !modes.includes(mode)) modes.push(mode);
  }
  for (const fallback of availableModes) {
    if (modes.length >= wantedPaneCount || modes.length >= 2) break;
    if (!modes.includes(fallback)) modes.push(fallback);
  }
  if (modes.length === 0) modes.push("changes");

  const activeMode = layout.modes.length === 2 ? layout.modes[layout.activeIndex] : layout.modes[0];
  const activeIndex = modes.indexOf(activeMode);
  return {
    modes: modes as [ReviewPanelMode] | [ReviewPanelMode, ReviewPanelMode],
    activeIndex: (activeIndex >= 0 ? activeIndex : 0) as 0 | 1,
    ratio: clampReviewSplitRatio(layout.ratio)
  };
}

export function activateReviewMode(layout: ReviewLayout, mode: ReviewPanelMode): ReviewLayout {
  const existingIndex = layout.modes.indexOf(mode);
  if (existingIndex >= 0) {
    if (layout.activeIndex === existingIndex) return layout;
    return { ...layout, activeIndex: existingIndex as 0 | 1 };
  }
  const modes: ReviewLayout["modes"] = [...layout.modes];
  modes[layout.activeIndex] = mode;
  return { ...layout, modes };
}

export function setReviewPaneMode(
  layout: ReviewLayout,
  index: 0 | 1,
  mode: ReviewPanelMode
): ReviewLayout {
  if (index >= layout.modes.length) return layout;
  const existingIndex = layout.modes.indexOf(mode);
  const modes: ReviewLayout["modes"] = [...layout.modes];
  if (existingIndex >= 0 && existingIndex !== index && modes.length === 2) {
    modes[existingIndex] = modes[index];
  }
  modes[index] = mode;
  return { ...layout, modes, activeIndex: index };
}

function fallbackSplitMode(mode: ReviewPanelMode): ReviewPanelMode {
  return mode === "changes" ? "files" : "changes";
}

export function splitReviewMode(
  layout: ReviewLayout,
  mode: ReviewPanelMode,
  position: ReviewSplitPosition
): ReviewLayout {
  const targetIndex: 0 | 1 = position === "top" ? 0 : 1;
  if (layout.modes.length === 1) {
    const currentMode = layout.modes[0];
    const insertedMode = currentMode === mode ? fallbackSplitMode(currentMode) : mode;
    const modes: [ReviewPanelMode, ReviewPanelMode] =
      position === "top" ? [insertedMode, currentMode] : [currentMode, insertedMode];
    return { ...layout, modes, activeIndex: targetIndex };
  }

  const existingIndex = layout.modes.indexOf(mode);
  if (existingIndex === targetIndex) return { ...layout, activeIndex: targetIndex };
  if (existingIndex >= 0) {
    return {
      ...layout,
      modes: [layout.modes[1], layout.modes[0]],
      activeIndex: targetIndex
    };
  }
  const modes: [ReviewPanelMode, ReviewPanelMode] = [...layout.modes];
  modes[targetIndex] = mode;
  return { ...layout, modes, activeIndex: targetIndex };
}

export function closeReviewPane(layout: ReviewLayout, index: 0 | 1): ReviewLayout {
  if (layout.modes.length === 1 || index >= layout.modes.length) return layout;
  return {
    modes: [layout.modes[index === 0 ? 1 : 0]],
    activeIndex: 0,
    ratio: layout.ratio
  };
}

export function setReviewSplitRatio(layout: ReviewLayout, ratio: number): ReviewLayout {
  const nextRatio = clampReviewSplitRatio(ratio);
  return nextRatio === layout.ratio ? layout : { ...layout, ratio: nextRatio };
}
