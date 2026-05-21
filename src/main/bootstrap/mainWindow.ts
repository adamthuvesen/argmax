import { app, BrowserWindow, nativeTheme, screen, shell } from "electron";
import { is } from "@electron-toolkit/utils";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { mark as markStartupPhase } from "../util/startupTimer.js";
import { isAllowedAppNavigation, rendererFileNavigationPrefix } from "../util/appNavigation.js";

// Theme cache (synced by the renderer via IPC) lets us match BrowserWindow's
// backgroundColor to the resolved theme *before* the renderer mounts —
// otherwise dark-mode users see ~150ms of light bg flash at cold start.
const LIGHT_BG = "#fbfbfa";
const DARK_BG = "#0e0e0c";

export function resolveStartupBackground(): string {
  let mode: "light" | "dark" | "system" = "system";
  try {
    const raw = readFileSync(join(app.getPath("userData"), "theme.json"), "utf-8");
    const parsed = JSON.parse(raw) as { mode?: unknown };
    if (parsed?.mode === "light" || parsed?.mode === "dark" || parsed?.mode === "system") {
      mode = parsed.mode;
    }
  } catch {
    /* missing cache (cold install, first launch) — default to system */
  }
  nativeTheme.themeSource = mode;
  if (mode === "dark") return DARK_BG;
  if (mode === "light") return LIGHT_BG;
  return nativeTheme.shouldUseDarkColors ? DARK_BG : LIGHT_BG;
}

export interface MainWindowOptions {
  currentDirectory: string;
  iconPath: string;
}

export async function createMainWindow(options: MainWindowOptions): Promise<BrowserWindow> {
  const rendererIndexPath = join(options.currentDirectory, "../renderer/index.html");
  // Open the window covering the primary display's work area (between the
  // menu bar and dock). We pass the work area's x/y origin so the window
  // doesn't slide behind the menu bar when centered, then call maximize()
  // after creation so the green traffic light still toggles back to a
  // smaller size.
  const workArea = screen.getPrimaryDisplay().workArea;
  const window = new BrowserWindow({
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height,
    minWidth: 900,
    minHeight: 620,
    resizable: true,
    title: "Argmax",
    icon: options.iconPath,
    backgroundColor: resolveStartupBackground(),
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
      preload: join(options.currentDirectory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  window.once("ready-to-show", () => {
    // maximize() before show() so the window appears already covering the
    // work area with no flash. Belt-and-braces alongside the explicit
    // workArea bounds above — handles edge cases like dock auto-hide
    // changing the available height between BrowserWindow construction and
    // first paint.
    window.maximize();
    window.show();
    markStartupPhase("window.ready-to-show");
  });

  // Block any window.open / target=_blank attempts. External links should
  // route through `shell.openExternal` when we choose to support them.
  window.webContents.setWindowOpenHandler(({ url }) => {
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
  window.webContents.on("will-navigate", (event, url) => {
    const allowed = isAllowedAppNavigation(url, loadedOrigin);
    if (!allowed) {
      event.preventDefault();
    }
  });

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else if (is.dev) {
    await window.loadURL("http://127.0.0.1:5173");
  } else {
    await window.loadFile(rendererIndexPath);
  }

  return window;
}
