import { spawn, type ChildProcess } from "node:child_process";
import type { DetectedIde, IdeId } from "../../shared/types.js";

/**
 * Direct child_process spawn — we deliberately avoid `Electron.shell.openPath`
 * because it routes a folder to Finder. CLI helpers (`code`, `cursor`, ...)
 * are preferred when present so the worktree opens in the existing IDE
 * window; otherwise we fall back to `open -a "<App>"`. Terminal targets
 * use `osascript` to issue a `do script` with `cd <path>`.
 *
 * Every child is spawned `detached` with `stdio: "ignore"` and `unref()`'d
 * so closing Argmax does not kill the editor. We never await the child's
 * `exit` event; success is "the child was handed to the OS".
 */

export class IdeLaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdeLaunchError";
  }
}

interface CliMapping {
  cli: string;
  appName: string;
}

const CLI_BY_ID: Record<Exclude<IdeId, "terminal" | "iterm">, CliMapping> = {
  vscode: { cli: "code", appName: "Visual Studio Code" },
  cursor: { cli: "cursor", appName: "Cursor" },
  windsurf: { cli: "windsurf", appName: "Windsurf" },
  zed: { cli: "zed", appName: "Zed" }
};

// eslint-disable-next-line @typescript-eslint/require-await -- spawn() is sync but callers await for forward-compat
export async function launchIde(
  ide: IdeId,
  path: string,
  detected: readonly DetectedIde[]
): Promise<void> {
  if (path.length === 0) {
    throw new IdeLaunchError("Worktree path is empty.");
  }
  // The path is sourced from our own DB, but we still refuse newlines so a
  // mistyped repo location cannot smuggle additional `osascript` commands.
  if (/[\r\n]/.test(path)) {
    throw new IdeLaunchError("Worktree path contains newline characters.");
  }

  if (ide === "terminal") {
    return launchTerminal(path);
  }
  if (ide === "iterm") {
    const iterm = detected.find((entry) => entry.id === "iterm");
    if (!iterm) {
      // iTerm picked but not installed: fall through to Terminal so the
      // user still gets a usable shell.
      return launchTerminal(path);
    }
    return launchIterm(path);
  }

  const entry = detected.find((d) => d.id === ide);
  if (!entry) {
    throw new IdeLaunchError(`IDE ${ide} is not installed.`);
  }
  const mapping = CLI_BY_ID[ide];
  if (entry.hasCli) {
    try {
      spawnDetached(mapping.cli, [path]);
      return;
    } catch {
      // Fall through to the `open -a` path.
    }
  }
  spawnDetached("open", ["-a", mapping.appName, path]);
}

function launchTerminal(path: string): void {
  const script = `tell application "Terminal" to do script "cd ${escapeForOsascript(path)}"`;
  spawnDetached("osascript", ["-e", script]);
}

function launchIterm(path: string): void {
  const escaped = escapeForOsascript(path);
  const script =
    `tell application "iTerm"\n` +
    `  create window with default profile\n` +
    `  tell current session of current window to write text "cd ${escaped}"\n` +
    `end tell`;
  spawnDetached("osascript", ["-e", script]);
}

function escapeForOsascript(value: string): string {
  // Inside an AppleScript double-quoted string, the only character that
  // needs escaping is the double quote itself. We've already rejected
  // newlines upstream.
  return value.replace(/"/g, '\\"');
}

function spawnDetached(command: string, args: readonly string[]): ChildProcess {
  const child = spawn(command, [...args], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.on("error", () => {
    // Swallow spawn errors from the detached editor's lifecycle. The
    // initial spawn either throws synchronously (caught by the caller) or
    // succeeds; later errors from the editor process itself are not
    // actionable from Argmax.
  });
  child.unref();
  return child;
}
