import type { WindowSnapshotAttach, WindowSnapshotFailure } from "../../shared/types.js";
import { showErrorToast } from "../state/toast.js";

/**
 * A composer that can take a window snapshot says so by returning `true`; one
 * that cannot (it is not the active composer, or its draft is sending)
 * returns `false` and the next one is asked.
 */
export type SnapshotClaim = (snapshot: WindowSnapshotAttach) => boolean;

/** A capture nobody claims waits for the next composer, but not forever. */
const MAX_UNCLAIMED = 3;
/** A minute is a pause to open a chat; after that the capture is stale and
 *  attaching it to an unrelated draft would be a surprise. */
export const UNCLAIMED_TTL_MS = 60_000;

/**
 * Hands each captured window to exactly one composer.
 *
 * The host sends one event to one window. Inside it, several composers can be
 * mounted at once (a grid of chats plus the launcher), and only the active one
 * should take the image: listeners are asked newest first and the first to
 * claim it ends the offer. With none mounted, such as Settings in front, the
 * capture is kept for [`UNCLAIMED_TTL_MS`] and offered to the next composer
 * that subscribes within that time; later ones find nothing.
 */
export function createWindowSnapshotInbox(now: () => number = Date.now): {
  deliver: (snapshot: WindowSnapshotAttach) => void;
  subscribe: (claim: SnapshotClaim) => () => void;
  unclaimedCount: () => number;
} {
  const listeners: SnapshotClaim[] = [];
  let unclaimed: { snapshot: WindowSnapshotAttach; at: number }[] = [];

  const dropExpired = (): void => {
    const cutoff = now() - UNCLAIMED_TTL_MS;
    unclaimed = unclaimed.filter((entry) => entry.at > cutoff);
  };

  const offer = (snapshot: WindowSnapshotAttach): boolean => {
    for (let index = listeners.length - 1; index >= 0; index -= 1) {
      if (listeners[index]?.(snapshot)) return true;
    }
    return false;
  };

  return {
    deliver(snapshot) {
      if (offer(snapshot)) return;
      dropExpired();
      unclaimed = [...unclaimed, { snapshot, at: now() }].slice(-MAX_UNCLAIMED);
    },
    subscribe(claim) {
      listeners.push(claim);
      dropExpired();
      unclaimed = unclaimed.filter((entry) => !claim(entry.snapshot));
      return () => {
        const index = listeners.indexOf(claim);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    unclaimedCount: () => {
      dropExpired();
      return unclaimed.length;
    }
  };
}

export const windowSnapshotInbox = createWindowSnapshotInbox();

/**
 * Wire the host's events to the inbox and to the error toast. Mount once, in
 * the app shell. A failure is always shown: a chord that quietly did nothing is
 * the one outcome worse than an error.
 */
export function startWindowSnapshotInbox(
  api: {
    onAttach: (listener: (snapshot: WindowSnapshotAttach) => void) => () => void;
    onFailed: (listener: (failure: WindowSnapshotFailure) => void) => () => void;
  },
  inbox: Pick<typeof windowSnapshotInbox, "deliver"> = windowSnapshotInbox
): () => void {
  const stopAttach = api.onAttach((snapshot) => inbox.deliver(snapshot));
  const stopFailed = api.onFailed((failure) => showErrorToast(failure.message));
  return () => {
    stopAttach();
    stopFailed();
  };
}

/** `Appname — Window title`, or just the app when the window has no title. */
export function windowSnapshotLabel(snapshot: WindowSnapshotAttach): string {
  const { appName, windowTitle } = snapshot.source;
  return windowTitle ? `${appName} — ${windowTitle}` : appName;
}
