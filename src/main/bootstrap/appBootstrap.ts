import { app, BrowserWindow, dialog, ipcMain, Menu } from "electron";
import { is } from "@electron-toolkit/utils";
import { createDatabase, type ArgmaxDatabase } from "../persistence/database.js";
import { registerIpcHandlers } from "../ipc.js";
import { ProviderSessionService } from "../providers/providerSessionService.js";
import { TerminalService } from "../terminal/terminalService.js";
import { McpAuthService } from "../mcp/mcpAuthService.js";
import { NotificationService } from "../notifications/notificationService.js";
import { DockBadgeService } from "../dock/dockBadgeService.js";
import { buildAppMenuTemplate, type MenuCommand } from "../menu.js";
import { UpdateService } from "../updater/updateService.js";
import { GhService } from "../gh/ghService.js";
import { GhPoller } from "../gh/ghPoller.js";
import {
  registerWorkspaceAssetProtocolHandler
} from "../assets/workspaceAssetProtocol.js";
import { registerAttachmentProtocolHandler } from "../attachments/attachmentProtocol.js";
import { PROVIDER_MODEL_DEFAULTS } from "../../shared/providerModels.js";
import type {
  DashboardDelta,
  McpAuthDataEvent,
  McpAuthExitEvent,
  TerminalDataEvent,
  TerminalExitEvent
} from "../../shared/types.js";
import { logger } from "../../shared/logger.js";
import { errorMessage } from "../../shared/error.js";
import { DeltaCoalescer } from "../util/deltaCoalescer.js";
import { mark as markStartupPhase } from "../util/startupTimer.js";

export interface ServiceContainer {
  database: ArgmaxDatabase;
  providerSessions: ProviderSessionService;
  terminals: TerminalService;
  mcpAuth: McpAuthService;
  notifications: NotificationService;
  dockBadge: DockBadgeService;
  ghPoller: GhPoller;
  updateService: UpdateService | null;
  registeredChannels: readonly string[];
  dashboardDeltaCoalescer: DeltaCoalescer;
  publishDashboardDelta: (delta: DashboardDelta) => void;
  broadcast: (channel: string, payload: unknown) => void;
}

export interface BootstrapDeps {
  iconPath: string;
  getMainWindow: () => BrowserWindow | null;
}

/**
 * Bring the full service graph up. Order matters: database first, then
 * services that read from it, then IPC, then poller + updater. The
 * dashboard-delta coalescer wraps `dockBadge.update()` so it must outlive
 * any service that publishes deltas.
 */
