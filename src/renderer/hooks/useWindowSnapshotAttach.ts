import { useEffect, useRef } from "react";
import type { ComposerAttachment } from "../../shared/types.js";
import { isSupportedImageMime } from "../lib/composerAttachments.js";
import { windowSnapshotInbox } from "../lib/windowSnapshotInbox.js";
import { showErrorToast } from "../state/toast.js";

// The payload type is the inbox's own, whichever module declares it.
type WindowSnapshotAttach = Parameters<Parameters<typeof windowSnapshotInbox.subscribe>[0]>[0];
/** A capture whose image type the composer can send. */
export type ComposerSnapshotAttach = Omit<WindowSnapshotAttach, "attachment"> & {
  attachment: ComposerAttachment;
};

/**
 * Take window captures for this composer while it is the one in use.
 *
 * `active` is the composer's own answer to "is this the one the user is
 * working in": its pane is focused, it has a draft to attach to, and it is not
 * mid-send. It is not "was mounted last". A hidden pane or a cell beside the
 * focused one never listens, so a capture cannot land in a draft nobody is
 * looking at; with no composer listening, the inbox keeps the capture for the
 * next one that does.
 *
 * A floating composer (the "More details" popup, the Multitask dock) sits over
 * or beside the chat and is active in the same pane. It wins: the chat composer
 * declines while one is active, however recently the chat re-subscribed after a
 * send, because the inbox asks the newest listener first and the person is
 * working in the floating one.
 */
let activeFloatingComposers = 0;

export function useWindowSnapshotAttach(
  active: boolean,
  onAttach: (snapshot: ComposerSnapshotAttach) => void,
  floating = false
): void {
  const latest = useRef(onAttach);
  latest.current = onAttach;
  useEffect(() => {
    if (!active) return undefined;
    if (floating) activeFloatingComposers += 1;
    const unsubscribe = windowSnapshotInbox.subscribe((snapshot) => {
      if (!floating && activeFloatingComposers > 0) return false;
      // Claimed either way: another composer would reject the same file.
      if (isSupportedImageMime(snapshot.attachment.mimeType)) {
        latest.current({
          ...snapshot,
          attachment: { ...snapshot.attachment, mimeType: snapshot.attachment.mimeType }
        });
      } else {
        showErrorToast(`The window capture is a ${snapshot.attachment.mimeType} file, which cannot be attached.`);
      }
      return true;
    });
    return () => {
      unsubscribe();
      if (floating) activeFloatingComposers -= 1;
    };
  }, [active, floating]);
}
