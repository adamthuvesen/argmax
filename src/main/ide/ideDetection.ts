import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import type { DetectedIde, IdeId } from "../../shared/types.js";

/**
 * IDE detection runs once at app boot and caches results for the process
 * lifetime. macOS-only for v1; the renderer hides the affordance if zero
 * IDEs surface. If the user installs a new IDE while Argmax is open they
 * must restart — re-running `mdfind` on every render would be wasteful.
 */

const execFileAsync = promisify(execFile);

interface IdeCandidate {
  id: Exclude<IdeId, "terminal" | "iterm">;
  label: string;
  bundleId: string;
  appName: string;
  cli: string;
}

const GUI_IDES: readonly IdeCandidate[] = [
  {
    id: "vscode",
    label: "VS Code",
    bundleId: "com.microsoft.VSCode",
    appName: "Visual Studio Code",
    cli: "code"
  },
  {
    id: "cursor",
    label: "Cursor",
    bundleId: "com.todesktop.230313mzl4w4u92",
    appName: "Cursor",
    cli: "cursor"
  },
  {
    id: "windsurf",
    label: "Windsurf",
    bundleId: "com.exafunction.windsurf",
    appName: "Windsurf",
    cli: "windsurf"
  },
  {
    id: "zed",
    label: "Zed",
    bundleId: "dev.zed.Zed",
    appName: "Zed",
    cli: "zed"
  }
];

const ITERM = {
  id: "iterm" as const,
  label: "iTerm",
  bundleId: "com.googlecode.iterm2",
  appName: "iTerm"
};

let cachedDetection: Promise<DetectedIde[]> | null = null;

/**
 * Reset the cache. Test-only — production code should never need to call
 * this because detection is keyed to the app boot. Exposed so vitest can
 * exercise the "second call returns cached" contract without leaking
 * state across cases.
 */
export function resetIdeDetectionCacheForTests(): void {
  cachedDetection = null;
}

export function detectInstalledIdes(): Promise<DetectedIde[]> {
  if (!cachedDetection) {
    cachedDetection = runDetection().catch((error) => {
      cachedDetection = null;
      throw error;
    });
  }
  return cachedDetection;
}

async function runDetection(): Promise<DetectedIde[]> {
  const guiResults = await Promise.all(GUI_IDES.map((candidate) => detectGuiIde(candidate)));
  const detected: DetectedIde[] = guiResults.filter((entry): entry is DetectedIde => entry !== null);

  const itermPath = await locateApp(ITERM.bundleId, ITERM.appName);
  if (itermPath) {
    detected.push({ id: ITERM.id, label: ITERM.label, appPath: itermPath, hasCli: false });
  }

  // Terminal.app ships with macOS, so we always surface it. Users on macOS
  // builds without Terminal.app are vanishingly rare and would have other
  // problems first.
  detected.push({
    id: "terminal",
    label: "Terminal",
    appPath: "/System/Applications/Utilities/Terminal.app",
    hasCli: false
  });

  return detected;
}

async function detectGuiIde(candidate: IdeCandidate): Promise<DetectedIde | null> {
  const appPath = await locateApp(candidate.bundleId, candidate.appName);
  if (!appPath) return null;
  const hasCli = await probeCli(candidate.cli);
  return { id: candidate.id, label: candidate.label, appPath, hasCli };
}

async function locateApp(bundleId: string, appName: string): Promise<string | null> {
  const fromMdfind = await mdfindFirst(bundleId);
  if (fromMdfind) return fromMdfind;
  const fallback = `/Applications/${appName}.app`;
  try {
    await stat(fallback);
    return fallback;
  } catch {
    return null;
  }
}

async function mdfindFirst(bundleId: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "mdfind",
      [`kMDItemCFBundleIdentifier == "${bundleId}"`],
      { timeout: 4000 }
    );
    const lines = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return lines[0] ?? null;
  } catch {
    return null;
  }
}

async function probeCli(cmd: string): Promise<boolean> {
  try {
    await execFileAsync("which", [cmd], { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}
