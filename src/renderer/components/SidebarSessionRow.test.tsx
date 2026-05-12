import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSummary } from "../../shared/types.js";
import { SidebarSessionRow } from "./SidebarSessionRow.js";

const workspaceBase: WorkspaceSummary = {
  id: "workspace-1",
  projectId: "project-1",
  taskLabel: "Build the dashboard",
  branch: "argmax/dashboard-abcd1234",
  baseRef: "main",
  path: "/tmp/workspaces/argmax-dashboard",
  state: "complete",
  sharedWorkspace: false,
  dirty: false,
  changedFiles: 0,
  lastActivityAt: "2026-05-01T00:01:00.000Z"
};

const detectedIdes = [
  { id: "vscode" as const, label: "VS Code", appPath: "/Applications/Visual Studio Code.app", hasCli: true },
  { id: "cursor" as const, label: "Cursor", appPath: "/Applications/Cursor.app", hasCli: true }
];

describe("SidebarSessionRow", () => {
  afterEach(() => cleanup());

  it("exposes IDE, chooser, and archive actions as keyboard-reachable buttons", () => {
    render(
      <SidebarSessionRow
        workspace={workspaceBase}
        workspaceCost={0}
        isSelected={false}
        onOpenWorkspaceChat={vi.fn()}
        onArchiveWorkspace={vi.fn()}
        onOpenInIde={vi.fn()}
        detectedIdes={detectedIdes}
        defaultIde="vscode"
      />
    );

    expect(screen.getByRole("button", { name: "Open in IDE" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose IDE" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive session" })).toBeInTheDocument();
  });

  it("ships sidebar action CSS that is visible at rest", () => {
    const cssPath = resolve(dirname(fileURLToPath(import.meta.url)), "../styles.css");
    const css = readFileSync(cssPath, "utf8");

    const actionRule = /\.session-row-action\s*\{[^}]*opacity:\s*([0-9.]+)/i.exec(css);
    const archiveRule = /\.session-archive-btn\s*\{[^}]*opacity:\s*([0-9.]+)/i.exec(css);

    expect(actionRule, "expected .session-row-action opacity rule").not.toBeNull();
    expect(archiveRule, "expected .session-archive-btn opacity rule").not.toBeNull();

    const actionOpacity = parseFloat(actionRule?.[1] ?? "0");
    const archiveOpacity = parseFloat(archiveRule?.[1] ?? "0");

    expect(actionOpacity).toBeGreaterThan(0);
    expect(archiveOpacity).toBeGreaterThan(0);
  });
});

describe("styles.css startup contract", () => {
  it("does not @import from a remote URL — fonts must be bundled", () => {
    const cssPath = resolve(dirname(fileURLToPath(import.meta.url)), "../styles.css");
    const css = readFileSync(cssPath, "utf8");
    const remoteImport = /@import\s+url\(\s*['"]?https?:/i.exec(css);
    expect(remoteImport, `unexpected remote @import: ${remoteImport?.[0] ?? ""}`).toBeNull();
  });

  it("bundles VT323 via @font-face pointing at a local asset", () => {
    const cssPath = resolve(dirname(fileURLToPath(import.meta.url)), "../styles.css");
    const css = readFileSync(cssPath, "utf8");
    const fontFace = /font-family:\s*["']VT323["'][\s\S]{0,300}?url\(["']?\.\/fonts\/VT323\//i.exec(css);
    expect(fontFace, "expected VT323 @font-face with local URL").not.toBeNull();
  });

  it("bundles Lilex Nerd Font via @font-face pointing at a local asset", () => {
    const cssPath = resolve(dirname(fileURLToPath(import.meta.url)), "../styles.css");
    const css = readFileSync(cssPath, "utf8");
    const fontFace = /font-family:\s*["']Lilex Nerd Font["'][\s\S]{0,300}?url\(["']?\.\/fonts\/Lilex\//i.exec(css);
    expect(fontFace, "expected Lilex Nerd Font @font-face with local URL").not.toBeNull();
  });
});
