import { useEffect, useState } from "react";
import {
  BACKGROUND_SEND_SHORTCUT_EVENT,
  BACKGROUND_SEND_SHORTCUT_KEY,
  readBackgroundSendShortcut
} from "../lib/backgroundSend.js";

/**
 * The background-send chord in effect, kept current when Settings changes it in
 * this window or another one.
 */
export function useBackgroundSendShortcut(): string {
  const [shortcut, setShortcut] = useState(readBackgroundSendShortcut);
  useEffect(() => {
    const refresh = (): void => setShortcut(readBackgroundSendShortcut());
    const onStorage = (event: StorageEvent): void => {
      if (event.key === BACKGROUND_SEND_SHORTCUT_KEY || event.key === null) refresh();
    };
    window.addEventListener(BACKGROUND_SEND_SHORTCUT_EVENT, refresh);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(BACKGROUND_SEND_SHORTCUT_EVENT, refresh);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return shortcut;
}
