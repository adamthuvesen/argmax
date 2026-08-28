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
 */
export function useComposerDraft(key: string | null): [string, Dispatch<SetStateAction<string>>] {
  const [draft, setDraft] = useState(() => readDraft(key).text);

  // A pane that swaps targets without remounting must not carry the previous
  // one's text into the new one.
  const loadedKey = useRef(key);
  if (loadedKey.current !== key) {
    loadedKey.current = key;
    setDraft(readDraft(key).text);
  }

  useEffect(() => {
    if (key) writeDraftText(key, draft);
  }, [key, draft]);

  return [draft, setDraft];
}
