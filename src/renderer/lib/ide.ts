import type { IdeId } from "../../shared/types.js";

export const DEFAULT_IDE_KEY = "argmax.defaultIde";

/** Stored sentinel for an explicit "Ask each time" choice, so it survives a
 *  restart instead of falling back to the factory default below. */
export const NO_DEFAULT_IDE = "none";

/** Factory default: used until the user picks an IDE (or "Ask each time") in
 *  Settings. Use sites still verify the IDE is actually detected. */
const FACTORY_DEFAULT_IDE: IdeId = "cursor";

export const ALL_IDE_IDS = new Set<IdeId>(["vscode", "cursor", "windsurf", "zed", "terminal", "iterm"]);

export function readStoredDefaultIde(): IdeId | null {
  if (typeof window === "undefined") return FACTORY_DEFAULT_IDE;
  const raw = window.localStorage.getItem(DEFAULT_IDE_KEY);
  if (raw === NO_DEFAULT_IDE) return null;
  if (raw && (ALL_IDE_IDS as Set<string>).has(raw)) {
    return raw as IdeId;
  }
  return FACTORY_DEFAULT_IDE;
}
