import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
import { buildAppMenuTemplate, type MenuCommand } from "../menu.js";

function findItem(
  template: readonly MenuItemConstructorOptions[],
  label: string
): MenuItemConstructorOptions | null {
  for (const item of template) {
    if (item.label === label) return item;
    const submenu = Array.isArray(item.submenu) ? item.submenu : null;
    if (submenu) {
      const nested = findItem(submenu, label);
      if (nested) return nested;
    }
  }
  return null;
}

describe("buildAppMenuTemplate", () => {
  const onCommand = vi.fn<(command: MenuCommand) => void>();

  it("includes the six top-level menus in macOS order", () => {
    const template = buildAppMenuTemplate({ onCommand });
    const labels = template.map((item) => item.label ?? item.role);
    expect(labels).toEqual(["Argmax", "File", "Edit", "View", "Window", expect.anything()]);
  });

  it("wires Cmd-,, Cmd+N, Cmd+K, Cmd+B, Cmd+Shift+D, Cmd+/ to renderer commands", () => {
    const template = buildAppMenuTemplate({ onCommand });
    const cases: Array<{ label: string; accelerator: string; command: MenuCommand }> = [
      { label: "Settings…", accelerator: "CmdOrCtrl+,", command: "open-settings" },
      { label: "New Session", accelerator: "CmdOrCtrl+N", command: "new-session" },
      { label: "Command Palette…", accelerator: "CmdOrCtrl+K", command: "open-command-palette" },
      { label: "Toggle Sidebar", accelerator: "CmdOrCtrl+B", command: "toggle-sidebar" },
      { label: "Toggle Debug Log", accelerator: "CmdOrCtrl+Shift+D", command: "toggle-debug-log" },
      { label: "Keyboard Shortcuts", accelerator: "CmdOrCtrl+/", command: "open-cheat-sheet" }
    ];

    for (const { label, accelerator, command } of cases) {
      const item = findItem(template, label);
      expect(item, `missing menu item ${label}`).not.toBeNull();
      expect(item?.accelerator).toBe(accelerator);
      onCommand.mockClear();
      // Cast: MenuItem click signature accepts up to 3 args; we don't pass any.
      (item?.click as ((...args: unknown[]) => void) | undefined)?.();
      expect(onCommand).toHaveBeenCalledWith(command);
    }
  });

  it("excludes Reload / DevTools in production builds", () => {
    const prodTemplate = buildAppMenuTemplate({ onCommand, isDev: false });
    expect(findItem(prodTemplate, "Toggle Developer Tools")).toBeNull();
    expect(findItem(prodTemplate, "Reload")).toBeNull();
  });

  it("includes Reload / DevTools in dev builds", () => {
    const devTemplate = buildAppMenuTemplate({ onCommand, isDev: true });
    const view = devTemplate.find((item) => item.label === "View");
    const submenuRoles = (Array.isArray(view?.submenu) ? view.submenu : []).map((item) => item.role);
    expect(submenuRoles).toContain("reload");
    expect(submenuRoles).toContain("toggleDevTools");
  });

  it("invokes onCheckForUpdates when the menu item is clicked", () => {
    const onCheckForUpdates = vi.fn<() => void>();
    const template = buildAppMenuTemplate({ onCommand, onCheckForUpdates });
    const item = findItem(template, "Check for Updates…");
    expect(item).not.toBeNull();
    (item?.click as ((...args: unknown[]) => void) | undefined)?.();
    expect(onCheckForUpdates).toHaveBeenCalledTimes(1);
  });
});
