/**
 * Persistent model identity: only render the "GPT-5.5"-style subtitle on
 * the first turn of a consecutive run with the same model. Today the parent
 * passes one model label to every turn, so this resolves to "first turn
 * only" — but the dedupe is computed correctly so a future per-turn model
 * switch will surface a new header at the boundary.
 *
 * Keyed by the renderItems index so the caller looks up `map.get(index)`
 * for each turn item it renders. The accepted item shape is intentionally
 * structural — any union that has `kind: "turn"` for turn rows works.
 */
export function computeTurnModelHeaderMap(
  renderItems: readonly { kind: string }[],
  selectedModelLabel: string
): Map<number, boolean> {
  const map = new Map<number, boolean>();
  let lastShownModelLabel: string | null = null;
  renderItems.forEach((item, index) => {
    if (item.kind !== "turn") return;
    const show = lastShownModelLabel !== selectedModelLabel;
    map.set(index, show);
    if (show) lastShownModelLabel = selectedModelLabel;
  });
  return map;
}
