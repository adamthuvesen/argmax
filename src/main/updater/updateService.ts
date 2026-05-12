import type { MessageBoxOptions, MessageBoxReturnValue } from "electron";

/**
 * Minimum surface of electron-updater's `autoUpdater` that we actually consume.
 * Modeling it explicitly keeps the production wiring (`autoUpdater` from
 * electron-updater) interchangeable with a test stub.
 */
export interface AutoUpdaterLike {
  checkForUpdatesAndNotify(): Promise<unknown>;
  quitAndInstall(): void;
  on(event: "update-available", listener: () => void): void;
  on(event: "update-not-available", listener: () => void): void;
  on(event: "update-downloaded", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
}

export interface DialogLike {
  showMessageBox(options: MessageBoxOptions): Promise<MessageBoxReturnValue>;
}

export interface UpdateServiceDeps {
  autoUpdater: AutoUpdaterLike;
  dialog: DialogLike;
  /** Optional logger; defaults to a no-op so tests stay silent. */
  log?: (level: "info" | "warn" | "error", message: string, meta?: unknown) => void;
}

const RESTART_BUTTON_INDEX = 0;

export class UpdateService {
  private listenersWired = false;
  private restartPromptInflight = false;

  constructor(private readonly deps: UpdateServiceDeps) {}

  /**
   * Initial check fired at boot (or whenever the caller decides). Wires the
   * one-time event listeners on the first call; subsequent calls reuse them.
   */
  async runStartupCheck(): Promise<void> {
    this.ensureListeners();
    try {
      await this.deps.autoUpdater.checkForUpdatesAndNotify();
    } catch (error) {
      this.log("warn", "autoUpdater check failed", error);
    }
  }

  /**
   * User-triggered check, wired to the App menu's "Check for Updates" item.
   * Same observable behavior as `runStartupCheck` for now — left as a separate
   * method so a future iteration can surface a "no update available" toast for
   * the manual path without spamming startup.
   */
  async checkOnUserRequest(): Promise<void> {
    this.ensureListeners();
    try {
      await this.deps.autoUpdater.checkForUpdatesAndNotify();
    } catch (error) {
      this.log("warn", "user-triggered update check failed", error);
    }
  }

  private ensureListeners(): void {
    if (this.listenersWired) return;
    this.listenersWired = true;
    this.deps.autoUpdater.on("update-not-available", () => {
      this.log("info", "update-not-available");
    });
    this.deps.autoUpdater.on("update-downloaded", () => {
      void this.promptRestart();
    });
    this.deps.autoUpdater.on("error", (error) => {
      this.log("error", "autoUpdater error", error);
    });
  }

  private async promptRestart(): Promise<void> {
    if (this.restartPromptInflight) return;
    this.restartPromptInflight = true;
    try {
      const result = await this.deps.dialog.showMessageBox({
        type: "info",
        title: "Update ready",
        message: "An Argmax update is downloaded and ready to install.",
        detail: "The app will restart to apply the update.",
        buttons: ["Restart Now", "Later"],
        defaultId: RESTART_BUTTON_INDEX,
        cancelId: 1
      });
      if (result.response === RESTART_BUTTON_INDEX) {
        this.deps.autoUpdater.quitAndInstall();
      }
    } catch (error) {
      this.log("error", "restart prompt failed", error);
    } finally {
      this.restartPromptInflight = false;
    }
  }

  private log(level: "info" | "warn" | "error", message: string, meta?: unknown): void {
    this.deps.log?.(level, message, meta);
  }
}
