import { cleanup, render, screen } from "@testing-library/react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSummary } from "../../shared/types.js";
import { readBundledCss } from "../styles/readBundledCss.js";
import { SidebarSessionRow, sidebarSessionRowEqual } from "./SidebarSessionRow.js";

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
  lastActivityAt: "2026-05-01T00:01:00.000Z",
  pinned: false
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
        workspaceTokens={null}
        isSelected={false}
        isOpenInGrid={false}
        canDragToGrid={true}
        onOpenWorkspaceChat={vi.fn()}
        onArchiveWorkspace={vi.fn()}
        onOpenInIde={vi.fn()}
        detectedIdes={detectedIdes}
        defaultIde="vscode"
        showTokens={false}
      />
    );

    expect(screen.getByRole("button", { name: "Open in IDE" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose IDE" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive session" })).toBeInTheDocument();
  });

  it("ArrowDown / ArrowUp moves focus between session-link buttons across rows", async () => {
    const { fireEvent } = await import("@testing-library/react");
    const onOpen = vi.fn();
    // Render two rows so we have a sibling to navigate to. Mount them under
    // a shared container so they live in the same document.
    render(
      <div>
        <SidebarSessionRow
          workspace={{ ...workspaceBase, id: "ws-1", taskLabel: "First" }}
          workspaceTokens={null}
          isSelected={false}
          isOpenInGrid={false}
          canDragToGrid={true}
          onOpenWorkspaceChat={onOpen}
          onArchiveWorkspace={vi.fn()}
          onOpenInIde={vi.fn()}
          detectedIdes={detectedIdes}
          defaultIde="vscode"
          showTokens={false}
        />
        <SidebarSessionRow
          workspace={{ ...workspaceBase, id: "ws-2", taskLabel: "Second" }}
          workspaceTokens={null}
          isSelected={false}
          isOpenInGrid={false}
          canDragToGrid={true}
          onOpenWorkspaceChat={onOpen}
          onArchiveWorkspace={vi.fn()}
          onOpenInIde={vi.fn()}
          detectedIdes={detectedIdes}
          defaultIde="vscode"
          showTokens={false}
        />
      </div>
    );

    const first = screen.getByRole("button", { name: /First/ });
    const second = screen.getByRole("button", { name: /Second/ });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(second).toHaveFocus();
    fireEvent.keyDown(second, { key: "ArrowUp" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "End" });
    expect(second).toHaveFocus();
    fireEvent.keyDown(second, { key: "Home" });
    expect(first).toHaveFocus();
  });

  it("IDE picker opens with the current default focused and supports arrow-key nav", async () => {
    const { fireEvent } = await import("@testing-library/react");
    render(
      <SidebarSessionRow
        workspace={workspaceBase}
        workspaceTokens={null}
        isSelected={false}
        isOpenInGrid={false}
        canDragToGrid={true}
        onOpenWorkspaceChat={vi.fn()}
        onArchiveWorkspace={vi.fn()}
        onOpenInIde={vi.fn()}
        detectedIdes={detectedIdes}
        defaultIde="cursor"
        showTokens={false}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Choose IDE" }));

    // Preferred (default IDE) is focused first.
    const cursorItem = await screen.findByRole("menuitem", { name: /Cursor/ });
    expect(cursorItem).toHaveFocus();

    // ArrowUp wraps to the previous menuitem (VS Code, which precedes Cursor).
    fireEvent.keyDown(cursorItem, { key: "ArrowUp" });
    expect(screen.getByRole("menuitem", { name: /VS Code/ })).toHaveFocus();

    // ArrowDown comes back to Cursor.
    fireEvent.keyDown(screen.getByRole("menuitem", { name: /VS Code/ }), { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: /Cursor/ })).toHaveFocus();

    // End jumps to the last menuitem.
    fireEvent.keyDown(screen.getByRole("menuitem", { name: /Cursor/ }), { key: "End" });
    expect(screen.getByRole("menuitem", { name: /Cursor/ })).toHaveFocus();
  });

  it("memo comparator skips re-render when a new workspace object has identical visible fields (ralph C1)", () => {
    const onOpenWorkspaceChat = vi.fn();
    const onArchiveWorkspace = vi.fn();
    const onOpenInIde = vi.fn();
    const sharedIdes = detectedIdes;
    const prev = {
      workspace: { ...workspaceBase },
      workspaceTokens: null,
      isSelected: false,
      isOpenInGrid: false,
      canDragToGrid: true,
      onOpenWorkspaceChat,
      onArchiveWorkspace,
      onOpenInIde,
      detectedIdes: sharedIdes,
      defaultIde: "vscode" as const,
      showTokens: false
    };
    const next = { ...prev, workspace: { ...workspaceBase } };

    // Same relevant fields → comparator says "equal", React skips render.
    expect(sidebarSessionRowEqual(prev, next)).toBe(true);

    // Mutating lastActivityAt (the per-token-tick churn signal) by itself
    // also doesn't matter for the row's visible state when nothing else
    // changed — but the comparator does include lastActivityAt because the
    // row reads it for sorting context. Keep this test honest:
    expect(
      sidebarSessionRowEqual(prev, {
        ...prev,
        workspace: { ...workspaceBase, lastActivityAt: "2026-05-01T00:02:00.000Z" }
      })
    ).toBe(false);

    // State change → re-render.
    expect(
      sidebarSessionRowEqual(prev, {
        ...prev,
        workspace: { ...workspaceBase, state: "running" }
      })
    ).toBe(false);

    // Selection toggle → re-render.
    expect(sidebarSessionRowEqual(prev, { ...prev, isSelected: true })).toBe(false);

    // Grid membership toggle → re-render.
    expect(sidebarSessionRowEqual(prev, { ...prev, isOpenInGrid: true })).toBe(false);

    // Drag affordance toggle → re-render.
    expect(sidebarSessionRowEqual(prev, { ...prev, canDragToGrid: false })).toBe(false);
  });

  it("ships sidebar action CSS that is visible at rest", () => {
    const cssPath = resolve(dirname(fileURLToPath(import.meta.url)), "../styles.css");
    const css = readBundledCss(cssPath);

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
    const css = readBundledCss(cssPath);
    const remoteImport = /@import\s+url\(\s*['"]?https?:/i.exec(css);
    expect(remoteImport, `unexpected remote @import: ${remoteImport?.[0] ?? ""}`).toBeNull();
  });

  it("bundles VT323 via @font-face pointing at a local asset", () => {
    const cssPath = resolve(dirname(fileURLToPath(import.meta.url)), "../styles.css");
    const css = readBundledCss(cssPath);
    const fontFace = /font-family:\s*["']VT323["'][\s\S]{0,300}?url\(["']?\.\/fonts\/VT323\//i.exec(css);
    expect(fontFace, "expected VT323 @font-face with local URL").not.toBeNull();
  });

  it("bundles Lilex Nerd Font via @font-face pointing at a local asset", () => {
    const cssPath = resolve(dirname(fileURLToPath(import.meta.url)), "../styles.css");
    const css = readBundledCss(cssPath);
    const fontFace = /font-family:\s*["']Lilex Nerd Font["'][\s\S]{0,300}?url\(["']?\.\/fonts\/Lilex\//i.exec(css);
    expect(fontFace, "expected Lilex Nerd Font @font-face with local URL").not.toBeNull();
  });

  it("opens the settings font picker below its trigger", () => {
    const cssPath = resolve(dirname(fileURLToPath(import.meta.url)), "../styles.css");
    const css = readBundledCss(cssPath);
    const genericPopoverIndex = css.indexOf(".project-picker-popover {");
    const settingsPopoverIndex = css.indexOf(".project-picker-popover.settings-picker-popover");
    const settingsRule = /\.project-picker-popover\.settings-picker-popover\s*\{(?<body>[^}]+)\}/i.exec(css);

    expect(genericPopoverIndex, "expected generic project picker popover rule").toBeGreaterThanOrEqual(0);
    expect(settingsPopoverIndex, "expected settings font picker override after generic rule").toBeGreaterThan(genericPopoverIndex);
    expect(settingsRule?.groups?.body).toMatch(/top:\s*calc\(100%\s*\+\s*6px\)/i);
    expect(settingsRule?.groups?.body).toMatch(/bottom:\s*auto/i);
  });
});
