import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { readDraft, writeDraftText } from "../lib/composerDrafts.js";

/**
 * Composer text for one draft key, as `useState` with a memory.
 *
 * Unsent text belongs to what it targets: a session for the session
 * composer or a project for the new-session launcher. It outlives the
 * composer: switching panes remounts the component, and the draft comes back
 * when the target does, across an app restart too. Sending clears the text,
 * which drops the stored draft with it. Pasted screenshots ride along in the
 * same entry. See `useComposerAttachments`.
 *
 * `carryTextOnRetarget` is for composers the user retargets mid-sentence — the
 * launcher's project picker. There the typed text is aimed at whatever repo is
 * selected when they hit send, so it moves to the new target instead of being
 * left behind — even over a stale draft stored on that target, which it
 * replaces.
 */
export function useComposerDraft(
  key: string | null,
  { carryTextOnRetarget = false }: { carryTextOnRetarget?: boolean } = {}
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
    // Text the user is mid-writing always wins: it is what they are aiming at
    // the new target right now, while a draft stored there is at best stale.
    // The write effect below replaces the stored one.
    if (carryTextOnRetarget && draft !== "") {
      movedFrom.current = previousKey;
      carriedOnRetarget = true;
    } else {
      setDraft(readDraft(key).text);
    }
  }

  useEffect(() => {
    // Text only here; `useComposerAttachments` clears the same key's images on
    // the same carry, so the source draft ends up empty rather than half-moved.
    if (movedFrom.current) {
      writeDraftText(movedFrom.current, "");
      movedFrom.current = null;
    }
    if (key) writeDraftText(key, draft);
  }, [key, draft]);

  return [draft, setDraft, carriedOnRetarget];
}
