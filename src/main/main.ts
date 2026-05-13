import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import { is } from "@electron-toolkit/utils";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createDatabase, type ArgmaxDatabase } from "./persistence/database.js";
import { registerIpcHandlers } from "./ipc.js";
let registeredChannels: readonly string[] = [];
import { ProviderSessionService } from "./providers/providerSessionService.js";
import { TerminalService } from "./terminal/terminalService.js";
import { NotificationService } from "./notifications/notificationService.js";
import { DockBadgeService } from "./dock/dockBadgeService.js";
import { buildAppMenuTemplate, type MenuCommand } from "./menu.js";
import { UpdateService } from "./updater/updateService.js";
import { GhService } from "./gh/ghService.js";
import { GhPoller } from "./gh/ghPoller.js";
import { PROVIDER_MODEL_DEFAULTS } from "../shared/providerModels.js";
import type { DashboardDelta, TerminalDataEvent, TerminalExitEvent } from "../shared/types.js";

let mainWindow: BrowserWindow | null = null;
let database: ArgmaxDatabase | null = null;
let providerSessions: ProviderSessionService | null = null;
let terminals: TerminalService | null = null;
let dockBadge: DockBadgeService | null = null;
let updateService: UpdateService | null = null;
let ghPoller: GhPoller | null = null;
let shutdownInProgress = false;
const currentDirectory = fileURLToPath(new URL(".", import.meta.url));
const iconPath = join(currentDirectory, "..", "..", "assets", "icon.png");

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 620,
    resizable: true,
    title: "Argmax",
    icon: iconPath,
    backgroundColor: "#fbfbfa",
    // The first paint of the renderer lands ~150 ms after window construction.
    // Hide the window until `ready-to-show` fires (handler below) so the user
    // never sees the empty Electron-default chrome flash before the React
    // shell mounts.
    show: false,
    paintWhenInitiallyHidden: true,
    // hiddenInset draws the traffic lights inside a flush titlebar so the
    // sidebar header sits beside them. x/y tuned so the lights align with the
    // sidebar's "Argmax" header baseline at default zoom.
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 18 },
    // Vibrancy is intentionally off: Electron's "sidebar" vibrancy bleeds the
    // desktop colors through the light theme and clashes with the paper-white
    // panel surface. Revisit only after a side-by-side visual test against the
    // current --bg #fbfbfa value confirms no milky-grey artifacts.
    webPreferences: {
      preload: join(currentDirectory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  // Block any window.open / target=_blank attempts. External links should
  // route through `shell.openExternal` when we choose to support them.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  // Refuse any in-page navigation away from the loaded app bundle. The only
  // legitimate navigations during a session are dev-server reloads.
  const loadedOrigin =
    is.dev && process.env.ELECTRON_RENDERER_URL
      ? new URL(process.env.ELECTRON_RENDERER_URL).origin
      : is.dev
        ? "http://127.0.0.1:5173"
        : "file://";
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowed = loadedOrigin === "file://" ? url.startsWith("file://") : url.startsWith(loadedOrigin);
    if (!allowed) {
      event.preventDefault();
    }
  });

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else if (is.dev) {
    await mainWindow.loadURL("http://127.0.0.1:5173");
  } else {
    await mainWindow.loadFile(join(currentDirectory, "../renderer/index.html"));
  }
}

