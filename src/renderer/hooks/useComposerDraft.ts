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
 * left behind.
 */
export function useComposerDraft(
  key: string | null,
  { carryTextOnRetarget = false }: { carryTextOnRetarget?: boolean } = {}
): [string, Dispatch<SetStateAction<string>>] {
  const [draft, setDraft] = useState(() => readDraft(key).text);

  // A pane that swaps targets without remounting shows the new target's own
  // text, not whatever the previous one had — unless the caller opted into the
  // retarget carry below.
  const loadedKey = useRef(key);
  const movedFrom = useRef<string | null>(null);
  if (loadedKey.current !== key) {
    const previousKey = loadedKey.current;
    loadedKey.current = key;
    const stored = readDraft(key).text;
    // A draft already waiting on the new target still wins: restoring what the
    // user left there is never worse than overwriting it.
    if (carryTextOnRetarget && draft !== "" && stored === "") {
      movedFrom.current = previousKey;
    } else {
      setDraft(stored);
    }
  }

  useEffect(() => {
    // Text only, so a project that still holds pasted screenshots keeps them.
    if (movedFrom.current) {
      writeDraftText(movedFrom.current, "");
      movedFrom.current = null;
    }
    if (key) writeDraftText(key, draft);
  }, [key, draft]);

  return [draft, setDraft];
}
