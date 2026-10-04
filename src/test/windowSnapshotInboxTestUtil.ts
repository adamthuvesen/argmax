import { windowSnapshotInbox } from "../renderer/lib/windowSnapshotInbox.js";

/** The payload an inbox carries, whichever module declares its type. */
export type SnapshotPayload = Parameters<typeof windowSnapshotInbox.deliver>[0];

/** Drop any capture still waiting in the shared inbox, so one test's leftovers
 *  are not offered to the next test's composer. */
export function drainWindowSnapshotInbox(): void {
  windowSnapshotInbox.subscribe(() => true)();
}