void app.whenReady().then(async () => {
  if (process.platform === "darwin" && app.dock) {
    app.dock.setIcon(iconPath);
  }
  database = createDatabase();
  const notifications = new NotificationService({
    isWindowFocused: () => mainWindow?.isFocused() === true
  });
  dockBadge = new DockBadgeService({
    setBadge: (text) => {
      if (process.platform === "darwin" && app.dock) {
        app.dock.setBadge(text);
      }
    },
    countAttention: () => database!.countAttention()
  });
  providerSessions = new ProviderSessionService(database, undefined, publishDashboardDelta, notifications);
  // Any session left in `running` at boot was orphaned by a previous process
  // (crash, kill, power loss). Reconcile before serving IPC so the renderer
  // sees an honest view instead of a phantom live session.
  providerSessions.recoverOrphanedSessions();
  terminals = new TerminalService(database, {
    emitData: publishTerminalData,
    emitExit: publishTerminalExit
  });
  dockBadge.update();
  registeredChannels = registerIpcHandlers(database, providerSessions, terminals);

  // CI feedback loop: poll PR check status for every running session; on a
  // transition into 'failure', fire a notification and launch a follow-up
  // session in the same worktree pre-filled with the failure context.
  const ghServiceForPoller = new GhService(database);
  ghPoller = new GhPoller({
    database,
    ghService: ghServiceForPoller,
    notifications,
    launchFollowUp: async (context) => {
      if (!database || !providerSessions) return;
      const workspace = database.getWorkspace(context.workspaceId);
      const project = database.getProject(workspace.projectId);
      const provider = project.settings.defaultProvider;
      const modelDefault = PROVIDER_MODEL_DEFAULTS[provider];
      await providerSessions.launch({
        workspaceId: workspace.id,
        provider,
        prompt: `Checks on PR #${context.prNumber} (commit ${context.headSha.slice(0, 12)}) are failing. Run \`gh pr checks ${context.prNumber}\` to see which checks failed, then investigate and fix.`,
        modelLabel: modelDefault.label,
        modelId: modelDefault.modelId,
        ...(modelDefault.reasoningEffort ? { reasoningEffort: modelDefault.reasoningEffort } : {}),
        cols: 120,
        rows: 36
      });
    }
  });
  ghPoller.start();

  // electron-updater only works in a packaged build — running it in dev or
  // unsigned would no-op at best and surface confusing errors at worst.
  if (app.isPackaged) {
    const { autoUpdater } = await import("electron-updater");
    updateService = new UpdateService({
      autoUpdater,
      dialog,
      log: (level, message, meta) => {
        console[level === "error" ? "error" : "log"](`[argmax:updater] ${message}`, meta ?? "");
      }
    });
    void updateService.runStartupCheck();
  }

  const menuTemplate = buildAppMenuTemplate({
    isDev: is.dev,
    onCommand: (command: MenuCommand) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("menu:command", command);
      }
    },
    onCheckForUpdates: () => {
      if (!updateService) {
        // Dev / unpackaged: surface a quick "no updater here" dialog so the
        // menu item still reads as wired-up instead of doing nothing.
        void dialog.showMessageBox({
          type: "info",
          title: "Updates",
          message: "Auto-update is only available in packaged builds.",
          buttons: ["OK"]
        });
        return;
      }
      void updateService.checkOnUserRequest();
    }
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));

  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

function publishDashboardDelta(delta: DashboardDelta): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send("dashboard:delta", delta);
    }
  }
  dockBadge?.update();
}

function publishTerminalData(event: TerminalDataEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send("terminal:data", event);
    }
  }
}

function publishTerminalExit(event: TerminalExitEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send("terminal:exit", event);
    }
  }
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  if (shutdownInProgress) {
    return;
  }
  shutdownInProgress = true;
  event.preventDefault();
  void shutdown();
});

async function shutdown(): Promise<void> {
  // Each cleanup step is independent so a failure in one doesn't strand the
  // others — a half-flushed WAL or leaked IPC handler is worse than a logged
  // error in disposeAll.
  if (ghPoller) {
    try {
      ghPoller.stop();
    } catch (error) {
      console.error("[argmax] ghPoller.stop failed during shutdown:", error);
    }
    ghPoller = null;
  }
  if (providerSessions) {
    try {
      await providerSessions.disposeAll();
    } catch (error) {
      console.error("[argmax] disposeAll failed during shutdown:", error);
    }
  }
  if (terminals) {
    try {
      terminals.disposeAll();
    } catch (error) {
      console.error("[argmax] terminals.disposeAll failed during shutdown:", error);
    }
  }
  for (const channel of registeredChannels) {
    ipcMain.removeHandler(channel);
  }
  if (database) {
    try {
      database.clearPruneInterval();
      database.connection.close();
    } catch (error) {
      console.error("[argmax] database close failed during shutdown:", error);
    }
    database = null;
  }
  app.exit(0);
}
