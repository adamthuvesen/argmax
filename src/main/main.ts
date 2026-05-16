import { app, BrowserWindow, dialog, ipcMain, Menu, screen, shell } from "electron";
import { is } from "@electron-toolkit/utils";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createDatabase, type ArgmaxDatabase } from "./persistence/database.js";
import { registerIpcHandlers } from "./ipc.js";
let registeredChannels: readonly string[] = [];
import { ProviderSessionService } from "./providers/providerSessionService.js";
import { TerminalService } from "./terminal/terminalService.js";
import { McpAuthService } from "./mcp/mcpAuthService.js";
import { NotificationService } from "./notifications/notificationService.js";
import { DockBadgeService } from "./dock/dockBadgeService.js";
import { buildAppMenuTemplate, type MenuCommand } from "./menu.js";
import { UpdateService } from "./updater/updateService.js";
import { GhService } from "./gh/ghService.js";
import { GhPoller } from "./gh/ghPoller.js";
import { PROVIDER_MODEL_DEFAULTS } from "../shared/providerModels.js";
import type {
  DashboardDelta,
  McpAuthDataEvent,
  McpAuthExitEvent,
  TerminalDataEvent,
  TerminalExitEvent
} from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { errorMessage } from "../shared/error.js";
import { DeltaCoalescer } from "./util/deltaCoalescer.js";
import { mark as markStartupPhase } from "./util/startupTimer.js";
import { isAllowedAppNavigation, rendererFileNavigationPrefix } from "./util/appNavigation.js";

app.setName("Argmax");

let mainWindow: BrowserWindow | null = null;
let database: ArgmaxDatabase | null = null;
let providerSessions: ProviderSessionService | null = null;
let terminals: TerminalService | null = null;
let mcpAuth: McpAuthService | null = null;
let dockBadge: DockBadgeService | null = null;
let updateService: UpdateService | null = null;
let ghPoller: GhPoller | null = null;
let shutdownInProgress = false;
const currentDirectory = fileURLToPath(new URL(".", import.meta.url));
const iconPath = join(currentDirectory, "..", "..", "assets", "icon.png");

async function createWindow(): Promise<void> {
  const rendererIndexPath = join(currentDirectory, "../renderer/index.html");
  // Open the window covering the primary display's work area (between the
  // menu bar and dock). We pass the work area's x/y origin so the window
  // doesn't slide behind the menu bar when centered, then call maximize()
  // after creation so the green traffic light still toggles back to a
  // smaller size.
  const workArea = screen.getPrimaryDisplay().workArea;
  mainWindow = new BrowserWindow({
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height,
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
    // maximize() before show() so the window appears already covering the
    // work area with no flash. Belt-and-braces alongside the explicit
    // workArea bounds above — handles edge cases like dock auto-hide
    // changing the available height between BrowserWindow construction and
    // first paint.
    mainWindow?.maximize();
    mainWindow?.show();
    markStartupPhase("window.ready-to-show");
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
        : rendererFileNavigationPrefix(rendererIndexPath);
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowed = isAllowedAppNavigation(url, loadedOrigin);
    if (!allowed) {
      event.preventDefault();
    }
  });

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else if (is.dev) {
    await mainWindow.loadURL("http://127.0.0.1:5173");
  } else {
    await mainWindow.loadFile(rendererIndexPath);
  }
}

void app.whenReady().then(async () => {
  if (process.platform === "darwin" && app.dock) {
    app.dock.setIcon(iconPath);
  }
  database = createDatabase();
  markStartupPhase("db.open");
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
  mcpAuth = new McpAuthService({
    emitData: publishMcpAuthData,
    emitExit: publishMcpAuthExit
  });
  dockBadge.update();
  markStartupPhase("services.construct");
  registeredChannels = registerIpcHandlers(database, providerSessions, terminals, mcpAuth);
  markStartupPhase("ipc.register");

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
  markStartupPhase("window.create");

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
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

// Coalesce dashboard:delta pushes at ~60 fps (ralph C7). Provider session
// flushes can emit several deltas per second under load; without this cap,
// the renderer commits per push and re-walks the snapshot for each tick.
const dashboardDeltaCoalescer = new DeltaCoalescer((delta: DashboardDelta) => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send("dashboard:delta", delta);
    }
  }
  dockBadge?.update();
});

function publishDashboardDelta(delta: DashboardDelta): void {
  dashboardDeltaCoalescer.publish(delta);
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

function publishMcpAuthData(event: McpAuthDataEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send("mcp:auth:data", event);
    }
  }
}

function publishMcpAuthExit(event: McpAuthExitEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send("mcp:auth:exit", event);
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
  void shutdown(0);
});

/**
 * Run one cleanup step in isolation. Each step is independent so a failure
 * in one doesn't strand the others — a half-flushed WAL or leaked IPC
 * handler is worse than a logged error in disposeAll.
 */
async function safeDispose(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    logger.error("shutdown", `${label} failed`, { error: errorMessage(error) });
  }
}

async function shutdown(exitCode = 0): Promise<void> {
  if (ghPoller) {
    await safeDispose("ghPoller.stop", () => ghPoller?.stop());
    ghPoller = null;
  }
  if (providerSessions) {
    await safeDispose("disposeAll", () => providerSessions?.disposeAll());
  }
  if (terminals) {
    await safeDispose("terminals.disposeAll", () => terminals?.disposeAll());
  }
  if (mcpAuth) {
    await safeDispose("mcpAuth.disposeAll", () => mcpAuth?.disposeAll());
    mcpAuth = null;
  }
  for (const channel of registeredChannels) {
    ipcMain.removeHandler(channel);
  }
  if (database) {
    await safeDispose("database close", () => {
      database?.clearPruneInterval();
      database?.connection.close();
    });
    database = null;
  }
  app.exit(exitCode);
}
