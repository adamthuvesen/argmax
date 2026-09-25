import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { clearDraft, readDraft, writeDraftText } from "../lib/composerDrafts.js";

/**
 * Composer text for one draft key, as `useState` with a memory.
 *
 * Unsent text belongs to what it targets: a session for the session
 * composer or a project for the new-session launcher. It outlives the
 * composer: switching panes remounts the component, and the draft comes back
 * when the target does, across an app restart too. Sending drops the stored
 * entry and on-screen text immediately (see `persist`). A failed delivery
 * restores both. Pasted screenshots ride along in the same entry.
 * See `useComposerAttachments`.
 *
 * `carryTextOnRetarget` is for the launcher's project picker. The unsent text
 * and images move to the selected repo together, even over a stale draft on
 * that target. An image-only draft moves with its empty text too.
 *
 * `persist` is the send lock. A submit must not keep the sent value in storage:
 * launching can unmount the composer, and the next NEW CHAT would otherwise
 * remount from the stored entry. Flip this off as soon as send starts.
 */
export function useComposerDraft(
  key: string | null,
  { carryTextOnRetarget = false, persist = true }: { carryTextOnRetarget?: boolean; persist?: boolean } = {}
): [string, Dispatch<SetStateAction<string>>, boolean] {
  const [draft, setDraft] = useState(() => readDraft(key).text);

  // A pane that swaps targets without remounting shows the new target's own
  // text, not whatever the previous one had — unless the caller opted into the
  // retarget carry below.
  const loadedKey = useRef(key);
  const movedFrom = useRef<string | null>(null);
  // True for the render that carried text onto a new key. Pasted screenshots
  // belong to the sentence that describes them, so `useComposerAttachments`
  // reads this to move them along instead of swapping in the new target's.
  let carriedOnRetarget = false;
  if (loadedKey.current !== key) {
    const previousKey = loadedKey.current;
    loadedKey.current = key;
    // The current draft wins when it holds text or images. Keeping an empty
    // text value for image-only drafts prevents the target's stale text from
    // being paired with the carried screenshot.
    // The write effect below replaces the stored one.
    if (carryTextOnRetarget && (draft !== "" || readDraft(previousKey).attachments.length > 0)) {
      movedFrom.current = previousKey;
      carriedOnRetarget = true;
    } else {
      setDraft(readDraft(key).text);
    }
  }

  useEffect(() => {
    // Text only here; `useComposerAttachments` clears the same key's images on
    // the same carry, so the source draft ends up empty rather than half-moved.
    if (!persist) {
      if (key) clearDraft(key);
      return;
    }
    if (movedFrom.current) {
      writeDraftText(movedFrom.current, "");
      movedFrom.current = null;
    }
    if (key) writeDraftText(key, draft);
  }, [key, draft, persist]);

  return [draft, setDraft, carriedOnRetarget];
}
