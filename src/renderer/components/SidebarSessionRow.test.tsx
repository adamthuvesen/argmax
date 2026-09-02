import { cleanup, render, screen } from "@testing-library/react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSummary } from "../../shared/types.js";
import { readBundledCss } from "../styles/readBundledCss.js";
import { SidebarSessionRow, sidebarSessionRowEqual } from "./SidebarSessionRow.js";
import { WORKING_NEST_CYCLE_MS } from "./WorkingNest.js";

const workspaceBase: WorkspaceSummary = {
  id: "workspace-1",
  projectId: "project-1",
  taskLabel: "Build the dashboard",
  branch: "argmax/dashboard-abcd1234",
  baseRef: "main",
  path: "/tmp/workspaces/argmax-dashboard",
  state: "complete",
  sharedWorkspace: false,
  kind: "git",
  dirty: false,
  changedFiles: 0,
  lastActivityAt: "2026-05-01T00:01:00.000Z",
  pinned: false,
  priorityDismissedAt: null,
  priorityAddedAt: null
};

const detectedIdes = [
  { id: "vscode" as const, label: "VS Code", appPath: "/Applications/Visual Studio Code.app", hasCli: true },
  { id: "cursor" as const, label: "Cursor", appPath: "/Applications/Cursor.app", hasCli: true }
];

