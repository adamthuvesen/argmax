import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatFileChipLabel,
  matchFileChip,
  normalizeFileChipPath
} from "../lib/fileChipPath.js";
import { CheckedFileChip, FileChip } from "./FileChip.js";

describe("matchFileChip", () => {
  it("matches a bare path with extension", () => {
    expect(matchFileChip("src/index.ts")).toEqual({ path: "src/index.ts", line: null, needsExistenceCheck: false });
  });

  it("matches a path with line suffix", () => {
    expect(matchFileChip("src/foo/bar.tsx:42")).toEqual({ path: "src/foo/bar.tsx", line: 42, needsExistenceCheck: false });
  });

  it("matches a path with line and column suffix", () => {
    expect(matchFileChip("src/foo/bar.tsx:42:7")).toEqual({ path: "src/foo/bar.tsx", line: 42, needsExistenceCheck: false });
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

  it("matches a home-relative path, including dot directories", () => {
    expect(matchFileChip("~/.local/share/dotfiles/agent-secrets.json")).toEqual({
      path: "~/.local/share/dotfiles/agent-secrets.json",
      line: null,
      needsExistenceCheck: false
    });
  });
});

describe("matchFileChip outside the workspace", () => {
  it("matches an anchored path with spaces, keeping its line", () => {
    expect(matchFileChip("~/Library/Application Support/com.argmax.rs/local-state/argmax.sqlite:12")).toEqual({
      path: "~/Library/Application Support/com.argmax.rs/local-state/argmax.sqlite",
      line: 12,
      needsExistenceCheck: false
    });
  });

  it("allows long extensions once the value has a directory", () => {
    expect(matchFileChip("data/events.parquet")?.path).toBe("data/events.parquet");
    expect(matchFileChip("~/data/model.sqlite")?.path).toBe("~/data/model.sqlite");
  });

  it("keeps bare dotted words with long tails as code", () => {
    expect(matchFileChip("config.enabled")).toBeNull();
    expect(matchFileChip("process.platform")).toBeNull();
  });

  it("asks for an existence check on an anchored path without an extension", () => {
    expect(matchFileChip("/etc/hosts")).toEqual({ path: "/etc/hosts", line: null, needsExistenceCheck: true });
    expect(matchFileChip("~/dev/repo/Makefile")?.needsExistenceCheck).toBe(true);
    expect(matchFileChip("/api/users")?.needsExistenceCheck).toBe(true);
  });

  it("rejects a directory and an over-long anchored path", () => {
    expect(matchFileChip("~/dev/repo/")).toBeNull();
    expect(matchFileChip(`/${"a".repeat(1100)}.ts`)).toBeNull();
  });

  it("accepts an anchored path longer than a relative one may be", () => {
    const deep = `/tmp/${"nested/".repeat(40)}out.json`;
    expect(matchFileChip(deep)?.path).toBe(deep);
  });
});

describe("normalizeFileChipPath for sibling paths", () => {
  it("resolves ../ against the workspace", () => {
    expect(normalizeFileChipPath("../dotfiles/README.md", "/Users/me/dev/argmax")).toBe("/Users/me/dev/dotfiles/README.md");
    expect(normalizeFileChipPath("../argmax/src/a.ts", "/Users/me/dev/argmax")).toBe("src/a.ts");
  });

  it("decodes a link's %20 into a matchable path", () => {
    const path = normalizeFileChipPath("/Users/me/Library/Application%20Support/a.json", "/repo");
    expect(matchFileChip(path)?.path).toBe("/Users/me/Library/Application Support/a.json");
  });
});

describe("formatFileChipLabel", () => {
  it("returns the basename for an absolute path inside the workspace", () => {
    expect(formatFileChipLabel("/repo/src-tauri/src/ipc.ts", "/repo", null)).toBe("ipc.ts");
  });

  it("shows the whole path, home collapsed, when the file is outside the workspace", () => {
    expect(formatFileChipLabel("/other/dir/foo.ts", "/repo", null)).toBe("/other/dir/foo.ts");
    expect(formatFileChipLabel("/Users/me/.local/share/a.json", "/repo", 3)).toBe("~/.local/share/a.json:3");
    expect(formatFileChipLabel("~/.zshrc", "/repo", null)).toBe("~/.zshrc");
  });

  it("returns the basename for an absolute path when no workspaceCwd is given", () => {
    expect(formatFileChipLabel("/abs/path/to/file.ts", null, null)).toBe("file.ts");
    expect(formatFileChipLabel("/abs/path/to/file.ts", undefined, 7)).toBe("file.ts:7");
  });

  it("returns the basename for a relative path with directory segments", () => {
    expect(formatFileChipLabel("src-tauri/src/ipc.ts", "/repo", null)).toBe("ipc.ts");
    expect(formatFileChipLabel("src-tauri/src/ipc.ts", null, 3)).toBe("ipc.ts:3");
  });

  it("strips a trailing slash before taking the basename", () => {
    expect(formatFileChipLabel("/repo/", "/repo", null)).toBe("repo");
  });
});

describe("normalizeFileChipPath", () => {
  it("makes absolute workspace paths relative", () => {
    expect(normalizeFileChipPath("/repo/src/App.tsx", "/repo")).toBe("src/App.tsx");
  });

  it("decodes spaces from angle-bracket Markdown links", () => {
    expect(normalizeFileChipPath("/repo/My%20File.ts", "/repo")).toBe("My File.ts");
  });

  it("keeps paths outside the workspace absolute", () => {
    expect(normalizeFileChipPath("/tmp/report.md", "/repo")).toBe("/tmp/report.md");
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

  it("opens the file itself, not the whole repo, when workspaceId is provided", () => {
    render(<FileChip path="src-tauri/src.ts" line={10} workspaceId="ws-1" workspaceCwd="/repo" />);
    screen.getByRole("button", { name: "Open src-tauri/src.ts at line 10" }).click();
    const api = (window as unknown as {
      argmax: {
        workspaces: { openInIde: ReturnType<typeof vi.fn> };
        system: { openPath: ReturnType<typeof vi.fn> };
      };
    }).argmax;
    expect(api.system.openPath).toHaveBeenCalledWith({ path: "src-tauri/src.ts", cwd: "/repo" });
    expect(api.workspaces.openInIde).not.toHaveBeenCalled();
  });

  it("resolves a bare filename before loading its hover preview", async () => {
    const statFile = vi.fn().mockRejectedValue(new Error("missing at root"));
    const listFiles = vi.fn().mockResolvedValue([{ path: "docs/package.json" }]);
    const readFile = vi.fn().mockResolvedValue({
      kind: "text",
      content: "{}",
      size: 2,
      mtimeMs: 1
    });
    (window as unknown as { argmax: unknown }).argmax = {
      workspace: { statFile, listFiles, readFile },
      workspaces: { openInIde: vi.fn() },
      system: { openPath: vi.fn() }
    };
    render(<FileChip path="package.json" line={null} workspaceId="ws-1" workspaceCwd="/repo" />);

    fireEvent.focus(screen.getByRole("button", { name: "Open package.json" }));

    await waitFor(() => expect(readFile).toHaveBeenCalledWith(
      { kind: "workspace", id: "ws-1" },
      "docs/package.json"
    ));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("{}");
  });
});

describe("CheckedFileChip", () => {
  afterEach(() => {
    cleanup();
    delete (window as { argmax?: unknown }).argmax;
  });

  function stubStat(statExternalFile: ReturnType<typeof vi.fn>): void {
    (window as unknown as { argmax: unknown }).argmax = {
      workspace: { statExternalFile, statFile: vi.fn().mockRejectedValue(new Error("no")) },
      workspaces: { openInIde: vi.fn() },
      system: { openPath: vi.fn() }
    };
  }

  it("becomes a chip once the extensionless path is a file", async () => {
    const statExternalFile = vi.fn().mockResolvedValue({ size: 10, mtimeMs: 1 });
    stubStat(statExternalFile);
    render(
      <CheckedFileChip path="/etc/hosts" line={null} workspaceId="ws-1" workspaceCwd="/repo" fallback={<code>/etc/hosts</code>} />
    );
    expect(await screen.findByRole("button", { name: "Open /etc/hosts" })).toHaveTextContent("/etc/hosts");
    expect(statExternalFile).toHaveBeenCalledWith("/etc/hosts");
  });

  it("stays as code when the path is not a file, such as an API route", async () => {
    const statExternalFile = vi.fn().mockRejectedValue(new Error("not found"));
    stubStat(statExternalFile);
    render(
      <CheckedFileChip path="/api/users" line={null} workspaceId="ws-1" workspaceCwd="/repo" fallback={<code>/api/users</code>} />
    );
    await waitFor(() => expect(statExternalFile).toHaveBeenCalledWith("/api/users"));
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("/api/users").tagName).toBe("CODE");
  });
});
