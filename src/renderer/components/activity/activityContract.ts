/**
 * The `activity:summary` wire contract, re-exported from the generated
 * bindings so every component on the page names a field exactly once and
 * exactly as `tauri-specta` emitted it (docs/adr, `hand-written-type-mirrors`).
 *
 * JSON is camelCase. Timestamps are RFC 3339 UTC strings; dates are
 * `YYYY-MM-DD` in the caller's `timeZone`.
 */
export type {
  ActivityCadence,
  ActivityGithubState,
  ActivityHeatmapDay,
  ActivityPrState,
  ActivityPullRequest,
  ActivityRepository,
  ActivityResolution,
  ActivityReview,
  ActivityReviewState,
  ActivityScanPhase,
  ActivityScanState,
  ActivitySeriesPoint,
  ActivitySeriesRepository,
  ActivityStreaks,
  ActivitySummary,
  ActivitySummaryInput,
  ActivityTotals,
  ActivityWindow
} from "../../../shared/bindings.js";
