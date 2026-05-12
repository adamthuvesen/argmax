import type { MenuItemConstructorOptions } from "electron";
import type { MenuCommand } from "../shared/types.js";

export type { MenuCommand };

export interface MenuConfig {
  appName?: string;
  isDev?: boolean;
  onCommand: (command: MenuCommand) => void;
  onCheckForUpdates?: () => void;
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
      {
        label: "Settings…",
        accelerator: "CmdOrCtrl+,",
        click: dispatch("open-settings")
      },
      {
        label: "Check for Updates…",
        click: () => config.onCheckForUpdates?.()
      },
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
      {
        label: "New Session",
        accelerator: "CmdOrCtrl+N",
        click: dispatch("new-session")
      },
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
      {
        label: "Command Palette…",
        accelerator: "CmdOrCtrl+K",
        click: dispatch("open-command-palette")
      },
      {
        label: "Toggle Sidebar",
        accelerator: "CmdOrCtrl+B",
        click: dispatch("toggle-sidebar")
      },
      {
        label: "Toggle Debug Log",
        accelerator: "CmdOrCtrl+Shift+D",
        click: dispatch("toggle-debug-log")
      },
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
      {
        label: "Keyboard Shortcuts",
        accelerator: "CmdOrCtrl+/",
        click: dispatch("open-cheat-sheet")
      }
    ]
  };

  return [appMenu, fileMenu, editMenu, viewMenu, windowMenu, helpMenu];
}
