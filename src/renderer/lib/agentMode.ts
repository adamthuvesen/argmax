/** Launcher chip: Auto attaches a project, Chat launches a scratch workspace. */
export type LauncherMode = "auto" | "chat";

export const LAUNCHER_MODE_LABELS: Record<LauncherMode, string> = {
  auto: "Auto",
  chat: "Chat"
};

export function cycleLauncherMode(mode: LauncherMode, chatAvailable: boolean): LauncherMode {
  switch (mode) {
    case "auto":
      return chatAvailable ? "chat" : "auto";
    case "chat":
      return "auto";
    default: {
      const exhaustive: never = mode;
      return exhaustive;
    }
  }
}

export function launcherModeTitle(mode: LauncherMode, chatAvailable: boolean): string {
  switch (mode) {
    case "auto":
      return chatAvailable
        ? "Auto: the agent works in a repository. Tab for Chat."
        : "Auto: the agent works in a repository.";
    case "chat":
      return "Chat: no repository attached. Tab for Auto.";
    default: {
      const exhaustive: never = mode;
      return exhaustive;
    }
  }
}
