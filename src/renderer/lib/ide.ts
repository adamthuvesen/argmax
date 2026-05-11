import type { IdeId } from "../../shared/types.js";

export const DEFAULT_IDE_KEY = "argmax.defaultIde";

export const ALL_IDE_IDS = new Set<IdeId>(["vscode", "cursor", "windsurf", "zed", "terminal", "iterm"]);

export function readStoredDefaultIde(): IdeId | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(DEFAULT_IDE_KEY);
  if (raw && (ALL_IDE_IDS as Set<string>).has(raw)) {
    return raw as IdeId;
  }
  return null;
}
