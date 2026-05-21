import type { MenuItemConstructorOptions } from "electron";
import { findMenuKeybinding } from "../shared/menuKeybindings.js";
import type { MenuCommand } from "../shared/types.js";

export type { MenuCommand };

export interface MenuConfig {
  appName?: string;
  isDev?: boolean;
  onCommand: (command: MenuCommand) => void;
}

function menuItem(
  command: MenuCommand,
  fallbackLabel: string,
  dispatch: (c: MenuCommand) => () => void
): MenuItemConstructorOptions {
  const binding = findMenuKeybinding(command);
  return {
    label: fallbackLabel,
    ...(binding ? { accelerator: binding.accelerator } : {}),
    click: dispatch(command)
  };
}

export function buildAppMenuTemplate(config: MenuConfig): MenuItemConstructorOptions[] {
  const appName = config.appName ?? "Argmax";
  const isDev = config.isDev ?? false;
  const dispatch = (command: MenuCommand): (() => void) => () => config.onCommand(command);

  const appMenu: MenuItemConstructorOptions = {
    label: appName,
    submenu: [
      { role: "about", label: `About ${appName}` },
      { type: "separator" },
      menuItem("open-settings", "Settings…", dispatch),
      menuItem("check-for-updates", "Check for Updates…", dispatch),
      { type: "separator" },
      { role: "services" },
      { type: "separator" },
      { role: "hide", label: `Hide ${appName}` },
      { role: "hideOthers" },
      { role: "unhide" },
      { type: "separator" },
      { role: "quit", label: `Quit ${appName}` }
    ]
  };

  const fileMenu: MenuItemConstructorOptions = {
    label: "File",
    submenu: [
      menuItem("new-session", "New Session", dispatch),
      { type: "separator" },
      { role: "close" }
    ]
  };

  const editMenu: MenuItemConstructorOptions = {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "pasteAndMatchStyle" },
      { role: "selectAll" },
      { type: "separator" },
      { role: "delete" }
    ]
  };

  const viewMenu: MenuItemConstructorOptions = {
    label: "View",
    submenu: [
      menuItem("open-command-palette", "Command Palette…", dispatch),
      menuItem("toggle-sidebar", "Toggle Sidebar", dispatch),
      menuItem("toggle-debug-log", "Toggle Debug Log", dispatch),
      { type: "separator" },
      ...(isDev
        ? [
            { role: "reload" } as MenuItemConstructorOptions,
            { role: "forceReload" } as MenuItemConstructorOptions,
            { role: "toggleDevTools" } as MenuItemConstructorOptions,
            { type: "separator" } as MenuItemConstructorOptions
          ]
        : []),
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" }
    ]
  };

  const windowMenu: MenuItemConstructorOptions = {
    label: "Window",
    submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "front" }]
  };

  const helpMenu: MenuItemConstructorOptions = {
    role: "help",
    submenu: [
      menuItem("open-cheat-sheet", "Keyboard Shortcuts", dispatch)
    ]
  };

  return [appMenu, fileMenu, editMenu, viewMenu, windowMenu, helpMenu];
}