describe("SidebarSessionRow", () => {
  afterEach(() => cleanup());

  it("keeps the IDE chooser in the right-click menu, not on the hovered row", async () => {
    const { fireEvent } = await import("@testing-library/react");
    render(
      <SidebarSessionRow
        workspace={workspaceBase}
        isSelected={false}
        isOpenInGrid={false}
        canDragToGrid={true}
        onOpenWorkspaceChat={vi.fn()}
        onArchiveWorkspace={vi.fn()}
        onOpenInIde={vi.fn()}
        detectedIdes={detectedIdes}
        defaultIde="vscode"
      />
    );

    // The row's hover actions are archive (and pin) only — no IDE button.
    expect(screen.queryByRole("button", { name: "Open in IDE" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Choose IDE" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive chat" })).toBeInTheDocument();

    fireEvent.contextMenu(screen.getByRole("button", { name: /Build the dashboard/ }));
    expect(screen.getByRole("menuitem", { name: "Open in IDE" })).toBeEnabled();
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
          isSelected={false}
          isOpenInGrid={false}
          canDragToGrid={true}
          onOpenWorkspaceChat={onOpen}
          onArchiveWorkspace={vi.fn()}
          onOpenInIde={vi.fn()}
          detectedIdes={detectedIdes}
          defaultIde="vscode"
        />
        <SidebarSessionRow
          workspace={{ ...workspaceBase, id: "ws-2", taskLabel: "Second" }}
          isSelected={false}
          isOpenInGrid={false}
          canDragToGrid={true}
          onOpenWorkspaceChat={onOpen}
          onArchiveWorkspace={vi.fn()}
          onOpenInIde={vi.fn()}
          detectedIdes={detectedIdes}
          defaultIde="vscode"
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
        isSelected={false}
        isOpenInGrid={false}
        canDragToGrid={true}
        onOpenWorkspaceChat={vi.fn()}
        onArchiveWorkspace={vi.fn()}
        onOpenInIde={vi.fn()}
        detectedIdes={detectedIdes}
        defaultIde="cursor"
      />
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: /Build the dashboard/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open in IDE" }));

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

  // Keeping the picker on screen is Floating UI's job now, and jsdom has no
  // layout for it to measure — so this checks the wiring instead: the menu is
  // portaled out to <body> and carries the primitive's own fixed positioning.
  // Drop the style spread and it falls back to the stylesheet's
  // `position: absolute; bottom: calc(100% + 6px)`, which at <body> puts the
  // menu at the top of the page rather than under its row.
  it("positions the IDE picker with the shared anchored-popover styles", async () => {
    const { fireEvent } = await import("@testing-library/react");
    render(
      <SidebarSessionRow
        workspace={workspaceBase}
        isSelected={false}
        isOpenInGrid={false}
        canDragToGrid={true}
        onOpenWorkspaceChat={vi.fn()}
        onArchiveWorkspace={vi.fn()}
        onOpenInIde={vi.fn()}
        detectedIdes={detectedIdes}
        defaultIde="cursor"
      />
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: /Build the dashboard/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open in IDE" }));

    const menu = await screen.findByRole("menu", { name: "Open this worktree in" });
    expect(menu.parentElement).toBe(document.body);
    expect(menu).toHaveStyle({ position: "fixed" });
  });

  it("dismisses the IDE picker on Escape", async () => {
    const { fireEvent } = await import("@testing-library/react");
    render(
      <SidebarSessionRow
        workspace={workspaceBase}
        isSelected={false}
        isOpenInGrid={false}
        canDragToGrid={true}
        onOpenWorkspaceChat={vi.fn()}
        onArchiveWorkspace={vi.fn()}
        onOpenInIde={vi.fn()}
        detectedIdes={detectedIdes}
        defaultIde="cursor"
      />
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: /Build the dashboard/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open in IDE" }));
    await screen.findByRole("menu", { name: "Open this worktree in" });

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Open this worktree in" })).toBeNull();
  });

  it("right-click → Rename edits the label in place and commits on Enter", async () => {
    const { fireEvent } = await import("@testing-library/react");
    const onRename = vi.fn();
    render(
      <SidebarSessionRow
        workspace={workspaceBase}
        isSelected={false}
        isOpenInGrid={false}
        canDragToGrid={true}
        onOpenWorkspaceChat={vi.fn()}
        onArchiveWorkspace={vi.fn()}
        onOpenInIde={vi.fn()}
        onRename={onRename}
        detectedIdes={detectedIdes}
        defaultIde="vscode"
      />
    );

    // Right-click opens the session context menu.
    fireEvent.contextMenu(screen.getByRole("button", { name: /Build the dashboard/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));

    // The label is replaced by an input seeded with the current label.
    const input = screen.getByRole("textbox", { name: "Rename chat" });
    expect(input).toHaveValue("Build the dashboard");

    fireEvent.change(input, { target: { value: "Ship the date view" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenCalledWith("workspace-1", "Ship the date view");
  });

  it("Escape cancels a rename without calling onRename", async () => {
    const { fireEvent } = await import("@testing-library/react");
    const onRename = vi.fn();
    render(
      <SidebarSessionRow
        workspace={workspaceBase}
        isSelected={false}
        isOpenInGrid={false}
        canDragToGrid={true}
        onOpenWorkspaceChat={vi.fn()}
        onArchiveWorkspace={vi.fn()}
        onOpenInIde={vi.fn()}
        onRename={onRename}
        detectedIdes={detectedIdes}
        defaultIde="vscode"
      />
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: /Build the dashboard/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Rename chat" });
    fireEvent.change(input, { target: { value: "Discarded" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onRename).not.toHaveBeenCalled();
    // Back to the normal label button.
    expect(screen.getByRole("button", { name: /Build the dashboard/ })).toBeInTheDocument();
  });

  it("does not offer a rename menu when onRename is not provided", async () => {
    const { fireEvent } = await import("@testing-library/react");
    render(
      <SidebarSessionRow
        workspace={workspaceBase}
        isSelected={false}
        isOpenInGrid={false}
        canDragToGrid={true}
        onOpenWorkspaceChat={vi.fn()}
        onArchiveWorkspace={vi.fn()}
        onOpenInIde={vi.fn()}
        detectedIdes={detectedIdes}
        defaultIde="vscode"
      />
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: /Build the dashboard/ }));
    expect(screen.queryByRole("menuitem", { name: "Rename" })).toBeNull();
  });

  it("right-click → Edit Icon applies the picked icon with the picked color", async () => {
    const { fireEvent } = await import("@testing-library/react");
    const onSetIcon = vi.fn();
    render(
      <SidebarSessionRow
        workspace={workspaceBase}
        isSelected={false}
        isOpenInGrid={false}
        canDragToGrid={true}
        onOpenWorkspaceChat={vi.fn()}
        onArchiveWorkspace={vi.fn()}
        onOpenInIde={vi.fn()}
        onSetIcon={onSetIcon}
        detectedIdes={detectedIdes}
        defaultIde="vscode"
      />
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: /Build the dashboard/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit Icon" }));

    const picker = await screen.findByRole("dialog", { name: "Edit Icon" });
    expect(picker).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Violet icon color" }));
    fireEvent.click(screen.getByRole("button", { name: "Brain" }));

    expect(onSetIcon).toHaveBeenCalledWith("workspace-1", "Brain", "violet");
    expect(screen.queryByRole("dialog", { name: "Edit Icon" })).toBeNull();
  });

  it("search narrows the icon grid to matching names", async () => {
    const { fireEvent } = await import("@testing-library/react");
    render(
      <SidebarSessionRow
        workspace={workspaceBase}
        isSelected={false}
        isOpenInGrid={false}
        canDragToGrid={true}
        onOpenWorkspaceChat={vi.fn()}
        onArchiveWorkspace={vi.fn()}
        onOpenInIde={vi.fn()}
        onSetIcon={vi.fn()}
        detectedIdes={detectedIdes}
        defaultIde="vscode"
      />
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: /Build the dashboard/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit Icon" }));
    await screen.findByRole("dialog", { name: "Edit Icon" });

    expect(screen.getByRole("button", { name: "Rocket" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search icons" }), {
      target: { value: "brain" }
    });

    expect(screen.getByRole("button", { name: "Brain" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rocket" })).toBeNull();
  });

  it("a running turn hides the custom icon and restores it when the turn ends", () => {
    const props = {
      isSelected: false,
      isOpenInGrid: false,
      canDragToGrid: true,
      onOpenWorkspaceChat: vi.fn(),
      onArchiveWorkspace: vi.fn(),
      onOpenInIde: vi.fn(),
      onSetIcon: vi.fn(),
      detectedIdes,
      defaultIde: "vscode" as const,
    };
    const { rerender } = render(
      <SidebarSessionRow
        {...props}
        workspace={{ ...workspaceBase, state: "running", icon: "Brain", iconColor: "violet" }}
      />
    );

    // The working nest owns the cell alone, with no glyph behind it.
    const running = screen.getByTitle(/Build the dashboard — running/);
    expect(running.querySelector('[data-working="true"]')).not.toBeNull();
    expect(running.querySelector('[data-icon-color="violet"]')).toBeNull();

    rerender(
      <SidebarSessionRow
        {...props}
        workspace={{ ...workspaceBase, state: "complete", icon: "Brain", iconColor: "violet" }}
      />
    );
    const done = screen.getByTitle(/Build the dashboard — complete/);
    expect(done.querySelector('[data-working="true"]')).toBeNull();
    expect(done.querySelector('[data-icon-color="violet"]')).not.toBeNull();
  });

  it.each([
    ["failed" as const, undefined, undefined, "failed"],
    ["complete" as const, "MERGED" as const, 12, "pr-merged"],
    ["complete" as const, "OPEN" as const, 12, "pr-open"],
    ["complete" as const, undefined, undefined, null]
  ])(
    "overlays %s / pr %s on a custom icon as %s",
    (state, prState, prNumber, expectedOverlay) => {
      render(
        <SidebarSessionRow
          workspace={{ ...workspaceBase, state, prState, prNumber, icon: "Flag", iconColor: "clay" }}
          isSelected={false}
          isOpenInGrid={false}
          canDragToGrid={true}
          onOpenWorkspaceChat={vi.fn()}
          onArchiveWorkspace={vi.fn()}
          onOpenInIde={vi.fn()}
          detectedIdes={detectedIdes}
          defaultIde="vscode"
        />
      );

      const overlay = document.querySelector("[data-overlay]");
      expect(overlay?.getAttribute("data-overlay") ?? null).toBe(expectedOverlay);
    }
  );

  it("the Default icon swatch clears the custom glyph", async () => {
    const { fireEvent } = await import("@testing-library/react");
    const onSetIcon = vi.fn();
    render(
      <SidebarSessionRow
        workspace={{ ...workspaceBase, icon: "Brain", iconColor: "violet" }}
        isSelected={false}
        isOpenInGrid={false}
        canDragToGrid={true}
        onOpenWorkspaceChat={vi.fn()}
        onArchiveWorkspace={vi.fn()}
        onOpenInIde={vi.fn()}
        onSetIcon={onSetIcon}
        detectedIdes={detectedIdes}
        defaultIde="vscode"
      />
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: /Build the dashboard/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit Icon" }));
    await screen.findByRole("dialog", { name: "Edit Icon" });
    fireEvent.click(screen.getByRole("button", { name: "Default icon" }));

    expect(onSetIcon).toHaveBeenCalledWith("workspace-1", null, null);
  });

  it("clearing the icon restores the default status marker on the row", () => {
    const props = {
      isSelected: false,
      isOpenInGrid: false,
      canDragToGrid: true,
      onOpenWorkspaceChat: vi.fn(),
      onArchiveWorkspace: vi.fn(),
      onOpenInIde: vi.fn(),
      detectedIdes,
      defaultIde: "vscode" as const,
    };
    const { rerender } = render(
      <SidebarSessionRow
        {...props}
        workspace={{ ...workspaceBase, state: "failed", icon: "Brain", iconColor: "violet" }}
      />
    );
    expect(document.querySelector("[data-icon-color]")).not.toBeNull();

    rerender(
      <SidebarSessionRow
        {...props}
        workspace={{ ...workspaceBase, state: "failed", icon: null, iconColor: null }}
      />
    );
    expect(document.querySelector("[data-icon-color]")).toBeNull();
    expect(document.querySelector(".status-marker")).not.toBeNull();
  });

  it("recoloring while an icon is set applies immediately without closing the picker", async () => {
    const { fireEvent } = await import("@testing-library/react");
    const onSetIcon = vi.fn();
    render(
      <SidebarSessionRow
        workspace={{ ...workspaceBase, icon: "Brain", iconColor: "violet" }}
        isSelected={false}
        isOpenInGrid={false}
        canDragToGrid={true}
        onOpenWorkspaceChat={vi.fn()}
        onArchiveWorkspace={vi.fn()}
        onOpenInIde={vi.fn()}
        onSetIcon={onSetIcon}
        detectedIdes={detectedIdes}
        defaultIde="vscode"
      />
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: /Build the dashboard/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit Icon" }));
    await screen.findByRole("dialog", { name: "Edit Icon" });
    fireEvent.click(screen.getByRole("button", { name: "Amber icon color" }));

    expect(onSetIcon).toHaveBeenCalledWith("workspace-1", "Brain", "amber");
    expect(screen.getByRole("dialog", { name: "Edit Icon" })).toBeInTheDocument();
  });

  it("does not offer Edit Icon when onSetIcon is not provided", async () => {
    const { fireEvent } = await import("@testing-library/react");
    render(
      <SidebarSessionRow
        workspace={workspaceBase}
        isSelected={false}
        isOpenInGrid={false}
        canDragToGrid={true}
        onOpenWorkspaceChat={vi.fn()}
        onArchiveWorkspace={vi.fn()}
        onOpenInIde={vi.fn()}
        onRename={vi.fn()}
        detectedIdes={detectedIdes}
        defaultIde="vscode"
      />
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: /Build the dashboard/ }));
    expect(screen.queryByRole("menuitem", { name: "Edit Icon" })).toBeNull();
  });

  it("memo comparator skips re-render when a new workspace object has identical visible fields (ralph C1)", () => {
    const onOpenWorkspaceChat = vi.fn();
    const onArchiveWorkspace = vi.fn();
    const onOpenInIde = vi.fn();
    const sharedIdes = detectedIdes;
    const prev = {
      workspace: { ...workspaceBase },
      isSelected: false,
      isOpenInGrid: false,
      canDragToGrid: true,
      onOpenWorkspaceChat,
      onArchiveWorkspace,
      onOpenInIde,
      detectedIdes: sharedIdes,
      defaultIde: "vscode" as const,
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

  it("shows a merged-PR marker when the workspace has a merged pull request", () => {
    render(
      <SidebarSessionRow
        workspace={{ ...workspaceBase, prState: "MERGED", prNumber: 42 }}
        isSelected={false}
        isOpenInGrid={false}
        canDragToGrid={true}
        onOpenWorkspaceChat={vi.fn()}
        onArchiveWorkspace={vi.fn()}
        onOpenInIde={vi.fn()}
        detectedIdes={detectedIdes}
        defaultIde="vscode"
      />
    );

    const row = screen.getByTitle(/merged pull request #42/);
    expect(row).toBeInTheDocument();
    expect(row.querySelector('[data-pr="merged"]')).not.toBeNull();
    expect(row.querySelector('[data-pr="open"]')).toBeNull();
  });

  it("shows an open-PR marker when the workspace has an open pull request", () => {
    render(
      <SidebarSessionRow
        workspace={{ ...workspaceBase, prState: "OPEN", prNumber: 7 }}
        isSelected={false}
        isOpenInGrid={false}
        canDragToGrid={true}
        onOpenWorkspaceChat={vi.fn()}
        onArchiveWorkspace={vi.fn()}
        onOpenInIde={vi.fn()}
        detectedIdes={detectedIdes}
        defaultIde="vscode"
      />
    );

    const row = screen.getByTitle(/open pull request #7/);
    expect(row).toBeInTheDocument();
    expect(row.querySelector('[data-pr="open"]')).not.toBeNull();
    expect(row.querySelector('[data-pr="merged"]')).toBeNull();
  });

  it("leaves an idle completed row text-only, with the state still in its title", () => {
    render(
      <SidebarSessionRow
        workspace={workspaceBase}
        isSelected={false}
        isOpenInGrid={false}
        canDragToGrid={true}
        onOpenWorkspaceChat={vi.fn()}
        onArchiveWorkspace={vi.fn()}
        onOpenInIde={vi.fn()}
        detectedIdes={detectedIdes}
        defaultIde="vscode"
      />
    );

    const row = screen.getByTitle(/Build the dashboard — complete/);
    // No leading glyph at all: a done session is not worth a column of checks.
    expect(row.querySelector("svg")).toBeNull();
  });

  it("keeps a leading marker on rows that carry a live signal", () => {
    const props = {
      isSelected: false,
      isOpenInGrid: false,
      canDragToGrid: true,
      onOpenWorkspaceChat: vi.fn(),
      onArchiveWorkspace: vi.fn(),
      onOpenInIde: vi.fn(),
      detectedIdes,
      defaultIde: "vscode" as const,
    };

    const { rerender } = render(
      <SidebarSessionRow {...props} workspace={{ ...workspaceBase, state: "failed" }} />
    );
    expect(screen.getByTitle(/Build the dashboard — failed/).querySelector("svg")).not.toBeNull();

    rerender(<SidebarSessionRow {...props} workspace={{ ...workspaceBase, state: "running" }} />);
    expect(screen.getByTitle(/Build the dashboard — running/).querySelector("svg")).not.toBeNull();

    rerender(
      <SidebarSessionRow
        {...props}
        workspace={{ ...workspaceBase, state: "complete" }}
        priorityAttention="blocked"
      />
    );
    expect(
      screen.getByTitle(/Build the dashboard — complete — waiting for input/).querySelector("svg")
    ).not.toBeNull();
  });

  it("keeps the custom icon on a calm row", () => {
    render(
      <SidebarSessionRow
        workspace={{ ...workspaceBase, icon: "Brain", iconColor: "violet" }}
        isSelected={false}
        isOpenInGrid={false}
        canDragToGrid={true}
        onOpenWorkspaceChat={vi.fn()}
        onArchiveWorkspace={vi.fn()}
        onOpenInIde={vi.fn()}
        detectedIdes={detectedIdes}
        defaultIde="vscode"
      />
    );

    const row = screen.getByTitle(/Build the dashboard — complete/);
    expect(row.querySelector('[data-icon-color="violet"] svg')).not.toBeNull();
  });

  it("shows no PR-specific marker for a closed PR", () => {
    render(
      <SidebarSessionRow
        workspace={{ ...workspaceBase, prState: "CLOSED", prNumber: 9 }}
        isSelected={false}
        isOpenInGrid={false}
        canDragToGrid={true}
        onOpenWorkspaceChat={vi.fn()}
        onArchiveWorkspace={vi.fn()}
        onOpenInIde={vi.fn()}
        detectedIdes={detectedIdes}
        defaultIde="vscode"
      />
    );

    // The title omits any pull-request text, and no PR-colored marker renders.
    const row = screen.getByRole("button", { name: /Build the dashboard/ });
    expect(row.getAttribute("title")).not.toMatch(/pull request/);
    expect(row.querySelector("[data-pr]")).toBeNull();
  });

  it("PR marker wins over a failed session state", () => {
    render(
      <SidebarSessionRow
        workspace={{ ...workspaceBase, state: "failed", prState: "MERGED", prNumber: 1 }}
        isSelected={false}
        isOpenInGrid={false}
        canDragToGrid={true}
        onOpenWorkspaceChat={vi.fn()}
        onArchiveWorkspace={vi.fn()}
        onOpenInIde={vi.fn()}
        detectedIdes={detectedIdes}
        defaultIde="vscode"
      />
    );

    const row = screen.getByTitle(/merged pull request #1/);
    expect(row.querySelector('[data-pr="merged"]')).not.toBeNull();
  });

  it("shows a working marker while the workspace turn is running", () => {
    render(
      <SidebarSessionRow
        workspace={{ ...workspaceBase, state: "running" }}
        isSelected={false}
        isOpenInGrid={false}
        canDragToGrid={true}
        onOpenWorkspaceChat={vi.fn()}
        onArchiveWorkspace={vi.fn()}
        onOpenInIde={vi.fn()}
        detectedIdes={detectedIdes}
        defaultIde="vscode"
      />
    );

    // The row's accessible title carries the state; the marker itself is the
    // decorative working ring.
    const row = screen.getByTitle(/Build the dashboard — running/);
    expect(row.querySelector('[data-working="true"]')).not.toBeNull();
    expect(row.querySelector("[data-pr]")).toBeNull();
  });

  it("working marker wins over PR markers while a turn is in flight", () => {
    render(
      <SidebarSessionRow
        workspace={{ ...workspaceBase, state: "running", prState: "OPEN", prNumber: 3 }}
        isSelected={false}
        isOpenInGrid={false}
        canDragToGrid={true}
        onOpenWorkspaceChat={vi.fn()}
        onArchiveWorkspace={vi.fn()}
        onOpenInIde={vi.fn()}
        detectedIdes={detectedIdes}
        defaultIde="vscode"
      />
    );

    // The title still names the PR for screen readers even while the visual
    // marker shows live activity.
    const row = screen.getByTitle(/open pull request #3/);
    expect(row.querySelector('[data-working="true"]')).not.toBeNull();
    expect(row.querySelector('[data-pr="open"]')).toBeNull();
  });

  it.each([
    ["complete", null, null],
    ["failed", null, null],
    ["cancelled", null, null],
    ["complete", "OPEN", 5]
  ] as const)(
    "reverts to the normal status icon when the turn ends as %s (pr: %s)",
    (endState, prState, prNumber) => {
      const props = {
        isSelected: false,
        isOpenInGrid: false,
        canDragToGrid: true,
        onOpenWorkspaceChat: vi.fn(),
        onArchiveWorkspace: vi.fn(),
        onOpenInIde: vi.fn(),
        detectedIdes,
        defaultIde: "vscode" as const,
      };
      const { rerender } = render(
        <SidebarSessionRow {...props} workspace={{ ...workspaceBase, state: "running" }} />
      );
      expect(document.querySelector('[data-working="true"]')).not.toBeNull();

      rerender(
        <SidebarSessionRow
          {...props}
          workspace={{ ...workspaceBase, state: endState, prState, prNumber }}
        />
      );
      expect(document.querySelector('[data-working="true"]')).toBeNull();
      if (prState === "OPEN") {
        expect(document.querySelector('[data-pr="open"]')).not.toBeNull();
      }
    }
  );

  it("ships working-marker CSS that relays emphasis and respects reduced motion", () => {
    const cssPath = resolve(dirname(fileURLToPath(import.meta.url)), "../styles.css");
    const css = readBundledCss(cssPath);

    // The running marker wears the configurable accent, like the mascot...
    const colorRule = /\.status-marker\[data-working="true"\]\s*\{[^}]*color:\s*var\(--accent\)/i.exec(css);
    expect(colorRule, "expected accent color rule for the working marker").not.toBeNull();

    // ...its dots share the asymmetric relay and stable phase offset...
    const dotRule = /\.working-nest\[data-active="true"\]\s\.working-nest-dot\s*\{[^}]*animation:\s*working-nest-relay/i.exec(css);
    expect(dotRule, "expected relay animation on the working dots").not.toBeNull();
    expect(css).toContain("@keyframes working-nest-relay");
    expect(css).toContain("--working-nest-phase-offset");
    expect(css).toContain(`--working-nest-cycle: ${WORKING_NEST_CYCLE_MS / 1000}s`);

    // ...and reduced-motion users get a static dot.
    const reduceBlock = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^{}]*\.working-nest\[data-active="true"\]\s\.working-nest-dot\s*\{[^}]*animation:\s*none/i.exec(css);
    expect(reduceBlock, "expected reduced-motion override for the working dot").not.toBeNull();
  });

  it("ships sidebar action CSS that reveals on hover and stays keyboard-reachable", () => {
    const cssPath = resolve(dirname(fileURLToPath(import.meta.url)), "../styles.css");
    const css = readBundledCss(cssPath);

    // Actions are hidden at rest...
    const actionRule = /\.session-row-action\s*\{[^}]*opacity:\s*([0-9.]+)/i.exec(css);
    const archiveRule = /\.session-archive-btn\s*\{[^}]*opacity:\s*([0-9.]+)/i.exec(css);

    expect(actionRule, "expected .session-row-action opacity rule").not.toBeNull();
    expect(archiveRule, "expected .session-archive-btn opacity rule").not.toBeNull();

    expect(parseFloat(actionRule?.[1] ?? "1")).toBe(0);
    expect(parseFloat(archiveRule?.[1] ?? "1")).toBe(0);

    // ...revealed when the row is hovered or focused...
    const hoverReveal = /\.session-row:hover \.session-row-action[^{]*\{[^}]*opacity:\s*([0-9.]+)/i.exec(css);
    expect(hoverReveal, "expected hover reveal rule for row actions").not.toBeNull();
    expect(parseFloat(hoverReveal?.[1] ?? "0")).toBeGreaterThan(0);

    // ...and always reachable via keyboard focus even without a hover.
    const focusReveal = /\.session-row-action:focus-visible\s*\{[^}]*opacity:\s*([0-9.]+)/i.exec(css);
    expect(focusReveal, "expected :focus-visible reveal rule for row actions").not.toBeNull();
    expect(parseFloat(focusReveal?.[1] ?? "0")).toBeGreaterThan(0);
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
    // The bare selector (with the brace) targets the base override in
    // chat-chrome.css; settings-controls.css also carries a
    // `[data-placement="above"]`-qualified variant that bundles earlier.
    const settingsPopoverIndex = css.indexOf(".project-picker-popover.settings-picker-popover {");
    const settingsRule = /\.project-picker-popover\.settings-picker-popover\s*\{(?<body>[^}]+)\}/i.exec(css);

    expect(genericPopoverIndex, "expected generic project picker popover rule").toBeGreaterThanOrEqual(0);
    expect(settingsPopoverIndex, "expected settings font picker override after generic rule").toBeGreaterThan(genericPopoverIndex);
    expect(settingsRule?.groups?.body).toMatch(/top:\s*calc\(100%\s*\+\s*6px\)/i);
    expect(settingsRule?.groups?.body).toMatch(/bottom:\s*auto/i);
  });

  it("keeps the first assistant turn reveal from moving vertically under metadata", () => {
    const cssPath = resolve(dirname(fileURLToPath(import.meta.url)), "../styles.css");
    const css = readBundledCss(cssPath);
    const revealRule = /\.turn-block-body\[data-just-revealed="true"\]\s*>\s*\*:first-child\s*\{(?<body>[^}]+)\}/i.exec(css);
    const keyframeStart = css.indexOf("@keyframes turn-phase-land");
    const nextKeyframe = css.indexOf("@keyframes", keyframeStart + 1);
    const keyframe = css.slice(keyframeStart, nextKeyframe > keyframeStart ? nextKeyframe : undefined);

    expect(revealRule?.groups?.body).toContain("turn-phase-land");
    expect(keyframeStart).toBeGreaterThanOrEqual(0);
    expect(keyframe).not.toMatch(/translateY|transform/i);
  });

  it("marks a synced session with the agent it came from", () => {
    render(
      <SidebarSessionRow
        workspace={workspaceBase}
        importedProvider="Claude"
        isSelected={false}
        isOpenInGrid={false}
        canDragToGrid={true}
        onOpenWorkspaceChat={vi.fn()}
        onArchiveWorkspace={vi.fn()}
        onOpenInIde={vi.fn()}
        detectedIdes={detectedIdes}
        defaultIde="vscode"
      />
    );
    expect(screen.getByTitle("Synced from Claude")).toHaveTextContent("Claude");
  });

  it("offers Sync now on an imported row and runs the sweep once", async () => {
    const { fireEvent } = await import("@testing-library/react");
    const onSyncNow = vi.fn();
    render(
      <SidebarSessionRow
        workspace={workspaceBase}
        importedProvider="Claude"
        isSelected={false}
        isOpenInGrid={false}
        canDragToGrid={true}
        onOpenWorkspaceChat={vi.fn()}
        onArchiveWorkspace={vi.fn()}
        onOpenInIde={vi.fn()}
        onSyncNow={onSyncNow}
        detectedIdes={detectedIdes}
        defaultIde="vscode"
      />
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: /Build the dashboard/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Sync now" }));

    expect(onSyncNow).toHaveBeenCalledTimes(1);
  });

  it("offers no Sync now when the row was not imported", async () => {
    const { fireEvent } = await import("@testing-library/react");
    render(
      <SidebarSessionRow
        workspace={workspaceBase}
        isSelected={false}
        isOpenInGrid={false}
        canDragToGrid={true}
        onOpenWorkspaceChat={vi.fn()}
        onArchiveWorkspace={vi.fn()}
        onOpenInIde={vi.fn()}
        onSyncNow={vi.fn()}
        detectedIdes={detectedIdes}
        defaultIde="vscode"
      />
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: /Build the dashboard/ }));
    expect(screen.queryByRole("menuitem", { name: "Sync now" })).toBeNull();
  });

  it("leaves rows for sessions started in Argmax unmarked", () => {
    render(
      <SidebarSessionRow
        workspace={workspaceBase}
        isSelected={false}
        isOpenInGrid={false}
        canDragToGrid={true}
        onOpenWorkspaceChat={vi.fn()}
        onArchiveWorkspace={vi.fn()}
        onOpenInIde={vi.fn()}
        detectedIdes={detectedIdes}
        defaultIde="vscode"
      />
    );
    expect(screen.queryByTitle(/^Synced from/)).not.toBeInTheDocument();
  });
});

describe("SidebarSessionRow copy ids", () => {
  afterEach(() => cleanup());

  it("puts the id block on the clipboard from the right-click menu", async () => {
    const { fireEvent, waitFor } = await import("@testing-library/react");
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(
      <SidebarSessionRow
        workspace={workspaceBase}
        copyableIds={"session   session-1\nworkspace workspace-1"}
        isSelected={false}
        isOpenInGrid={false}
        canDragToGrid={true}
        onOpenWorkspaceChat={vi.fn()}
        onArchiveWorkspace={vi.fn()}
        onOpenInIde={vi.fn()}
        detectedIdes={detectedIdes}
        defaultIde="vscode"
      />
    );
    fireEvent.contextMenu(screen.getByRole("button", { name: /Build the dashboard/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy ids" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("session   session-1\nworkspace workspace-1"));
    expect(screen.queryByRole("menu", { name: "Chat actions" })).not.toBeInTheDocument();
  });

  it("offers no Copy ids item when the row carries no id block", async () => {
    const { fireEvent } = await import("@testing-library/react");
    render(
      <SidebarSessionRow
        workspace={workspaceBase}
        isSelected={false}
        isOpenInGrid={false}
        canDragToGrid={true}
        onOpenWorkspaceChat={vi.fn()}
        onArchiveWorkspace={vi.fn()}
        onOpenInIde={vi.fn()}
        detectedIdes={detectedIdes}
        defaultIde="vscode"
      />
    );
    fireEvent.contextMenu(screen.getByRole("button", { name: /Build the dashboard/ }));
    expect(screen.queryByRole("menuitem", { name: "Copy ids" })).not.toBeInTheDocument();
  });
});