export async function bootstrapServices(deps: BootstrapDeps): Promise<ServiceContainer> {
  registerAttachmentProtocolHandler();
  const database = createDatabase();
  markStartupPhase("db.open");

  // Scope the workspace-asset scheme to known project + workspace roots so
  // a malicious README can't pull arbitrary files via the privileged scheme.
  // Roots are re-read on every request because the user adds/removes
  // workspaces at runtime.
  registerWorkspaceAssetProtocolHandler({
    getAllowedRoots: () => {
      const snapshot = database.listDashboard();
      return [
        ...snapshot.projects.map((p) => p.repoPath),
        ...snapshot.workspaces.map((w) => w.path)
      ];
    }
  });

  const notifications = new NotificationService({
    isWindowFocused: () => deps.getMainWindow()?.isFocused() === true
  });

  const dockBadge = new DockBadgeService({
    setBadge: (text) => {
      if (process.platform === "darwin" && app.dock) {
        app.dock.setBadge(text);
      }
    },
    countAttention: () => database.countAttention()
  });

  const broadcast = (channel: string, payload: unknown): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(channel, payload);
      }
    }
  };

  // Coalesce dashboard:delta pushes at ~60 fps (ralph C7). Provider session
  // flushes can emit several deltas per second under load; without this cap,
  // the renderer commits per push and re-walks the snapshot for each tick.
  const dashboardDeltaCoalescer = new DeltaCoalescer((delta) => {
    broadcast("dashboard:delta", delta);
    dockBadge.update();
  });
  const publishDashboardDelta = (delta: DashboardDelta): void => {
    dashboardDeltaCoalescer.publish(delta);
  };

  const providerSessions = new ProviderSessionService(
    database,
    undefined,
    publishDashboardDelta,
    notifications
  );
  // Any session left in `running` at boot was orphaned by a previous process
  // (crash, kill, power loss). Reconcile before serving IPC so the renderer
  // sees an honest view instead of a phantom live session.
  providerSessions.recoverOrphanedSessions();

  const terminals = new TerminalService(database, {
    emitData: (event: TerminalDataEvent) => broadcast("terminal:data", event),
    emitExit: (event: TerminalExitEvent) => broadcast("terminal:exit", event)
  });

  const mcpAuth = new McpAuthService({
    emitData: (event: McpAuthDataEvent) => broadcast("mcp:auth:data", event),
    emitExit: (event: McpAuthExitEvent) => broadcast("mcp:auth:exit", event)
  });

  dockBadge.update();
  markStartupPhase("services.construct");

  const registered = registerIpcHandlers(database, providerSessions, terminals, mcpAuth, notifications);
  markStartupPhase("ipc.register");

  // CI feedback loop: poll PR check status for every running session; on a
  // transition into 'failure', fire a notification and launch a follow-up
  // session in the same worktree pre-filled with the failure context.
  const ghServiceForPoller = new GhService(database);
  const ghPoller = new GhPoller({
    database,
    ghService: ghServiceForPoller,
    notifications,
    launchFollowUp: async (context) => {
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

  // Construct updateService here but start the poll/update checks AFTER
  // createWindow() so the first `update-downloaded` callback (which opens a
  // restart dialog) can always attach to an existing parent window.
  // (audit-2026-05-17 H12)
  let updateService: UpdateService | null = null;
  if (app.isPackaged) {
    const { autoUpdater } = await import("electron-updater");
    updateService = new UpdateService({
      autoUpdater,
      dialog,
      log: (level, message, meta) => {
        console[level === "error" ? "error" : "log"](`[argmax:updater] ${message}`, meta ?? "");
      }
    });
  }

  return {
    database,
    providerSessions,
    terminals,
    mcpAuth,
    notifications,
    dockBadge,
    ghPoller,
    updateService,
    registeredChannels: registered.channels,
    dashboardDeltaCoalescer,
    publishDashboardDelta,
    broadcast
  };
}

/**
 * Build + install the native app menu. Dispatch routes `check-for-updates`
 * to the updater directly (dev/unpackaged shows an explanatory dialog),
 * everything else flows to the renderer via the `menu:command` push channel.
 */
export function installAppMenu(deps: {
  getMainWindow: () => BrowserWindow | null;
  updateService: UpdateService | null;
}): void {
  const runCheckForUpdates = (): void => {
    if (!deps.updateService) {
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
    void deps.updateService.checkOnUserRequest();
  };

  const template = buildAppMenuTemplate({
    isDev: is.dev,
    onCommand: (command: MenuCommand) => {
      if (command === "check-for-updates") {
        runCheckForUpdates();
        return;
      }
      const window = deps.getMainWindow();
      if (window && !window.isDestroyed()) {
        window.webContents.send("menu:command", command);
      }
    }
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

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

/**
 * Tear down the service graph. The order mirrors `bootstrapServices` in
 * reverse: flush pending deltas first (audit-2026-05-17 H13), then stop
 * pollers, dispose providers/terminals/MCP, then close the database.
 * Safe to call on a partial container (`Partial<ServiceContainer>`) because
 * shutdown can fire mid-boot.
 */
export async function shutdownServices(services: Partial<ServiceContainer>): Promise<void> {
  if (services.dashboardDeltaCoalescer) {
    await safeDispose("dashboardDelta.flush", () => services.dashboardDeltaCoalescer?.flushNow());
  }
  if (services.ghPoller) {
    await safeDispose("ghPoller.stop", () => services.ghPoller?.stop());
  }
  if (services.providerSessions) {
    await safeDispose("disposeAll", () => services.providerSessions?.disposeAll());
  }
  if (services.terminals) {
    await safeDispose("terminals.disposeAll", () => services.terminals?.disposeAll());
  }
  if (services.mcpAuth) {
    await safeDispose("mcpAuth.disposeAll", () => services.mcpAuth?.disposeAll());
  }
  if (services.registeredChannels) {
    for (const channel of services.registeredChannels) {
      ipcMain.removeHandler(channel);
    }
  }
  if (services.database) {
    await safeDispose("database close", () => {
      services.database?.clearPruneInterval();
      services.database?.connection.close();
    });
  }
}
