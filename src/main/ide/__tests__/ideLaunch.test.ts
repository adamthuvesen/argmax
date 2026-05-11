// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import type * as ChildProcessModule from "node:child_process";
import type { DetectedIde } from "../../../shared/types.js";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof ChildProcessModule>("node:child_process");
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args) as ChildProcess
  };
});

// Imported after the mock so the module under test resolves the mocked spawn.
const { launchIde, IdeLaunchError } = await import("../ideLaunch.js");

function makeChild(): ChildProcess {
  const child = {
    on: vi.fn(),
    unref: vi.fn()
  };
  return child as unknown as ChildProcess;
}

const ALL_DETECTED: DetectedIde[] = [
  { id: "vscode", label: "VS Code", appPath: "/Applications/Visual Studio Code.app", hasCli: true },
  { id: "cursor", label: "Cursor", appPath: "/Applications/Cursor.app", hasCli: true },
  { id: "windsurf", label: "Windsurf", appPath: "/Applications/Windsurf.app", hasCli: false },
  { id: "zed", label: "Zed", appPath: "/Applications/Zed.app", hasCli: false },
  { id: "iterm", label: "iTerm", appPath: "/Applications/iTerm.app", hasCli: false },
  { id: "terminal", label: "Terminal", appPath: "/System/Applications/Utilities/Terminal.app", hasCli: false }
];

describe("launchIde", () => {
  afterEach(() => {
    spawnMock.mockReset();
  });

  it("uses the CLI helper when hasCli is true", async () => {
    spawnMock.mockReturnValue(makeChild());
    await launchIde("vscode", "/tmp/work", ALL_DETECTED);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith("code", ["/tmp/work"], expect.objectContaining({ detached: true }));
  });

  it("falls back to `open -a` when hasCli is false", async () => {
    spawnMock.mockReturnValue(makeChild());
    await launchIde("zed", "/tmp/work", ALL_DETECTED);
    expect(spawnMock).toHaveBeenCalledWith(
      "open",
      ["-a", "Zed", "/tmp/work"],
      expect.objectContaining({ detached: true })
    );
  });

  it("launches Cursor via the cursor CLI when present", async () => {
    spawnMock.mockReturnValue(makeChild());
    await launchIde("cursor", "/tmp/work", ALL_DETECTED);
    expect(spawnMock).toHaveBeenCalledWith("cursor", ["/tmp/work"], expect.objectContaining({ detached: true }));
  });

  it("launches Windsurf via `open -a` when its CLI is missing", async () => {
    spawnMock.mockReturnValue(makeChild());
    await launchIde("windsurf", "/tmp/work", ALL_DETECTED);
    expect(spawnMock).toHaveBeenCalledWith(
      "open",
      ["-a", "Windsurf", "/tmp/work"],
      expect.objectContaining({ detached: true })
    );
  });

  it("launches Terminal via osascript with quoted form of for the path", async () => {
    spawnMock.mockReturnValue(makeChild());
    await launchIde("terminal", "/tmp/work", ALL_DETECTED);
    expect(spawnMock).toHaveBeenCalledWith(
      "osascript",
      ["-e", 'tell application "Terminal" to do script "cd " & quoted form of "/tmp/work"'],
      expect.objectContaining({ detached: true })
    );
  });

  it("launches iTerm with an iTerm-specific script when detected", async () => {
    spawnMock.mockReturnValue(makeChild());
    await launchIde("iterm", "/tmp/work", ALL_DETECTED);
    const call = spawnMock.mock.calls[0];
    expect(call?.[0]).toBe("osascript");
    expect(Array.isArray(call?.[1])).toBe(true);
    expect((call?.[1] as string[])[0]).toBe("-e");
    expect((call?.[1] as string[])[1]).toMatch(/tell application "iTerm"/);
  });

  it("falls back to Terminal when iTerm is selected but not installed", async () => {
    spawnMock.mockReturnValue(makeChild());
    const withoutIterm = ALL_DETECTED.filter((d) => d.id !== "iterm");
    await launchIde("iterm", "/tmp/work", withoutIterm);
    expect(spawnMock).toHaveBeenCalledWith(
      "osascript",
      ["-e", expect.stringContaining('tell application "Terminal"')],
      expect.objectContaining({ detached: true })
    );
  });

  it("rejects paths containing newlines before spawning", async () => {
    spawnMock.mockReturnValue(makeChild());
    await expect(launchIde("vscode", "/tmp/work\n", ALL_DETECTED)).rejects.toBeInstanceOf(IdeLaunchError);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects when the chosen IDE is not in the detected list", async () => {
    spawnMock.mockReturnValue(makeChild());
    await expect(launchIde("vscode", "/tmp/work", [])).rejects.toBeInstanceOf(IdeLaunchError);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("escapes double quotes and backslashes in the path when building osascript args", async () => {
    spawnMock.mockReturnValue(makeChild());
    await launchIde("terminal", '/tmp/with"quote\\back', ALL_DETECTED);
    expect(spawnMock).toHaveBeenCalledWith(
      "osascript",
      [
        "-e",
        'tell application "Terminal" to do script "cd " & quoted form of "/tmp/with\\"quote\\\\back"'
      ],
      expect.objectContaining({ detached: true })
    );
  });

  it("wraps paths containing shell metacharacters in quoted form of so cd cannot be injected", async () => {
    spawnMock.mockReturnValue(makeChild());
    await launchIde("terminal", "/tmp/foo;rm -rf $(echo pwned)", ALL_DETECTED);
    const call = spawnMock.mock.calls[0];
    const script = (call?.[1] as string[])[1] ?? "";
    // The metacharacters must reach AppleScript inside the string literal, not
    // as raw shell tokens. `quoted form of` will then single-quote them before
    // they reach `do script`'s shell.
    expect(script).toContain('"/tmp/foo;rm -rf $(echo pwned)"');
    expect(script).toContain("quoted form of");
    // And the script never builds the cd command via direct interpolation:
    expect(script).not.toContain('"cd /tmp/foo;rm -rf');
  });
});
