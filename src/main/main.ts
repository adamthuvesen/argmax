import { app, BrowserWindow } from "electron";
import { is } from "@electron-toolkit/utils";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createDatabase } from "./persistence/database.js";
import { registerIpcHandlers } from "./ipc.js";

let mainWindow: BrowserWindow | null = null;
const currentDirectory = fileURLToPath(new URL(".", import.meta.url));

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1040,
    minHeight: 720,
    title: "Maestro",
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
  const database = createDatabase();
  registerIpcHandlers(database);

  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
