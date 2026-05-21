import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatFileChipLabel, matchFileChip } from "../lib/fileChipPath.js";
import { FileChip } from "./FileChip.js";

describe("matchFileChip", () => {
  it("matches a bare path with extension", () => {
    expect(matchFileChip("src/index.ts")).toEqual({ path: "src/index.ts", line: null });
  });

  it("matches a path with line suffix", () => {
    expect(matchFileChip("src/foo/bar.tsx:42")).toEqual({ path: "src/foo/bar.tsx", line: 42 });
  });

  it("rejects strings with whitespace", () => {
    expect(matchFileChip("hello world.ts")).toBeNull();
  });

  it("rejects strings without extension", () => {
    expect(matchFileChip("README")).toBeNull();
  });

  it("rejects very long strings (likely not a path)", () => {
    expect(matchFileChip("a".repeat(220) + ".ts")).toBeNull();
  });

  it("matches a single-segment filename", () => {
    expect(matchFileChip("package.json")).toEqual({ path: "package.json", line: null });
  });
});

describe("formatFileChipLabel", () => {
  it("returns the basename for an absolute path inside the workspace", () => {
    expect(formatFileChipLabel("/repo/src/main/ipc.ts", "/repo", null)).toBe("ipc.ts");
  });

  it("preserves :line suffix", () => {
    expect(formatFileChipLabel("/repo/src/main/ipc.ts", "/repo", 42)).toBe("ipc.ts:42");
  });

  it("returns the basename when the absolute path is outside the workspace", () => {
    expect(formatFileChipLabel("/other/dir/foo.ts", "/repo", null)).toBe("foo.ts");
  });

  it("returns the basename for an absolute path when no workspaceCwd is given", () => {
    expect(formatFileChipLabel("/abs/path/to/file.ts", null, null)).toBe("file.ts");
    expect(formatFileChipLabel("/abs/path/to/file.ts", undefined, 7)).toBe("file.ts:7");
  });

  it("returns the basename for a relative path with directory segments", () => {
    expect(formatFileChipLabel("src/main/ipc.ts", "/repo", null)).toBe("ipc.ts");
    expect(formatFileChipLabel("src/main/ipc.ts", null, 3)).toBe("ipc.ts:3");
  });

  it("returns single-segment filenames unchanged", () => {
    expect(formatFileChipLabel("package.json", null, null)).toBe("package.json");
    expect(formatFileChipLabel("package.json", "/repo", 12)).toBe("package.json:12");
  });

  it("strips a trailing slash before taking the basename", () => {
    expect(formatFileChipLabel("/repo/", "/repo", null)).toBe("repo");
  });
});

describe("FileChip", () => {
  beforeEach(() => {
    const openInIde = vi.fn().mockResolvedValue({ ok: true });
    const openPath = vi.fn().mockResolvedValue({ ok: true });
    Object.defineProperty(window, "argmax", {
      configurable: true,
      writable: true,
      value: {
        workspaces: { openInIde },
        system: { openPath }
      }
    });
  });

  afterEach(() => {
    cleanup();
    delete (window as { argmax?: unknown }).argmax;
  });

  it("calls workspaces.openInIde when workspaceId is provided", () => {
    render(<FileChip path="src/main.ts" line={10} workspaceId="ws-1" workspaceCwd="/repo" />);
    screen.getByRole("button", { name: "Open src/main.ts at line 10" }).click();
    const ide = (window as unknown as { argmax: { workspaces: { openInIde: ReturnType<typeof vi.fn> } } }).argmax
      .workspaces.openInIde;
    expect(ide).toHaveBeenCalledWith({ workspaceId: "ws-1", ide: "default" });
  });

  it("falls back to system.openPath when workspaceId is missing", () => {
    render(<FileChip path="src/main.ts" line={null} workspaceCwd="/repo" />);
    screen.getByRole("button", { name: "Open src/main.ts" }).click();
    const sys = (window as unknown as { argmax: { system: { openPath: ReturnType<typeof vi.fn> } } }).argmax.system
      .openPath;
    expect(sys).toHaveBeenCalledWith({ path: "src/main.ts", cwd: "/repo" });
  });

  it("renders the basename and the optional line suffix", () => {
    render(<FileChip path="src/x.ts" line={7} workspaceId="ws-1" />);
    expect(screen.getByRole("button", { name: "Open src/x.ts at line 7" })).toHaveTextContent("x.ts:7");
  });
});
