/**
 * The order ⌘§ walks, and the hold it walks it during.
 *
 * ⌘§ is modelled on ⌘Tab, not on an arrow key: the stack is ordered by when
 * each chat was last used, so one press and release lands on the chat you came
 * from and the chord toggles between the two you're working in. Holding ⌘ and
 * pressing § again steps further down the stack, and only the chat you release
 * on moves to the front.
 *
 * The order is therefore frozen for the length of a hold. Promoting on every
 * step would reshuffle the stack under the next press — the chat you just left
 * would sit at position 1 again, so ⌘§⌘§ would rock between two neighbours
 * instead of reaching the third. Freezing is what makes a hold a traversal.
 *
 * Chats the sidebar no longer shows are dropped from a frozen order as it is
 * stepped, so archiving one mid-hold doesn't strand the traversal on it.
 */

/** Most-recently-used first. Session-scoped; the sidebar seeds whatever it hasn't seen. */
let recentFirst: string[] = [];

/** Non-null only between the first ⌘§ of a hold and the ⌘ coming back up. */
let hold: { order: string[]; index: number; landedId: string } | null = null;

function promote(workspaceId: string): void {
  recentFirst = [workspaceId, ...recentFirst.filter((id) => id !== workspaceId)];
}

/**
 * Every route into a chat lands here — a sidebar click, ⌘1..9, the command
 * palette, a launch, a deeplink — so recency reflects use rather than just the
 * chords that read it.
 *
 * A visit that isn't the chat this hold last stepped to came from one of those
 * other routes, which ends the hold: the user has picked a chat outright, and
 * releasing ⌘ afterwards must not pull them back to where the traversal was.
 */
export function noteChatVisited(workspaceId: string): void {
  if (hold) {
    if (workspaceId === hold.landedId) return;
    hold = null;
  }
  promote(workspaceId);
}

/**
 * Step the hold by one chat and return where to land, or `null` when there is
 * nothing to cycle through. Starts a hold if none is open.
 *
 * `step` is +1 for ⌘§ and -1 for ⌘⇧§. From the launcher, where no chat is
 * current, +1 opens the most recently used chat and -1 the least.
 */
export function stepChatCycle(
  step: 1 | -1,
  visibleIds: readonly string[],
  currentId: string | null
): string | null {
  const order = hold
    ? hold.order.filter((id) => visibleIds.includes(id))
    : buildCycleOrder(visibleIds, currentId);
  if (order.length === 0) {
    hold = null;
    return null;
  }
  const from = order.indexOf((hold ? hold.landedId : currentId) ?? "");
  let index: number;
  if (from !== -1) {
    index = (from + step + order.length) % order.length;
  } else if (hold) {
    // The chat the hold was on has left the sidebar. Keep the position and take
    // whoever slid into it, so the traversal carries on instead of snapping
    // back to where it started.
    index = hold.index % order.length;
  } else {
    // No current chat — the launcher. Forward opens the most recently used
    // chat, back the least.
    index = step === 1 ? 0 : order.length - 1;
  }
  const landedId = order[index];
  if (!landedId) return null;
  hold = { order, index, landedId };
  return landedId;
}

/**
 * Release ⌘: the chat the traversal ended on becomes the most recent, and the
 * one it started from falls to position 1 so the next ⌘§ toggles back.
 */
export function commitChatCycle(): void {
  if (!hold) return;
  const { landedId } = hold;
  hold = null;
  promote(landedId);
}

/**
 * One step that stands alone, for the native menu's Next/Previous chat items.
 * The menu sends a command rather than a keypress, so there is no ⌘ to watch
 * for and no hold to join — each invocation starts and ends its own.
 */
export function jumpToAdjacentChat(
  step: 1 | -1,
  visibleIds: readonly string[],
  currentId: string | null
): string | null {
  commitChatCycle();
  const landedId = stepChatCycle(step, visibleIds, currentId);
  commitChatCycle();
  return landedId;
}

function buildCycleOrder(visibleIds: readonly string[], currentId: string | null): string[] {
  const visible = new Set(visibleIds);
  const order: string[] = [];
  const push = (id: string): void => {
    if (!visible.has(id) || order.includes(id)) return;
    order.push(id);
  };
  if (currentId) push(currentId);
  for (const id of recentFirst) push(id);
  // Chats this app run hasn't opened have no recency of their own. They join in
  // sidebar order, behind everything that does, so the stack still reaches
  // every row on a long enough hold.
  for (const id of visibleIds) push(id);
  return order;
}

/** Drops the recency order and any open hold. Tests only. */
export function resetChatCycle(): void {
  recentFirst = [];
  hold = null;
}
