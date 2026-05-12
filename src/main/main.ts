import { app, BrowserWindow, ipcMain, shell } from "electron";
import { is } from "@electron-toolkit/utils";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createDatabase, type ArgmaxDatabase } from "./persistence/database.js";
import { registerIpcHandlers } from "./ipc.js";
let registeredChannels: readonly string[] = [];
import { ProviderSessionService } from "./providers/providerSessionService.js";
import { NotificationService } from "./notifications/notificationService.js";
import type { DashboardDelta } from "../shared/types.js";

let mainWindow: BrowserWindow | null = null;
let database: ArgmaxDatabase | null = null;
let providerSessions: ProviderSessionService | null = null;
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
    show: false,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: join(currentDirectory, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // Sandboxed preloads must be CommonJS; this project is `"type": "module"`
      // and ships an ESM preload. Re-enabling sandbox needs a separate esbuild
      // step that bundles the preload as .cjs. `contextIsolation: true` +
      // `nodeIntegration: false` remain the main isolation walls.
      sandbox: false
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
  providerSessions = new ProviderSessionService(database, undefined, publishDashboardDelta, notifications);
  registeredChannels = registerIpcHandlers(database, providerSessions);

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
  if (providerSessions) {
    try {
      await providerSessions.disposeAll();
    } catch (error) {
      console.error("[argmax] disposeAll failed during shutdown:", error);
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
