import { app, BrowserWindow, ipcMain } from "electron";
import { is } from "@electron-toolkit/utils";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createDatabase, type ArgmaxDatabase } from "./persistence/database.js";
import { registerIpcHandlers } from "./ipc.js";
let registeredChannels: readonly string[] = [];
import { ProviderSessionService } from "./providers/providerSessionService.js";
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
    backgroundColor: "#101418",
    show: false,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: join(currentDirectory, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
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
  providerSessions = new ProviderSessionService(database, undefined, publishDashboardDelta);
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
  try {
    if (providerSessions) {
      await providerSessions.disposeAll();
    }
    for (const channel of registeredChannels) {
      ipcMain.removeHandler(channel);
    }
    if (database) {
      database.clearPruneInterval();
      database.connection.close();
      database = null;
    }
  } finally {
    app.exit(0);
  }
}
