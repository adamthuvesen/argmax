// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { execFile as ExecFileType } from "node:child_process";
import type * as ChildProcess from "node:child_process";
import type * as FsPromises from "node:fs/promises";

/**
 * `ideDetection` wraps `execFile` via `util.promisify`. The real `execFile`
 * carries a `util.promisify.custom` symbol so the promisified form resolves
 * to `{ stdout, stderr }`. Our mock needs the same shape, which is simplest
 * to express by setting that symbol on a stub `execFile` and routing all
 * calls to a shared `vi.fn` we can introspect from each test.
 */

const { promisifiedExecFile, statMock, state } = vi.hoisted(() => ({
  promisifiedExecFile: vi.fn(),
  statMock: vi.fn(),
  state: {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    mdfindHandler: (_bundleId: string): string => "",
    whichSet: new Set<string>()
  }
}));

function defaultExecFile(command: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  if (command === "mdfind") {
    const id = (args[0] ?? "").match(/"([^"]+)"/)?.[1] ?? "";
    return Promise.resolve({ stdout: state.mdfindHandler(id), stderr: "" });
  }
  if (command === "which") {
    if (state.whichSet.has(args[0] ?? "")) {
      return Promise.resolve({ stdout: `/usr/local/bin/${args[0]}\n`, stderr: "" });
    }
    return Promise.reject(new Error("not found"));
  }
  return Promise.reject(new Error(`unexpected command ${command}`));
}

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof ChildProcess>("node:child_process");
  const { promisify } = await import("node:util");

  function execFile(): void {
    throw new Error("callback-style execFile should not be invoked in this test");
  }
  Object.defineProperty(execFile, promisify.custom, {
    value: (command: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> =>
      promisifiedExecFile(command, args) as Promise<{ stdout: string; stderr: string }>
  });

  return { ...actual, execFile: execFile as unknown as typeof ExecFileType };
});

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof FsPromises>("node:fs/promises");
  return { ...actual, stat: (...args: unknown[]) => statMock(...args) as ReturnType<typeof FsPromises.stat> };
});

const { detectInstalledIdes, resetIdeDetectionCacheForTests } = await import("../ideDetection.js");

describe("detectInstalledIdes", () => {
  beforeEach(() => {
    promisifiedExecFile.mockReset();
    promisifiedExecFile.mockImplementation((command: string, args: readonly string[]) =>
      defaultExecFile(command, args)
    );
    statMock.mockReset();
    state.whichSet.clear();
    state.mdfindHandler = () => "";
    resetIdeDetectionCacheForTests();
    statMock.mockRejectedValue(new Error("ENOENT"));
  });

  afterEach(() => {
    resetIdeDetectionCacheForTests();
  });

  it("parses a single mdfind hit", async () => {
    state.mdfindHandler = (id) => (id === "com.microsoft.VSCode" ? "/Applications/Visual Studio Code.app\n" : "");
    state.whichSet.add("code");
    const detected = await detectInstalledIdes();
    const vscode = detected.find((entry) => entry.id === "vscode");
    expect(vscode).toEqual({
      id: "vscode",
      label: "VS Code",
      appPath: "/Applications/Visual Studio Code.app",
      hasCli: true
    });
  });

  it("returns the first hit when mdfind reports multiple paths", async () => {
    state.mdfindHandler = (id) =>
      id === "com.microsoft.VSCode"
        ? "/Applications/Visual Studio Code.app\n/Users/me/Apps/Visual Studio Code.app\n"
        : "";
    state.whichSet.add("code");
    const detected = await detectInstalledIdes();
    const vscode = detected.find((entry) => entry.id === "vscode");
    expect(vscode?.appPath).toBe("/Applications/Visual Studio Code.app");
  });

  it("omits an IDE when mdfind returns empty and the filesystem fallback misses", async () => {
    state.mdfindHandler = () => "";
    const detected = await detectInstalledIdes();
    expect(detected.find((entry) => entry.id === "vscode")).toBeUndefined();
    expect(detected.find((entry) => entry.id === "cursor")).toBeUndefined();
  });

  it("uses /Applications/<Name>.app when mdfind reports empty", async () => {
    state.mdfindHandler = () => "";
    statMock.mockImplementation((path: string) => {
      if (path === "/Applications/Cursor.app") {
        return Promise.resolve({});
      }
      return Promise.reject(new Error("ENOENT"));
    });
    const detected = await detectInstalledIdes();
    const cursor = detected.find((entry) => entry.id === "cursor");
    expect(cursor).toEqual({
      id: "cursor",
      label: "Cursor",
      appPath: "/Applications/Cursor.app",
      hasCli: false
    });
  });

  it("always surfaces Terminal as available", async () => {
    const detected = await detectInstalledIdes();
    const terminal = detected.find((entry) => entry.id === "terminal");
    expect(terminal).toBeDefined();
    expect(terminal?.appPath).toBe("/System/Applications/Utilities/Terminal.app");
  });

  it("caches the first detection — second call does not re-invoke mdfind", async () => {
    state.mdfindHandler = (id) => (id === "dev.zed.Zed" ? "/Applications/Zed.app\n" : "");
    const first = await detectInstalledIdes();
    const callsAfterFirst = promisifiedExecFile.mock.calls.length;
    const second = await detectInstalledIdes();
    expect(second).toBe(first);
    expect(promisifiedExecFile.mock.calls.length).toBe(callsAfterFirst);
  });

  it("records hasCli=false when `which` exits non-zero", async () => {
    state.mdfindHandler = (id) => (id === "com.microsoft.VSCode" ? "/Applications/Visual Studio Code.app\n" : "");
    const detected = await detectInstalledIdes();
    const vscode = detected.find((entry) => entry.id === "vscode");
    expect(vscode?.hasCli).toBe(false);
  });
});
