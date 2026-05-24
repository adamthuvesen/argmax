import { app, BrowserWindow, dialog } from "electron";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { registerAttachmentSchemeAsPrivileged } from "./attachments/attachmentProtocol.js";
import { registerWorkspaceAssetSchemeAsPrivileged } from "./assets/workspaceAssetProtocol.js";
import { logger } from "../shared/logger.js";
import { errorMessage } from "../shared/error.js";
import { mark as markStartupPhase } from "./util/startupTimer.js";
import { createMainWindow } from "./bootstrap/mainWindow.js";
import {
  bootstrapServices,
  installAppMenu,
  shutdownServices,
  type ServiceContainer
} from "./bootstrap/appBootstrap.js";

app.setName("Argmax");

// Electron 35's GPU helper can be killed by macOS during local dev startup on
// some machines, which tears down `npm run dev` before the window appears.
// Packaged builds keep hardware acceleration enabled.
if (process.platform === "darwin" && !app.isPackaged) {
  app.disableHardwareAcceleration();
}

// Single-instance lock — a second launch of Argmax (double-click,
// Spotlight while already open, etc.) opens the same SQLite WAL and races
// the migration runner / orphan reconciler against the running instance.
// Reject the second launch and refocus the existing window instead.
// (audit-2026-05-17 H11)
if (!app.requestSingleInstanceLock()) {
  app.quit();
}
app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// Must register the custom schemes as privileged BEFORE app.whenReady so the
// renderer treats argmax-attachment:// and argmax-asset:// as trusted origins
// and <img src> works.
registerAttachmentSchemeAsPrivileged();
registerWorkspaceAssetSchemeAsPrivileged();

let mainWindow: BrowserWindow | null = null;
let services: ServiceContainer | null = null;
let shutdownInProgress = false;
const currentDirectory = fileURLToPath(new URL(".", import.meta.url));
const iconPath = join(currentDirectory, "..", "..", "assets", "icon.png");

void app.whenReady().then(async () => {
  if (process.platform === "darwin" && app.dock) {
    app.dock.setIcon(iconPath);
  }
  services = await bootstrapServices({
    iconPath,
    getMainWindow: () => mainWindow
  });
  installAppMenu({
    getMainWindow: () => mainWindow,
    updateService: services.updateService
  });

  mainWindow = await createMainWindow({ currentDirectory, iconPath });
  markStartupPhase("window.create");

  // Start the gh poller and the auto-update check AFTER the window exists
  // so the first delta publish / first update-downloaded dialog has a
  // window to attach to. (audit-2026-05-17 H12)
  services.ghPoller.start();
  if (services.updateService) {
    void services.updateService.runStartupCheck();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow({ currentDirectory, iconPath }).then((window) => {
        mainWindow = window;
      });
    }
  });
}).catch((error) => {
  const message = errorMessage(error);
  logger.error("startup", "boot failed", { error: message });
  try {
    dialog.showErrorBox("Argmax failed to start", message);
  } catch {
    /* dialog may be unavailable during early boot */
  }
  void shutdown(1);
});

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
  void shutdown(0);
});

async function shutdown(exitCode = 0): Promise<void> {
  await shutdownServices(services ?? {});
  services = null;
  app.exit(exitCode);
}
